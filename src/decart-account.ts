import { config } from './config.js';

/**
 * The credit balance of the Decart account, read from Decart itself.
 *
 * Decart's public API has no balance or usage endpoint (its OpenAPI lists only
 * generation, files, tokens and a concurrency quota). The balance shown on
 * platform.decart.ai/billing comes from that site's own route,
 * /api/user/billing, which answers only to a signed-in browser session. So the
 * operator pastes that session's Cookie header into the Environment tab
 * (DECART_SESSION_COOKIE, stored encrypted), and this makes the same one
 * read-only request the billing page makes. It never calls anything that
 * spends, buys or changes the account.
 *
 * Decart sells credits at $0.01 each (1,000 for $10), and a Lucy VTON second
 * costs $0.02, so a second of try-on is 2 credits.
 */

export const DECART_USD_PER_CREDIT = 0.01;
const BILLING_URL = 'https://platform.decart.ai/api/user/billing';

export type DecartBalance =
  | { status: 'live'; credits: number; usd: number; fetchedAt: string }
  | { status: 'not_connected' }
  | { status: 'expired' | 'error'; message: string; fetchedAt: string };

/** A pasted Cookie header, cleaned of the "Cookie:" prefix and stray line breaks. */
export function cleanCookie(value: string): string {
  return String(value ?? '').replace(/^\s*cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
}

/** One request to Decart's billing route. Throws with a reason a person can act on. */
export async function readDecartCredits(cookie: string): Promise<number> {
  const header = cleanCookie(cookie);
  if (!header || !header.includes('=')) throw new DecartSessionError('That is not a Cookie header (it should contain name=value pairs).', 'error');
  const response = await fetch(BILLING_URL, {
    headers: { Cookie: header, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new DecartSessionError('Decart no longer accepts this session. Sign in at platform.decart.ai and paste a fresh Cookie header.', 'expired');
  }
  if (!response.ok) throw new DecartSessionError(`Decart answered HTTP ${response.status}.`, 'error');
  const body = (await response.json().catch(() => null)) as { currentCredits?: unknown } | null;
  const credits = Number(body?.currentCredits);
  if (!body || !Number.isFinite(credits)) {
    throw new DecartSessionError('Decart answered, but without a credit balance. Its billing page may have changed.', 'error');
  }
  return credits;
}

export class DecartSessionError extends Error {
  constructor(message: string, readonly kind: 'expired' | 'error') {
    super(message);
  }
}

let cache: { cookie: string; at: number; value: DecartBalance } | null = null;
const CACHE_MS = 60_000;

/** The live balance, cached for a minute so a dashboard refresh does not hammer Decart. */
export async function decartBalance(options: { fresh?: boolean } = {}): Promise<DecartBalance> {
  const cookie = config.decart.sessionCookie;
  if (!cookie) return { status: 'not_connected' };
  if (!options.fresh && cache && cache.cookie === cookie && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value: DecartBalance;
  const fetchedAt = new Date().toISOString();
  try {
    const credits = await readDecartCredits(cookie);
    value = { status: 'live', credits, usd: Number((credits * DECART_USD_PER_CREDIT).toFixed(2)), fetchedAt };
  } catch (error) {
    const kind = error instanceof DecartSessionError ? error.kind : 'error';
    const message = error instanceof Error ? error.message : String(error);
    value = { status: kind, message: kind === 'error' && !(error instanceof DecartSessionError) ? `Could not reach Decart: ${message}` : message, fetchedAt };
  }
  cache = { cookie, at: Date.now(), value };
  return value;
}

/** For tests, and when the stored session changes. */
export function resetDecartBalanceCache(): void {
  cache = null;
}
