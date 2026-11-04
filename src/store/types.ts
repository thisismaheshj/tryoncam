import type { ProviderId } from '../config.js';
import type { LedgerEntry } from '../ledger.js';
import type { Settings } from '../settings.js';

/**
 * Everything that must outlive a single request.
 *
 * The local build keeps this on disk and in memory, which is correct for one
 * long-lived process. Serverless has neither: no shared memory between
 * invocations and no persistent filesystem, so the ledger would vanish and —
 * far worse — the concurrency counter and budget reservations would silently
 * stop working, which is the whole thing preventing overspend.
 */

export type Lease = {
  sessionId: string;
  provider: ProviderId;
  model: string;
  /** Worst case this session may bill, held against the budget until released. */
  reservedSeconds: number;
  extensions: number;
  garmentUrl: string | null;
  user: { email: string; name: string } | null;
  createdAt: number;
  startedAt: number | null;
  expiresAt: number;
};

export type ReserveRequest = {
  lease: Lease;
  maxConcurrent: number;
  /** Ceiling for this provider, in billed seconds. */
  budgetSeconds: number;
  /** Already spent, from the ledger. */
  spentSeconds: number;
};

export type ReserveResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: 'concurrency_limit' | 'budget_exhausted'; detail: string };

export interface Store {
  readonly kind: 'file' | 'redis';

  settings(): Promise<Settings | null>;
  saveSettings(settings: Settings): Promise<void>;

  /**
   * Operator overrides of environment values (keys, budgets, limits). Kept
   * apart from settings because settings are served to the dashboard whole,
   * and secrets must never ride along — even encrypted.
   */
  overrides(): Promise<unknown>;
  saveOverrides(value: unknown): Promise<void>;

  appendEntry(entry: LedgerEntry): Promise<void>;
  entries(): Promise<LedgerEntry[]>;

  /**
   * Checks concurrency and budget, and records the lease — atomically.
   *
   * Two requests arriving together must not both be told there is room. On one
   * process that is guaranteed by the event loop; across instances it needs
   * the store to arbitrate, which is why this is one call rather than a read
   * followed by a write.
   */
  reserve(request: ReserveRequest): Promise<ReserveResult>;

  /** Returns the lease so the caller can bill it; null if already gone. */
  release(sessionId: string): Promise<Lease | null>;
  updateLease(sessionId: string, patch: Partial<Lease>): Promise<Lease | null>;
  activeLeases(): Promise<Lease[]>;
  /** Removes expired leases and returns them, so they can be billed as aborted. */
  sweepExpired(now: number): Promise<Lease[]>;
}
