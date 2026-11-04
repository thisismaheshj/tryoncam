import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader. Real env vars always win, so you can override any
 * setting on the command line without editing the file.
 */
function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]!] !== undefined) continue;
    const raw = match[2]!.trim();
    process.env[match[1]!] = /^(".*"|'.*')$/.test(raw) ? raw.slice(1, -1) : raw;
  }
}

// Tests set this so they never pick up the developer's real .env — a suite
// whose result depends on local secrets is worse than no suite.
if (process.env.VTON_SKIP_DOTENV !== '1') {
  loadDotEnv(path.resolve(process.cwd(), '.env'));
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}".`);
  }
  return parsed;
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name);
  if (raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

export type ProviderId = 'decart' | 'vidu';

export const PROVIDER_IDS: ProviderId[] = ['decart', 'vidu'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

export const config = {
  port: num('PORT', 8787),

  session: {
    maxSeconds: num('MAX_SESSION_SECONDS', 15),
    extensionSeconds: num('EXTENSION_SECONDS', 15),
    maxExtensions: num('MAX_SESSION_EXTENSIONS', 3),
    maxConcurrent: num('MAX_CONCURRENT', 2),
    connectWindowSeconds: num('CONNECT_WINDOW_SECONDS', 45),
  },

  decart: {
    apiKey: str('DECART_API_KEY'),
    baseUrl: str('DECART_BASE_URL', 'https://api.decart.ai'),
    // Anywear pins the canonical version rather than the `latest` alias,
    // with a server-side override. See docs/ANYWEAR-ARCHITECTURE.md.
    model: str('DECART_MODEL', 'lucy-vton-3.5'),
    usdPerSecond: num('DECART_USD_PER_SECOND', 0.02),
    budgetSeconds: num('DECART_BUDGET_SECONDS', 300),
    /** A platform.decart.ai browser session, only for reading the credit balance (see decart-account.ts). */
    sessionCookie: str('DECART_SESSION_COOKIE'),
  },

  vidu: {
    apiKey: str('VIDU_API_KEY'),
    host: str('VIDU_HOST', 'api.vidu.com'),
    usdPerSecond: num('VIDU_USD_PER_SECOND', 0.005),
    budgetSeconds: num('VIDU_BUDGET_SECONDS', 2400),
  },

  auth: {
    /**
     * Both client IDs are accepted as an audience: the dashboard signs in with
     * the Web client, the extension with the Chrome Extension client, and both
     * are the same person.
     */
    clientIds: [str('GOOGLE_CLIENT_ID'), str('GOOGLE_EXTENSION_CLIENT_ID')].filter((id) => id !== ''),
    /**
     * Who may open the dashboard. Customers sign in with any Google account;
     * only these addresses are operators. ALLOWED_EMAILS is the old name.
     */
    adminEmails: (str('ADMIN_EMAILS') || str('ALLOWED_EMAILS'))
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ''),
    sessionSecret: str('SESSION_SECRET') || randomUUID(),
    sessionTtlMs: num('SESSION_TTL_HOURS', 24 * 7) * 3600 * 1000,
    /** When false, a configured install still allows unauthenticated reads. */
    required: bool('AUTH_REQUIRED', true),
  },

  /** Users, credits and payments. Absent locally, the extension runs without accounts. */
  db: {
    url: str('SUPABASE_URL'),
    /** The server-side secret key (sb_secret_…). Never sent to a browser. */
    secretKey: str('SUPABASE_SECRET_KEY') || str('SUPABASE_SERVICE_ROLE_KEY'),
  },

  stripe: {
    secretKey: str('STRIPE_SECRET_KEY'),
    webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
  },

  /**
   * Fixed by the `key` in extension/manifest.json. Google needs it for the
   * sign-in redirect (https://<id>.chromiumapp.org/).
   */
  extensionId: str('EXTENSION_ID', 'aadnmnhilcphhjnchilngaeandeldngc'),

  /** Where Stripe sends a customer back to after checkout. */
  publicUrl: str('PUBLIC_URL', 'https://app.tryoncam.com').replace(/\/+$/, ''),

  ledgerPath: path.resolve(process.cwd(), str('LEDGER_PATH', 'data/ledger.jsonl')),
} as const;

/**
 * Settings the admin panel can flip at runtime. Kept separate from `config`
 * because these are deliberately mutable, while everything above is not.
 *
 * These start from .env and are then overwritten from the settings store on
 * every refresh (see `settings.ts`). On one long-lived process memory alone
 * was enough; on serverless each instance has its own memory, so a kill switch
 * flipped on one instance was silently off on the next.
 */
export const runtime: { activeProvider: ProviderId; killSwitch: boolean; sessionSeconds: number } = {
  activeProvider: isProviderId(str('ACTIVE_PROVIDER')) ? (str('ACTIVE_PROVIDER') as ProviderId) : 'decart',
  killSwitch: bool('KILL_SWITCH', false),
  // The live default for new sessions. MAX_SESSION_SECONDS remains the hard
  // ceiling this can never be raised above, so the panel cannot talk the
  // backend into an unbounded session.
  sessionSeconds: Math.min(num('DEFAULT_SESSION_SECONDS', 15), num('MAX_SESSION_SECONDS', 60)),
};

/** Per-provider budget ceiling in billed seconds. */
export function budgetSecondsFor(provider: ProviderId): number {
  return provider === 'decart' ? config.decart.budgetSeconds : config.vidu.budgetSeconds;
}

/** Per-provider price, used for every dollar figure the UI shows. */
export function usdPerSecondFor(provider: ProviderId): number {
  return provider === 'decart' ? config.decart.usdPerSecond : config.vidu.usdPerSecond;
}
