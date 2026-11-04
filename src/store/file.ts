import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../ledger.js';
import type { Settings } from '../settings.js';
import type { Lease, ReserveRequest, ReserveResult, Store } from './types.js';

/**
 * Local development: files on disk, leases in memory.
 *
 * Correct for a single long-lived process, which is what `npm run dev` is.
 * The atomicity `reserve` promises comes free here — Node runs one request at
 * a time, so nothing can interleave between the check and the write.
 */
export class FileStore implements Store {
  readonly kind = 'file' as const;
  private readonly leases = new Map<string, Lease>();

  /**
   * `now` is injectable so tests can drive expiry deterministically. Without
   * it the store expires against the wall clock while the guard reasons about
   * a simulated one, and every lease looks stale the moment it is created.
   */
  constructor(
    private readonly ledgerPath: string,
    private readonly settingsPath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private ensureDir(file: string): void {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async settings(): Promise<Settings | null> {
    if (!existsSync(this.settingsPath)) return null;
    try {
      return JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Settings;
    } catch {
      // A half-written file must not take the app down.
      return null;
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.ensureDir(this.settingsPath);
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  /** Beside the settings file, so a test's temp directory holds both. */
  private get overridesPath(): string {
    return path.join(path.dirname(this.settingsPath), 'overrides.json');
  }

  async overrides(): Promise<unknown> {
    if (!existsSync(this.overridesPath)) return null;
    try {
      return JSON.parse(readFileSync(this.overridesPath, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  async saveOverrides(value: unknown): Promise<void> {
    this.ensureDir(this.overridesPath);
    writeFileSync(this.overridesPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async appendEntry(entry: LedgerEntry): Promise<void> {
    this.ensureDir(this.ledgerPath);
    appendFileSync(this.ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async entries(): Promise<LedgerEntry[]> {
    if (!existsSync(this.ledgerPath)) return [];
    const out: LedgerEntry[] = [];
    for (const line of readFileSync(this.ledgerPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as LedgerEntry;
        if (typeof parsed?.billedSeconds === 'number') out.push(parsed);
      } catch {
        // Skip an unparseable line rather than losing the whole ledger.
      }
    }
    return out;
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    const { lease, maxConcurrent, budgetSeconds, spentSeconds } = request;
    this.expire(this.now());

    if (this.leases.size >= maxConcurrent) {
      return {
        ok: false,
        reason: 'concurrency_limit',
        detail: `${this.leases.size} of ${maxConcurrent} concurrent sessions already active.`,
      };
    }

    let reserved = 0;
    for (const held of this.leases.values()) {
      if (held.provider === lease.provider) reserved += held.reservedSeconds;
    }
    const remaining = Math.max(0, budgetSeconds - spentSeconds - reserved);
    if (lease.reservedSeconds > remaining) {
      return {
        ok: false,
        reason: 'budget_exhausted',
        detail: `Needs ${lease.reservedSeconds}s but only ${remaining}s of the ${budgetSeconds}s ${lease.provider} budget remain.`,
      };
    }

    this.leases.set(lease.sessionId, lease);
    return { ok: true, lease };
  }

  async release(sessionId: string): Promise<Lease | null> {
    const lease = this.leases.get(sessionId) ?? null;
    this.leases.delete(sessionId);
    return lease;
  }

  async updateLease(sessionId: string, patch: Partial<Lease>): Promise<Lease | null> {
    const lease = this.leases.get(sessionId);
    if (!lease) return null;
    const next = { ...lease, ...patch };
    this.leases.set(sessionId, next);
    return next;
  }

  async activeLeases(): Promise<Lease[]> {
    this.expire(this.now());
    return [...this.leases.values()];
  }

  async sweepExpired(now: number): Promise<Lease[]> {
    return this.expire(now);
  }

  private expire(now: number): Lease[] {
    const gone: Lease[] = [];
    for (const lease of [...this.leases.values()]) {
      if (now >= lease.expiresAt) {
        this.leases.delete(lease.sessionId);
        gone.push(lease);
      }
    }
    return gone;
  }
}
