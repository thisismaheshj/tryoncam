import { budgetSecondsFor, config, type ProviderId, runtime } from './config.js';
import { Ledger, type LedgerEntry, usdFor } from './ledger.js';
import { getStore } from './store/index.js';
import type { Lease } from './store/types.js';

export type { Lease } from './store/types.js';
export type SessionUser = { email: string; name: string };

export type RefusalReason =
  | 'kill_switch'
  | 'provider_unconfigured'
  | 'concurrency_limit'
  | 'budget_exhausted'
  | 'session_unknown'
  | 'extension_limit';

export type GuardDecision = { ok: true } | { ok: false; reason: RefusalReason; detail: string };

export type ReleaseInput = {
  billedSeconds?: number;
  estimated?: boolean;
  status?: LedgerEntry['status'];
  timeToFirstFrameMs?: number | null;
  note?: string | null;
};

/**
 * The only authority on whether a session may start.
 *
 * The important idea is **reservation**: at mint time we cannot know what a
 * session will bill, so its worst case is held against the budget immediately
 * and reconciled to the real figure on release. Without that, N simultaneous
 * requests each see an empty budget and all pass.
 *
 * The check and the write happen inside the store so they are atomic — on one
 * process that is free, across serverless instances it is not.
 */
export class SessionGuard {
  constructor(
    private readonly ledger: Ledger = new Ledger(),
    private readonly now: () => number = () => Date.now(),
    /**
     * Called once for every session that ends, however it ended. Credits hang
     * off this: a session that never started gets its credit back, and that
     * has to happen on the timeout path as surely as on a clean /end.
     */
    private readonly onReleased: (entry: LedgerEntry) => Promise<void> = async () => {},
  ) {}

  private async finish(entry: LedgerEntry): Promise<void> {
    await this.ledger.append(entry);
    try {
      await this.onReleased(entry);
    } catch (error) {
      // The ledger line is what the budget depends on and it is written; a
      // failed follow-up must not turn a clean release into an error.
      console.error(`[guard] after-release hook failed for ${entry.id}:`, error);
    }
  }

  private providerConfigured(provider: ProviderId): boolean {
    return provider === 'decart' ? config.decart.apiKey !== '' : config.vidu.apiKey !== '';
  }

  async reservedSeconds(provider: ProviderId): Promise<number> {
    const leases = await getStore().activeLeases();
    return leases.filter((l) => l.provider === provider).reduce((t, l) => t + l.reservedSeconds, 0);
  }

  async activeCount(): Promise<number> {
    return (await getStore().activeLeases()).length;
  }

  async activeSessions(): Promise<Lease[]> {
    return getStore().activeLeases();
  }

  async remainingSeconds(provider: ProviderId): Promise<number> {
    const [spent, reserved] = await Promise.all([
      this.ledger.spentSeconds(provider),
      this.reservedSeconds(provider),
    ]);
    return Math.max(0, budgetSecondsFor(provider) - spent - reserved);
  }

  /**
   * The cheap refusals — kill switch and unconfigured provider — which need no
   * store round trip and must be answered before anything else happens.
   */
  precheck(provider: ProviderId): GuardDecision {
    if (runtime.killSwitch) {
      return { ok: false, reason: 'kill_switch', detail: 'KILL_SWITCH is on; session minting is disabled.' };
    }
    if (!this.providerConfigured(provider)) {
      return {
        ok: false,
        reason: 'provider_unconfigured',
        detail: `No API key configured for ${provider}. Set it in .env and restart.`,
      };
    }
    return { ok: true };
  }

  /** Atomically checks concurrency and budget, then records the lease. */
  async reserve(input: {
    sessionId: string;
    provider: ProviderId;
    model: string;
    seconds: number;
    garmentUrl: string | null;
    user?: SessionUser | null;
  }): Promise<GuardDecision & { lease?: Lease }> {
    const cheap = this.precheck(input.provider);
    if (!cheap.ok) return cheap;

    // Expire through the guard first. The store also drops stale leases inside
    // its reserve, but silently — no ledger line, no refund. On a long-lived
    // process the interval sweep got there first; on serverless nothing runs
    // between requests, so this is the only sweep there is.
    await this.sweep();

    const now = this.now();
    const lease: Lease = {
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      reservedSeconds: input.seconds,
      extensions: 0,
      garmentUrl: input.garmentUrl,
      user: input.user ?? null,
      createdAt: now,
      startedAt: null,
      // Connect window plus the session itself, plus slack for teardown.
      expiresAt: now + (config.session.connectWindowSeconds + input.seconds + 30) * 1000,
    };

    const result = await getStore().reserve({
      lease,
      maxConcurrent: config.session.maxConcurrent,
      budgetSeconds: budgetSecondsFor(input.provider),
      spentSeconds: await this.ledger.spentSeconds(input.provider),
    });

    return result.ok ? { ok: true, lease: result.lease } : { ok: false, reason: result.reason, detail: result.detail };
  }

  /** Client reports the stream went live — the billing clock has started. */
  async markStarted(sessionId: string): Promise<GuardDecision> {
    const store = getStore();
    const leases = await store.activeLeases();
    const lease = leases.find((l) => l.sessionId === sessionId);
    if (!lease) return { ok: false, reason: 'session_unknown', detail: `No active session ${sessionId}.` };
    if (lease.startedAt !== null) return { ok: true };

    const startedAt = this.now();
    await store.updateLease(sessionId, {
      startedAt,
      // From here only the granted duration matters.
      expiresAt: startedAt + (lease.reservedSeconds + 30) * 1000,
    });
    return { ok: true };
  }

  /** Grants more seconds to a live session, budget permitting. */
  async extend(sessionId: string, seconds: number): Promise<GuardDecision & { totalSeconds?: number }> {
    const store = getStore();
    const lease = (await store.activeLeases()).find((l) => l.sessionId === sessionId);
    if (!lease) return { ok: false, reason: 'session_unknown', detail: `No active session ${sessionId}.` };
    if (lease.extensions >= config.session.maxExtensions) {
      return {
        ok: false,
        reason: 'extension_limit',
        detail: `Already extended ${lease.extensions} times (max ${config.session.maxExtensions}).`,
      };
    }
    if (runtime.killSwitch) {
      return { ok: false, reason: 'kill_switch', detail: 'KILL_SWITCH is on; refusing to extend.' };
    }

    const remaining = await this.remainingSeconds(lease.provider);
    if (seconds > remaining) {
      return {
        ok: false,
        reason: 'budget_exhausted',
        detail: `Only ${remaining}s remain; cannot add ${seconds}s.`,
      };
    }

    const next = await store.updateLease(sessionId, {
      reservedSeconds: lease.reservedSeconds + seconds,
      extensions: lease.extensions + 1,
      expiresAt: lease.expiresAt + seconds * 1000,
    });
    return { ok: true, totalSeconds: next?.reservedSeconds };
  }

  /**
   * Ends a session, writes the ledger line, and frees the reservation and the
   * concurrency slot. Safe to call twice — the second call is a no-op.
   */
  async release(sessionId: string, input: ReleaseInput = {}): Promise<LedgerEntry | null> {
    const lease = await getStore().release(sessionId);
    if (!lease) return null;

    // No provider figure? Fall back to our own clock; with neither, assume the
    // worst case granted. Never assume zero.
    const wallClockSeconds =
      lease.startedAt === null ? 0 : Math.ceil((this.now() - lease.startedAt) / 1000);
    const billedSeconds =
      typeof input.billedSeconds === 'number'
        ? input.billedSeconds
        : Math.min(lease.reservedSeconds, wallClockSeconds);

    const entry = this.toEntry(lease, {
      status: input.status ?? 'completed',
      billedSeconds,
      estimated: input.estimated ?? typeof input.billedSeconds !== 'number',
      timeToFirstFrameMs: input.timeToFirstFrameMs ?? null,
      note: input.note ?? null,
    });
    await this.finish(entry);
    return entry;
  }

  /**
   * Reclaims leases whose owner vanished — a closed window, a crashed tab.
   *
   * One that never started is charged nothing. One that did is charged the
   * full grant, because we cannot prove it stopped earlier and a budget guard
   * that guesses low is worse than useless.
   */
  async sweep(): Promise<LedgerEntry[]> {
    const expired = await getStore().sweepExpired(this.now());
    const written: LedgerEntry[] = [];
    for (const lease of expired) {
      const neverStarted = lease.startedAt === null;
      const entry = this.toEntry(lease, {
        status: 'aborted',
        billedSeconds: neverStarted ? 0 : lease.reservedSeconds,
        estimated: true,
        timeToFirstFrameMs: null,
        note: neverStarted
          ? 'Lease expired before the client connected; nothing billed.'
          : 'Lease expired while live; charged the full grant as a worst case.',
      });
      await this.finish(entry);
      written.push(entry);
    }
    return written;
  }

  private toEntry(
    lease: Lease,
    fields: Pick<LedgerEntry, 'status' | 'billedSeconds' | 'estimated' | 'timeToFirstFrameMs' | 'note'>,
  ): LedgerEntry {
    return {
      id: lease.sessionId,
      provider: lease.provider,
      model: lease.model,
      startedAt: lease.startedAt === null ? null : new Date(lease.startedAt).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      grantedSeconds: lease.reservedSeconds,
      usd: usdFor(lease.provider, fields.billedSeconds),
      garmentUrl: lease.garmentUrl,
      user: lease.user,
      ...fields,
    };
  }
}
