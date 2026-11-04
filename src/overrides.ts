import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { resetStripeClient } from './billing.js';
import { config } from './config.js';
import { resetDbClient } from './db.js';
import { cleanCookie, DECART_USD_PER_CREDIT, readDecartCredits, resetDecartBalanceCache } from './decart-account.js';
import { getStore } from './store/index.js';

/**
 * Production configuration the operator can change from the dashboard.
 *
 * Precedence: a value saved here, then Vercel's environment variable, then the
 * built-in default. Clearing a value here returns to Vercel's. Changes apply on
 * every instance within one settings refresh (30s), with no redeploy.
 *
 * Three rules keep this from becoming the easiest way to break production:
 *
 *  1. Every key is proven before it is saved — a live, zero-cost call with the
 *     candidate key. A typo is refused, not deployed.
 *  2. Secrets are write-only. They are stored AES-256-GCM encrypted under
 *     CONFIG_ENCRYPTION_KEY (which lives only on Vercel), and the browser only
 *     ever gets a masked hint back.
 *  3. Only values that are safe to swap on a running system are here. Redis,
 *     the session secret and the dashboard password stay on Vercel: the first
 *     is where this page stores its data, and the other two are how you get
 *     back in if something here goes wrong.
 */

type Group = 'stripe' | 'provider' | 'database' | 'limits';

type Definition = {
  name: string;
  group: Group;
  label: string;
  help: string;
  kind: 'secret' | 'number';
  min?: number;
  max?: number;
  integer?: boolean;
  get: () => string | number;
  set: (value: string | number) => void;
  /** Proves a candidate works. Returns what it found; throws with the reason if not. */
  check?: (value: string) => Promise<string>;
  /** Anything cached against the old value. */
  changed?: () => void;
};

// `config` is typed as constant so nothing mutates it by accident. This file
// is the one sanctioned exception.
const live = config as unknown as {
  stripe: { secretKey: string; webhookSecret: string };
  decart: { apiKey: string; budgetSeconds: number; usdPerSecond: number; baseUrl: string; model: string; sessionCookie: string };
  db: { url: string; secretKey: string };
  session: { maxSeconds: number; maxConcurrent: number };
};

async function checkStripe(key: string): Promise<string> {
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    throw new Error('A Stripe secret key starts with sk_live_, sk_test_, rk_live_ or rk_test_.');
  }
  try {
    await new Stripe(key, { timeout: 15_000 }).prices.list({ limit: 1 });
  } catch (error) {
    throw new Error(`Stripe refused it: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Stripe accepted it (${key.includes('_live_') ? 'live' : 'test'} mode).`;
}

async function checkDecart(key: string): Promise<string> {
  if (/\s/.test(key) || key.length < 20) throw new Error('That does not look like a Decart API key.');
  // Minting a client token is free: Decart bills streamed seconds, and this
  // token is never used to stream. It is the cheapest proof the key works.
  const response = await fetch(`${live.decart.baseUrl}/v1/client/tokens`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expiresIn: 10,
      allowedModels: [live.decart.model],
      constraints: { realtime: { maxSessionDuration: 10 } },
      metadata: { app: 'tryoncam-key-check' },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 160);
    throw new Error(`Decart refused it (HTTP ${response.status})${text ? `: ${text}` : ''}`);
  }
  return 'Decart accepted it (checked with a free test token, never used).';
}

async function checkSupabase(key: string): Promise<string> {
  if (!live.db.url) throw new Error('Set SUPABASE_URL on Vercel first.');
  const probe = createClient(live.db.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await probe.from('plans').select('id').limit(1);
  if (error) throw new Error(`Supabase refused it: ${error.message}`);
  return 'Supabase accepted it and can read the plans table.';
}

export const DEFINITIONS: Definition[] = [
  {
    name: 'STRIPE_SECRET_KEY', group: 'stripe', kind: 'secret',
    label: 'Secret key',
    help: 'sk_… or a restricted rk_… key. A restricted key needs write access to Customers, Checkout Sessions and Customer portal.',
    get: () => live.stripe.secretKey,
    set: (v) => (live.stripe.secretKey = String(v)),
    check: checkStripe,
    changed: resetStripeClient,
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET', group: 'stripe', kind: 'secret',
    label: 'Webhook signing secret',
    help: 'whsec_… from the endpoint for /api/stripe/webhook. It must come from the same mode (live or test) as the secret key.',
    get: () => live.stripe.webhookSecret,
    set: (v) => (live.stripe.webhookSecret = String(v)),
    check: async (v) => {
      if (!/^whsec_[A-Za-z0-9+/=]+$/.test(v)) throw new Error('A webhook signing secret starts with whsec_.');
      return 'Format is right. Stripe proves it on the next event it sends.';
    },
  },
  {
    name: 'DECART_API_KEY', group: 'provider', kind: 'secret',
    label: 'Decart API key',
    help: 'Rotate it here: paste the new key, then revoke the old one at platform.decart.ai.',
    get: () => live.decart.apiKey,
    set: (v) => (live.decart.apiKey = String(v)),
    check: checkDecart,
  },
  {
    name: 'DECART_SESSION_COOKIE', group: 'provider', kind: 'secret',
    label: 'Decart account session (for the live balance)',
    help: 'Decart has no API for the credit balance, so the dashboard reads it the way platform.decart.ai/billing does. ' +
      'Open that page signed in, then DevTools → Network → the "billing" request → Request Headers → copy the whole Cookie value and paste it here. ' +
      'It is only used to read the balance, never to buy or change anything. Sessions expire; when the balance says so, paste a fresh one.',
    get: () => live.decart.sessionCookie,
    set: (v) => (live.decart.sessionCookie = cleanCookie(String(v))),
    check: async (v) => {
      const credits = await readDecartCredits(v);
      return `Decart shows ${credits.toLocaleString('en-US')} credits ($${(credits * DECART_USD_PER_CREDIT).toFixed(2)}).`;
    },
    changed: resetDecartBalanceCache,
  },
  {
    name: 'DECART_BUDGET_SECONDS', group: 'provider', kind: 'number', min: 0, max: 10_000_000, integer: true,
    label: 'Spending cap (seconds)',
    help: 'A safety limit, not your Decart balance: total Decart seconds the backend may spend before refusing new sessions. Already-spent seconds count against it.',
    get: () => live.decart.budgetSeconds,
    set: (v) => (live.decart.budgetSeconds = Number(v)),
  },
  {
    name: 'DECART_USD_PER_SECOND', group: 'provider', kind: 'number', min: 0.0001, max: 10,
    label: 'Decart price per second (USD)',
    help: 'What Decart charges. Used for every dollar figure on the dashboard; it does not change what Decart bills.',
    get: () => live.decart.usdPerSecond,
    set: (v) => (live.decart.usdPerSecond = Number(v)),
  },
  {
    name: 'SUPABASE_SECRET_KEY', group: 'database', kind: 'secret',
    label: 'Supabase secret key',
    help: 'sb_secret_… from Project Settings → API Keys. Checked against the plans table before it is saved.',
    get: () => live.db.secretKey,
    set: (v) => (live.db.secretKey = String(v)),
    check: checkSupabase,
    changed: resetDbClient,
  },
  {
    name: 'MAX_SESSION_SECONDS', group: 'limits', kind: 'number', min: 10, max: 600, integer: true,
    label: 'Session length limit (seconds)',
    help: 'Only the highest value the session-length slider in Settings can be set to. It does not change how long sessions run: set that with the slider in Settings, which is also the length the website shows.',
    get: () => live.session.maxSeconds,
    set: (v) => (live.session.maxSeconds = Number(v)),
  },
  {
    name: 'MAX_CONCURRENT', group: 'limits', kind: 'number', min: 1, max: 100, integer: true,
    label: 'Sessions at once',
    help: 'How many try-ons may stream at the same moment, across everyone.',
    get: () => live.session.maxConcurrent,
    set: (v) => (live.session.maxConcurrent = Number(v)),
  },
];

const byName = new Map(DEFINITIONS.map((d) => [d.name, d]));

/** What Vercel's environment (or the default) says, captured before any override. */
const BASELINE = new Map(DEFINITIONS.map((d) => [d.name, d.get()]));

// --- Encryption ---------------------------------------------------------------

function encryptionKey(): Buffer | null {
  const raw = (process.env.CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (raw.length < 32) return null;
  return createHash('sha256').update(raw).digest();
}

export function overridesAvailable(): boolean {
  return encryptionKey() !== null;
}

type Sealed = { iv: string; tag: string; data: string };

/** The variable name is authenticated with the value, so a stored secret cannot be moved to another name. */
function seal(name: string, plain: string): Sealed {
  const key = encryptionKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY is not set on Vercel.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(name: string, sealed: Sealed): string {
  const key = encryptionKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY is not set.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
}

// --- Stored record --------------------------------------------------------------

type StoredValue = { sealed?: Sealed; number?: number; hint: string; updatedAt: string; updatedBy: string };
type AuditEntry = { at: string; by: string; name: string; action: 'set' | 'cleared'; hint: string };
type Stored = { values: Record<string, StoredValue>; audit: AuditEntry[] };

function normalise(raw: unknown): Stored {
  const source = (raw ?? {}) as Partial<Stored>;
  return { values: { ...(source.values ?? {}) }, audit: Array.isArray(source.audit) ? source.audit : [] };
}

/** Enough to tell two keys apart, never enough to use one. */
export function maskSecret(value: string): string {
  if (!value) return '';
  const prefix = value.match(/^[a-z]+_(?:(?:test|live|secret|publishable)_)?/i)?.[0] ?? '';
  return value.length <= prefix.length + 8 ? `${prefix}…` : `${prefix}…${value.slice(-4)}`;
}

let current: Stored = { values: {}, audit: [] };
const unreadable = new Set<string>();

/** Makes the stored values the live ones; anything absent or unreadable falls back to Vercel's. */
function apply(stored: Stored): void {
  current = stored;
  unreadable.clear();
  for (const def of DEFINITIONS) {
    let next: string | number = BASELINE.get(def.name)!;
    const saved = stored.values[def.name];
    if (saved) {
      try {
        next = def.kind === 'secret' && saved.sealed ? unseal(def.name, saved.sealed) : (saved.number ?? next);
      } catch {
        // Wrong or missing CONFIG_ENCRYPTION_KEY on this machine — a local
        // server sharing production's Redis, say. Keep its own .env value.
        unreadable.add(def.name);
        next = BASELINE.get(def.name)!;
      }
    }
    if (def.get() !== next) {
      def.set(next);
      def.changed?.();
    }
  }
}

export async function refreshOverrides(): Promise<void> {
  apply(normalise(await getStore().overrides()));
}

// --- Operator actions -------------------------------------------------------------

export class OverrideError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function parse(def: Definition, raw: unknown): string | number {
  if (def.kind === 'secret') {
    const value = String(raw ?? '').trim();
    if (!value) throw new OverrideError('Paste a value, or use "Use Vercel value" to clear the override.');
    return value;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new OverrideError(`${def.label} must be a number.`);
  if (def.integer && !Number.isInteger(value)) throw new OverrideError(`${def.label} must be a whole number.`);
  if (value < (def.min ?? -Infinity) || value > (def.max ?? Infinity)) {
    throw new OverrideError(`${def.label} must be between ${def.min} and ${def.max}.`);
  }
  return value;
}

export async function setOverride(name: string, raw: unknown, by: string): Promise<{ detail: string }> {
  const def = byName.get(name);
  if (!def) throw new OverrideError(`${name} cannot be changed here.`, 404);
  if (!overridesAvailable()) throw new OverrideError('CONFIG_ENCRYPTION_KEY is not set on Vercel.', 503);

  const value = parse(def, raw);
  const detail = def.check ? await def.check(String(value)).catch((error: Error) => {
    throw new OverrideError(error.message, 422);
  }) : 'Saved.';

  // Re-read before writing: another admin may have saved something else since.
  const stored = normalise(await getStore().overrides());
  const hint = def.kind === 'secret' ? maskSecret(String(value)) : String(value);
  stored.values[name] = {
    ...(def.kind === 'secret' ? { sealed: seal(name, String(value)) } : { number: Number(value) }),
    hint,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  stored.audit = [{ at: new Date().toISOString(), by, name, action: 'set' as const, hint }, ...stored.audit].slice(0, 100);
  await getStore().saveOverrides(stored);
  apply(stored);
  return { detail };
}

export async function clearOverride(name: string, by: string): Promise<void> {
  const def = byName.get(name);
  if (!def) throw new OverrideError(`${name} cannot be changed here.`, 404);
  const stored = normalise(await getStore().overrides());
  if (!stored.values[name]) return;
  delete stored.values[name];
  const baseline = BASELINE.get(name)!;
  const hint = def.kind === 'secret' ? maskSecret(String(baseline)) : String(baseline);
  stored.audit = [{ at: new Date().toISOString(), by, name, action: 'cleared' as const, hint }, ...stored.audit].slice(0, 100);
  await getStore().saveOverrides(stored);
  apply(stored);
}

// --- What the dashboard shows -------------------------------------------------------

/** Values that stay on Vercel, and why. Their presence is shown, never a secret. */
const VERCEL_ONLY: { name: string; why: string; secret: boolean; alternates?: string[] }[] = [
  { name: 'UPSTASH_REDIS_REST_URL', why: 'Where this page stores everything, including these overrides.', secret: false, alternates: ['KV_REST_API_URL'] },
  { name: 'UPSTASH_REDIS_REST_TOKEN', why: 'Same store; it cannot hold its own key.', secret: true, alternates: ['KV_REST_API_TOKEN'] },
  { name: 'CONFIG_ENCRYPTION_KEY', why: 'Unlocks the keys saved on this page.', secret: true },
  { name: 'SESSION_SECRET', why: 'Signs every sign-in; changing it signs everyone out.', secret: true },
  { name: 'DASHBOARD_PASSWORD', why: 'Your way back in if Google sign-in ever breaks.', secret: true },
  { name: 'ADMIN_EMAILS', why: 'Admins nobody can remove from this page.', secret: false },
  { name: 'SUPABASE_URL', why: 'Moving to another project means migrating its tables first.', secret: false },
  { name: 'PUBLIC_URL', why: 'Where Stripe returns customers after checkout.', secret: false },
];

export function describeEnvironment() {
  const values = DEFINITIONS.map((def) => {
    const saved = current.values[def.name];
    const value = def.get();
    const envSet = process.env[def.name] !== undefined && process.env[def.name] !== '';
    const source = saved && !unreadable.has(def.name) ? 'dashboard' : envSet ? 'vercel' : def.kind === 'number' ? 'default' : 'unset';
    return {
      name: def.name,
      group: def.group,
      label: def.label,
      help: def.help,
      kind: def.kind,
      min: def.min ?? null,
      max: def.max ?? null,
      source,
      // Numbers are not secret; secrets only ever leave as a hint.
      value: def.kind === 'number' ? value : null,
      hint: def.kind === 'secret' ? maskSecret(String(value)) : String(value),
      unreadable: unreadable.has(def.name),
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
    };
  });
  const vercelOnly = VERCEL_ONLY.map((item) => {
    const raw = [item.name, ...(item.alternates ?? [])].map((n) => (process.env[n] ?? '').trim()).find(Boolean) ?? '';
    return { name: item.name, why: item.why, set: raw !== '', display: item.secret ? '' : raw };
  });
  return { available: overridesAvailable(), values, vercelOnly, audit: current.audit.slice(0, 25) };
}
