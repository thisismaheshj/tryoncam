import { type ProviderId, usdPerSecondFor } from './config.js';
import { getStore } from './store/index.js';

/**
 * One record per finished session.
 *
 * Only entries with a numeric `billedSeconds` count against the budget, so a
 * session that never started costs nothing. `estimated: true` marks a figure
 * derived from our own clock because the provider gave us none — those are
 * still counted, because an unverified second spent real money.
 */
export type LedgerEntry = {
  id: string;
  provider: ProviderId;
  model: string;
  status: 'completed' | 'aborted' | 'failed';
  startedAt: string | null;
  endedAt: string;
  grantedSeconds: number;
  billedSeconds: number;
  estimated: boolean;
  usd: number;
  garmentUrl: string | null;
  /** Who ran it. Null on entries written before sign-in was configured. */
  user: { email: string; name: string } | null;
  timeToFirstFrameMs: number | null;
  note: string | null;
};

export class Ledger {
  async append(entry: LedgerEntry): Promise<void> {
    await getStore().appendEntry(entry);
  }

  async entries(): Promise<LedgerEntry[]> {
    return getStore().entries();
  }

  async spentSeconds(provider: ProviderId): Promise<number> {
    const rows = await this.entries();
    return rows.filter((e) => e.provider === provider).reduce((total, e) => total + e.billedSeconds, 0);
  }

  async spentUsd(provider: ProviderId): Promise<number> {
    const rows = await this.entries();
    return rows.filter((e) => e.provider === provider).reduce((total, e) => total + e.usd, 0);
  }

  /** Everything the dashboard needs for one provider's row. */
  async summary(provider: ProviderId) {
    const rows = (await this.entries()).filter((e) => e.provider === provider);
    const withTtff = rows.filter((r) => typeof r.timeToFirstFrameMs === 'number');
    return {
      sessions: rows.length,
      billedSeconds: rows.reduce((t, r) => t + r.billedSeconds, 0),
      spentUsd: rows.reduce((t, r) => t + r.usd, 0),
      usdPerSecond: usdPerSecondFor(provider),
      averageTimeToFirstFrameMs:
        withTtff.length === 0
          ? null
          : Math.round(withTtff.reduce((t, r) => t + (r.timeToFirstFrameMs ?? 0), 0) / withTtff.length),
    };
  }

  async recent(limit = 25): Promise<LedgerEntry[]> {
    return (await this.entries()).slice(-limit).reverse();
  }
}

export function usdFor(provider: ProviderId, seconds: number): number {
  return Number((seconds * usdPerSecondFor(provider)).toFixed(4));
}
