import { budgetSecondsFor, config, PROVIDER_IDS, type ProviderId, runtime, usdPerSecondFor } from './config.js';
import { getProvider } from './providers/registry.js';
import { dbConfigured, listUsers, paymentsSince, type PaymentRow } from './db.js';
import { DECART_USD_PER_CREDIT, decartBalance } from './decart-account.js';
import type { Ledger, LedgerEntry } from './ledger.js';

/**
 * Daily aggregation over the ledger.
 *
 * Every figure the dashboard shows is derived here rather than in the browser,
 * so the numbers on a chart and the numbers in the table cannot drift apart.
 */

export type DayPoint = {
  date: string;
  sessions: number;
  billedSeconds: number;
  credits: number;
  spentUsd: number;
  earnedUsd: number;
};

function isoDay(value: string): string {
  return value.slice(0, 10);
}

/** Provider credits, the provider's own billing unit: Decart sells them at $0.01 each. */
function creditsFor(provider: ProviderId, usd: number): number {
  const perCredit = provider === 'decart' ? DECART_USD_PER_CREDIT : 0.005;
  return Math.round(usd / perCredit);
}

/** Midnight (local) at the start of the first day a `days`-long window shows. */
export function windowStart(days: number, now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

/** A continuous day axis — gaps must render as zero, not as missing points. */
export function dailySeries(entries: LedgerEntry[], days: number, payments: PaymentRow[] = []): DayPoint[] {
  const buckets = new Map<string, DayPoint>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, { date: key, sessions: 0, billedSeconds: 0, credits: 0, spentUsd: 0, earnedUsd: 0 });
  }

  for (const entry of entries) {
    const key = isoDay(entry.endedAt);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the window
    // A session that never billed is not a session anyone ran.
    if (entry.billedSeconds > 0) bucket.sessions += 1;
    bucket.billedSeconds += entry.billedSeconds;
    bucket.spentUsd += entry.usd;
    bucket.credits += creditsFor(entry.provider, entry.usd);
  }

  for (const payment of payments) {
    // Only dollars go on a dollar chart. A plan priced in another currency is
    // counted in the payments table but not converted at a guessed rate.
    if (payment.currency !== 'usd') continue;
    const bucket = buckets.get(isoDay(payment.created_at));
    if (bucket) bucket.earnedUsd += payment.amount_cents / 100;
  }

  return [...buckets.values()].map((point) => ({
    ...point,
    spentUsd: Number(point.spentUsd.toFixed(4)),
    earnedUsd: Number(point.earnedUsd.toFixed(2)),
  }));
}

export async function overview(ledger: Ledger, days: number, options: { freshBalance?: boolean } = {}) {
  const allEntries = await ledger.entries();
  // Every total covers the same days the charts show. They used to add up the
  // whole ledger, so a tile and the chart beside it disagreed.
  const since = windowStart(days);
  const entries = allEntries.filter((entry) => Date.parse(entry.endedAt) >= since.getTime());
  // Revenue is a nice-to-have on this screen; a database hiccup must not
  // blank the spend figures the operator actually watches.
  const payments = dbConfigured() ? await paymentsSince(since).catch(() => [] as PaymentRow[]) : [];
  const series = dailySeries(entries, days, payments);
  const billed = entries.filter((entry) => entry.billedSeconds > 0);
  const withTtff = billed.filter((entry) => typeof entry.timeToFirstFrameMs === 'number');

  const totals = {
    sessions: billed.length,
    attempts: entries.length,
    billedSeconds: billed.reduce((sum, entry) => sum + entry.billedSeconds, 0),
    spentUsd: Number(entries.reduce((sum, entry) => sum + entry.usd, 0).toFixed(4)),
    earnedUsd: Number(series.reduce((sum, day) => sum + day.earnedUsd, 0).toFixed(2)),
    purchases: payments.length,
    credits: entries.reduce((sum, entry) => sum + creditsFor(entry.provider, entry.usd), 0),
    averageTtffMs:
      withTtff.length === 0
        ? null
        : Math.round(withTtff.reduce((sum, entry) => sum + (entry.timeToFirstFrameMs ?? 0), 0) / withTtff.length),
    // Attempts that never billed are the ones worth noticing: a refusal or a
    // failed start costs nothing but means someone did not get a try-on.
    failedAttempts: entries.filter((entry) => entry.billedSeconds === 0).length,
  };

  // The spending cap counts every second ever billed, so this part reads the whole ledger.
  const providers = PROVIDER_IDS.map((id) => {
    const rows = allEntries.filter((entry) => entry.provider === id);
    const spent = rows.reduce((sum, entry) => sum + entry.usd, 0);
    const seconds = rows.reduce((sum, entry) => sum + entry.billedSeconds, 0);
    const budget = budgetSecondsFor(id);
    const provider = getProvider(id);
    const status = provider.status();
    return {
      id,
      displayName: provider.displayName,
      model: provider.model,
      minSessionSeconds: provider.minSessionSeconds,
      selectable: status.configured && status.implemented,
      statusDetail: status.detail,
      sessions: rows.filter((entry) => entry.billedSeconds > 0).length,
      billedSeconds: seconds,
      spentUsd: Number(spent.toFixed(4)),
      budgetSeconds: budget,
      budgetUsd: Number((budget * usdPerSecondFor(id)).toFixed(2)),
      remainingSeconds: Math.max(0, budget - seconds),
      usdPerSecond: usdPerSecondFor(id),
    };
  });

  return {
    days,
    since: since.toISOString(),
    totals,
    account: await accountHealth(providers.find((p) => p.id === 'decart')!, options.freshBalance === true),
    series,
    providers,
    // The settings tab drives these, so they travel with the data it renders.
    activeProvider: runtime.activeProvider,
    killSwitch: runtime.killSwitch,
    session: { ...config.session, sessionSeconds: runtime.sessionSeconds },
    recent: await ledger.recent(200),
  };
}

/**
 * Can the Decart balance honour what customers have been sold?
 *
 * Every credit a customer holds is a promise of one session, and a session
 * costs Decart up to `sessionSeconds` of stream. Priced at the full length,
 * because that is what a customer is entitled to use.
 */
async function accountHealth(decart: { remainingSeconds: number; budgetSeconds: number; usdPerSecond: number }, fresh: boolean) {
  const sessionSeconds = runtime.sessionSeconds;
  const creditsPerSecond = decart.usdPerSecond / DECART_USD_PER_CREDIT;
  const creditsPerSession = creditsPerSecond * sessionSeconds;

  const balance = await decartBalance({ fresh });

  let customers: { accounts: number; holding: number; outstanding: number; adminCredits: number } | null = null;
  if (dbConfigured()) {
    try {
      const users = await listUsers(10_000);
      const buyers = users.filter((user) => user.role !== 'admin');
      customers = {
        accounts: buyers.length,
        holding: buyers.filter((user) => user.credits > 0).length,
        outstanding: buyers.reduce((sum, user) => sum + Math.max(0, user.credits), 0),
        // Admins try on free, so their balance is not a promise to anyone.
        adminCredits: users.filter((user) => user.role === 'admin').reduce((sum, user) => sum + Math.max(0, user.credits), 0),
      };
    } catch {
      customers = null;
    }
  }

  const neededCredits = customers ? Math.ceil(customers.outstanding * creditsPerSession) : null;
  const balanceCredits = balance.status === 'live' ? balance.credits : null;
  const capSessions = sessionSeconds > 0 ? Math.floor(decart.remainingSeconds / sessionSeconds) : 0;
  const balanceSessions = balanceCredits === null ? null : Math.floor(balanceCredits / creditsPerSession);

  return {
    decart: balance,
    rate: {
      sessionSeconds,
      usdPerSecond: decart.usdPerSecond,
      creditsPerSecond,
      creditsPerSession,
      usdPerSession: Number((creditsPerSession * DECART_USD_PER_CREDIT).toFixed(4)),
    },
    customers,
    needed: neededCredits === null ? null : { credits: neededCredits, usd: Number((neededCredits * DECART_USD_PER_CREDIT).toFixed(2)) },
    // Positive: the balance covers every outstanding customer credit with this much to spare.
    coverage: neededCredits === null || balanceCredits === null
      ? null
      : { credits: balanceCredits - neededCredits, usd: Number(((balanceCredits - neededCredits) * DECART_USD_PER_CREDIT).toFixed(2)) },
    runway: {
      /** Full-length sessions the Decart balance pays for. */
      balanceSessions,
      /** Full-length sessions the spending cap still allows. */
      capSessions,
      capSecondsLeft: decart.remainingSeconds,
      capSeconds: decart.budgetSeconds,
      /** Whichever runs out first stops new sessions. */
      sessions: balanceSessions === null ? capSessions : Math.min(balanceSessions, capSessions),
    },
  };
}
