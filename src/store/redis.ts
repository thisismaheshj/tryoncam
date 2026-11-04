import type { LedgerEntry } from '../ledger.js';
import type { Settings } from '../settings.js';
import type { Lease, ReserveRequest, ReserveResult, Store } from './types.js';

/**
 * Upstash Redis over its REST API.
 *
 * REST rather than a client library because serverless functions cannot hold a
 * TCP connection between invocations, and this needs no dependency at all —
 * every command is one HTTPS POST.
 */

const K = {
  settings: 'vton:settings',
  overrides: 'vton:overrides',
  ledger: 'vton:ledger',
  leases: 'vton:leases',
  leaseExpiry: 'vton:leases:expiry',
};

/**
 * Check-and-reserve in one round trip.
 *
 * Split into a read then a write, two instances handling simultaneous requests
 * would both see room and both admit a session — the exact overspend the
 * budget exists to prevent. Redis runs a script atomically, so the decision
 * and the record cannot be interleaved.
 */
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local maxConcurrent = tonumber(ARGV[2])
local budget = tonumber(ARGV[3])
local spent = tonumber(ARGV[4])
local provider = ARGV[5]
local seconds = tonumber(ARGV[6])
local sessionId = ARGV[7]
local payload = ARGV[8]
local expiresAt = tonumber(ARGV[9])

local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, id in ipairs(stale) do
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end

local ids = redis.call('ZRANGE', KEYS[2], 0, -1)
if #ids >= maxConcurrent then
  return cjson.encode({ok = false, reason = 'concurrency_limit', count = #ids})
end

local reserved = 0
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local lease = cjson.decode(raw)
    if lease.provider == provider then
      reserved = reserved + lease.reservedSeconds
    end
  end
end

local remaining = budget - spent - reserved
if remaining < 0 then remaining = 0 end
if seconds > remaining then
  return cjson.encode({ok = false, reason = 'budget_exhausted', remaining = remaining})
end

redis.call('HSET', KEYS[1], sessionId, payload)
redis.call('ZADD', KEYS[2], expiresAt, sessionId)
return cjson.encode({ok = true})
`;

/** Expiring and returning stale leases, so the caller can bill them as aborted. */
const SWEEP_LUA = `
local now = tonumber(ARGV[1])
local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
local out = {}
for _, id in ipairs(stale) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then table.insert(out, raw) end
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return out
`;

export class RedisStore implements Store {
  readonly kind = 'redis' as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command<T>(args: (string | number)[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || body.error) {
      throw new Error(`Redis ${String(args[0])} failed: ${body.error ?? response.status}`);
    }
    return body.result as T;
  }

  async settings(): Promise<Settings | null> {
    const raw = await this.command<string | null>(['GET', K.settings]);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Settings;
    } catch {
      return null;
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.command(['SET', K.settings, JSON.stringify(settings)]);
  }

  async overrides(): Promise<unknown> {
    const raw = await this.command<string | null>(['GET', K.overrides]);
    return raw ? (JSON.parse(raw) as unknown) : null;
  }

  async saveOverrides(value: unknown): Promise<void> {
    await this.command(['SET', K.overrides, JSON.stringify(value)]);
  }

  async appendEntry(entry: LedgerEntry): Promise<void> {
    await this.command(['RPUSH', K.ledger, JSON.stringify(entry)]);
  }

  async entries(): Promise<LedgerEntry[]> {
    const rows = await this.command<string[]>(['LRANGE', K.ledger, 0, -1]);
    const out: LedgerEntry[] = [];
    for (const row of rows ?? []) {
      try {
        const parsed = JSON.parse(row) as LedgerEntry;
        if (typeof parsed?.billedSeconds === 'number') out.push(parsed);
      } catch {
        // Skip a corrupt row rather than losing the ledger.
      }
    }
    return out;
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    const { lease, maxConcurrent, budgetSeconds, spentSeconds } = request;
    const raw = await this.command<string>([
      'EVAL', RESERVE_LUA, 2, K.leases, K.leaseExpiry,
      Date.now(), maxConcurrent, budgetSeconds, spentSeconds,
      lease.provider, lease.reservedSeconds, lease.sessionId,
      JSON.stringify(lease), lease.expiresAt,
    ]);

    const verdict = JSON.parse(raw) as { ok: boolean; reason?: string; count?: number; remaining?: number };
    if (verdict.ok) return { ok: true, lease };
    if (verdict.reason === 'concurrency_limit') {
      return {
        ok: false,
        reason: 'concurrency_limit',
        detail: `${verdict.count} of ${maxConcurrent} concurrent sessions already active.`,
      };
    }
    return {
      ok: false,
      reason: 'budget_exhausted',
      detail: `Needs ${lease.reservedSeconds}s but only ${verdict.remaining}s of the ${budgetSeconds}s ${lease.provider} budget remain.`,
    };
  }

  async release(sessionId: string): Promise<Lease | null> {
    const raw = await this.command<string | null>(['HGET', K.leases, sessionId]);
    await this.command(['HDEL', K.leases, sessionId]);
    await this.command(['ZREM', K.leaseExpiry, sessionId]);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Lease;
    } catch {
      return null;
    }
  }

  async updateLease(sessionId: string, patch: Partial<Lease>): Promise<Lease | null> {
    const raw = await this.command<string | null>(['HGET', K.leases, sessionId]);
    if (!raw) return null;
    const next = { ...(JSON.parse(raw) as Lease), ...patch };
    await this.command(['HSET', K.leases, sessionId, JSON.stringify(next)]);
    if (patch.expiresAt) await this.command(['ZADD', K.leaseExpiry, next.expiresAt, sessionId]);
    return next;
  }

  async activeLeases(): Promise<Lease[]> {
    const rows = await this.command<string[]>(['HVALS', K.leases]);
    const out: Lease[] = [];
    for (const row of rows ?? []) {
      try {
        out.push(JSON.parse(row) as Lease);
      } catch {
        // Skip.
      }
    }
    return out;
  }

  async sweepExpired(now: number): Promise<Lease[]> {
    const rows = await this.command<string[]>(['EVAL', SWEEP_LUA, 2, K.leases, K.leaseExpiry, now]);
    const out: Lease[] = [];
    for (const row of rows ?? []) {
      try {
        out.push(JSON.parse(row) as Lease);
      } catch {
        // Skip.
      }
    }
    return out;
  }
}
