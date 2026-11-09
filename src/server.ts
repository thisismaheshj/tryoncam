import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { overview } from './analytics.js';
import {
  DEFAULT_SHARE_IMAGE, publicSettings, readSettings, refreshSettings, renderPricingCopy, SHARE_IMAGES, shareImageUrl, writeRun, writeSettings,
} from './settings.js';
import { renderSiteContent, ROADMAP_ICONS, ROADMAP_STATUSES, SECTION_IDS } from './site-content.js';
import {
  authConfigured, clientIds, type GoogleUser, isAdmin, issueGateToken, issueSessionToken,
  readGateToken, readSessionToken, verifyIdToken,
} from './auth.js';
import {
  BillingError, checkPlans, createCheckout, createPortal, handleWebhook, stripeStatus,
} from './billing.js';
import {
  allPaymentTotals, dbConfigured, grantCredits, holdCredit, listPlans, listUsers, paymentsForUser, type Plan, planById,
  refundCredit, savePlans, subscriptionsForUser, upsertUser, userById, userBySub,
} from './db.js';
import type { LedgerEntry } from './ledger.js';
import { SessionGuard } from './budget.js';
import { budgetSecondsFor, config, isProviderId, type ProviderId, runtime } from './config.js';
import { Ledger } from './ledger.js';
import { clearOverride, describeEnvironment, OverrideError, setOverride } from './overrides.js';
import { assertDurableIfServerless, getStore } from './store/index.js';
import { allProviders, getProvider } from './providers/registry.js';
import { ProviderError, type SessionGrant } from './providers/types.js';

const ledger = new Ledger();
/**
 * A credit is spent when the video starts, not when the session is minted —
 * that is what the Terms promise. So any session that ends without having
 * started hands its credit back, whichever way it ended.
 */
const guard = new SessionGuard(ledger, undefined, async (entry) => {
  if (entry.startedAt === null && dbConfigured()) await refundCredit(entry.id);
});

/** Grants for live sessions, so we can end them with provider context. */
const grants = new Map<string, SessionGrant>();

const app = express();

/**
 * Stripe's webhook, mounted before the JSON parser: signature verification is
 * over the exact bytes Stripe sent, and a parsed-then-reserialised body is not
 * those bytes.
 */
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const signature = String(req.headers['stripe-signature'] ?? '');
  // Registered ahead of the refresh middleware, so it refreshes itself: the
  // signing secret may have been changed from the dashboard.
  refreshSettings(30_000)
    .then(() => handleWebhook(req.body as Buffer, signature))
    .then((outcome) => {
      console.log(`[stripe] ${outcome.type}: ${outcome.result}`);
      res.json({ received: true });
    })
    .catch((error: unknown) => {
      const status = error instanceof BillingError ? error.statusCode : 500;
      console.error('[stripe] webhook failed:', error instanceof Error ? error.message : error);
      // A 500 makes Stripe retry, which is what we want for a transient failure;
      // grants are idempotent, so a retry cannot pay out twice.
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    });
});

app.use(express.json({ limit: '1mb' }));

// Access log. Static assets are noise; API calls are what we debug with.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const mark = res.statusCode >= 400 ? '!' : ' ';
    console.log(
      `${mark} ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path} ` +
        `-> ${res.statusCode} (${Date.now() - started}ms)`,
    );
  });
  next();
});

/**
 * Refresh the settings cache before handling anything.
 *
 * A long-lived process only needs this once, but a serverless invocation may
 * be a cold start (cache would be defaults) or a warm one holding values
 * another instance has since changed. The TTL keeps it to one store read every
 * 30s rather than one per request.
 */
app.use((_req, _res, next) => {
  refreshSettings(30_000).then(() => next(), next);
});

const COOKIE = 'vton_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function currentUser(req: Request): GoogleUser | null {
  // A bearer token lets the extension call without a cookie, which it cannot
  // set against a different origin anyway.
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const user = readSessionToken(header.slice(7));
    if (user) return user;
  }
  return readSessionToken(parseCookies(req.headers.cookie)[COOKIE]);
}

/**
 * Three kinds of caller, and every API path belongs to exactly one.
 *
 *  - public:   the extension before sign-in, Stripe, health checks.
 *  - customer: anyone signed in with Google — mints sessions, buys credits.
 *  - operator: the dashboard. An admin's Google account, or the shared
 *              password while Google sign-in is being set up.
 *
 * Before customers could sign in, "signed in" and "operator" were the same
 * person, and the gate let any signed-in user through. Once the extension has
 * customers that would hand every one of them the dashboard's API.
 */
const GATE_PASSWORD = (process.env.DASHBOARD_PASSWORD ?? '').trim();
const GATE_COOKIE = 'vton_gate';

const PUBLIC_PATHS = ['/api/settings', '/api/health', '/api/auth/', '/api/billing/plans', '/api/stripe/webhook', '/api/public/'];
const CUSTOMER_PATHS = ['/api/session', '/api/billing/', '/api/account'];

/**
 * The shared password, from the cookie the dashboard's own sign-in screen sets
 * or from a Basic header (what scripts use). A `fetch` that gets a 401 does not
 * raise the browser's Basic dialog, so the cookie is what a person relies on.
 */
function passwordOk(req: Request): boolean {
  if (!GATE_PASSWORD) return false;
  if (readGateToken(parseCookies(req.headers.cookie)[GATE_COOKIE], GATE_PASSWORD)) return true;
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const [, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    const a = Buffer.from(password ?? '');
    const b = Buffer.from(GATE_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

/**
 * Operator access.
 *
 * A fresh local install with neither a password nor Google configured stays
 * open, as it always has — otherwise nobody could reach the screen where
 * Google sign-in gets configured.
 */
function isOperator(req: Request): boolean {
  const user = currentUser(req);
  if (user && isAdmin(user.email)) return true;
  if (passwordOk(req)) return true;
  if (!GATE_PASSWORD && (!authConfigured() || !readSettings().auth.required)) return true;
  return false;
}

app.use((req, res, next) => {
  // Only the API is gated. The dashboard shell has to be reachable for anyone
  // to type the password into it, and on Vercel the CDN serves those files
  // without ever reaching this middleware. The page holds no figures; every
  // number on it comes from a call that IS gated.
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) return next();
  if (isOperator(req)) return next();

  if (CUSTOMER_PATHS.some((p) => req.path.startsWith(p))) {
    if (currentUser(req)) return next();
    res.status(401).json({ error: 'Sign in with Google to do that.', reason: 'unauthenticated' });
    return;
  }

  if (currentUser(req)) {
    res.status(403).json({ error: 'That Google account is not an operator of this install.', reason: 'not_admin' });
    return;
  }
  // Only a caller with no credentials at all is offered a password prompt.
  res.setHeader('WWW-Authenticate', 'Basic realm="tryoncam", charset="UTF-8"');
  res.status(401).json({ error: 'Password required.', reason: 'gate' });
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

// --- State -----------------------------------------------------------------

async function providerState(id: ProviderId) {
  const provider = getProvider(id);
  const status = provider.status();
  const [spentSeconds, reservedSeconds, remainingSeconds, spentUsd, summary] = await Promise.all([
    ledger.spentSeconds(id),
    guard.reservedSeconds(id),
    guard.remainingSeconds(id),
    ledger.spentUsd(id),
    ledger.summary(id),
  ]);
  const budget = budgetSecondsFor(id);
  return {
    id,
    displayName: provider.displayName,
    model: provider.model,
    usdPerSecond: provider.usdPerSecond,
    minSessionSeconds: provider.minSessionSeconds,
    capabilities: provider.capabilities,
    status,
    selectable: status.configured && status.implemented,
    budget: {
      budgetSeconds: budget,
      spentSeconds,
      reservedSeconds,
      remainingSeconds,
      spentUsd: Number(spentUsd.toFixed(4)),
      budgetUsd: Number((budget * provider.usdPerSecond).toFixed(2)),
      remainingUsd: Number((remainingSeconds * provider.usdPerSecond).toFixed(4)),
    },
    summary,
  };
}

async function fullState() {
  const [providers, active] = await Promise.all([
    Promise.all(allProviders().map((p) => providerState(p.id))),
    guard.activeSessions(),
  ]);
  return {
    activeProvider: runtime.activeProvider,
    killSwitch: runtime.killSwitch,
    session: { ...config.session, sessionSeconds: runtime.sessionSeconds },
    providers,
    active: active.map((lease) => ({
      sessionId: lease.sessionId,
      provider: lease.provider,
      grantedSeconds: lease.reservedSeconds,
      extensions: lease.extensions,
      startedAt: lease.startedAt,
      garmentUrl: lease.garmentUrl,
    })),
    recent: await ledger.recent(25),
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, store: getStore().kind, gated: GATE_PASSWORD !== '' });
});

app.get('/api/state', wrap(async (_req, res) => {
  res.json(await fullState());
}));

// --- Settings ----------------------------------------------------------------

/** Read by the extension on every open; deliberately unauthenticated. */
app.get('/api/settings', (_req, res) => {
  // Identical for every caller and asked for on every page load by every
  // installed extension, so it is served from Vercel's CDN rather than by
  // starting this function each time. A dashboard edit reaches the extension
  // within about five minutes. Overrides the no-store vercel.json sets on /api.
  res.set('Cache-Control', 'public, max-age=60');
  res.set('Vercel-CDN-Cache-Control', 'max-age=300, stale-while-revalidate=3600');
  res.json(publicSettings());
});

/** The full record, including the admin list — operators only. */
app.get('/api/admin/settings', (_req, res) => {
  res.json({
    ...readSettings(),
    extensionId: config.extensionId,
    // Choices the Website tab offers, so the dashboard never drifts from what the server accepts.
    siteOptions: { sections: SECTION_IDS, icons: ROADMAP_ICONS, statuses: ROADMAP_STATUSES },
    // What to paste into Google Cloud, next to the fields that need it.
    google: {
      origin: config.publicUrl,
      extensionRedirect: `https://${config.extensionId}.chromiumapp.org/`,
      adminEmailsFromEnv: config.auth.adminEmails,
    },
  });
});

app.post('/api/admin/settings', wrap(async (req, res) => {
  // Run controls have their own endpoints. Dropping them here means a
  // dashboard that loaded a minute ago cannot quietly revert a kill switch.
  const { run: _ignored, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  try {
    res.json({ ok: true, settings: await writeSettings(rest) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

// --- Auth --------------------------------------------------------------------

/** Records a sign-in, granting the free credits on the first one. Null without a database. */
async function recordSignIn(user: GoogleUser) {
  if (!dbConfigured()) return null;
  return upsertUser(user, { admin: isAdmin(user.email), signupCredits: readSettings().billing.signupCredits });
}

function publicUser(user: GoogleUser, credits: number | null) {
  return { email: user.email, name: user.name, picture: user.picture, admin: isAdmin(user.email), credits };
}

app.get('/api/auth/me', wrap(async (req, res) => {
  const stored = readSettings().auth;
  const user = currentUser(req);
  const row = user && dbConfigured() ? await userBySub(user.sub).catch(() => null) : null;
  res.json({
    configured: authConfigured(),
    required: config.auth.required && stored.required,
    clientId: stored.webClientId || clientIds()[0] || null,
    user: user ? publicUser(user, row?.credits ?? null) : null,
    // The dashboard needs to know whether to draw a password screen before it
    // starts firing requests that would only come back 401.
    gate: { required: GATE_PASSWORD !== '', satisfied: !GATE_PASSWORD || isOperator(req) },
  });
}));

/** Dashboard sign-in with the interim shared password. */
app.post('/api/auth/password', (req, res) => {
  if (!GATE_PASSWORD) {
    res.json({ ok: true, gate: { required: false, satisfied: true } });
    return;
  }
  const supplied = String((req.body as { password?: unknown }).password ?? '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(GATE_PASSWORD);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'That password is not right.' });
    return;
  }
  res.setHeader(
    'Set-Cookie',
    `${GATE_COOKIE}=${issueGateToken(GATE_PASSWORD)}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
      `Max-Age=${Math.floor(config.auth.sessionTtlMs / 1000)}`,
  );
  res.json({ ok: true, gate: { required: true, satisfied: true } });
});

/** Dashboard sign-in: a Google Identity Services credential (an ID token). Operators only. */
app.post(
  '/api/auth/google',
  wrap(async (req, res) => {
    const credential = (req.body as { credential?: unknown }).credential;
    if (typeof credential !== 'string' || !credential) {
      res.status(400).json({ error: 'credential (a Google ID token) is required.' });
      return;
    }
    let user: GoogleUser;
    try {
      user = await verifyIdToken(credential);
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // The account page signs customers in through the same Google client;
    // the dashboard asks for an operator.
    const asCustomer = (req.body as { as?: unknown }).as === 'customer';
    if (!asCustomer && !isAdmin(user.email)) {
      res.status(403).json({ error: `${user.email} is not an operator of this dashboard.` });
      return;
    }
    if (asCustomer && !user.emailVerified) {
      res.status(403).json({ error: 'That Google account has no verified email address.' });
      return;
    }
    const row = await recordSignIn(user);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${issueSessionToken(user)}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
        `Max-Age=${Math.floor(config.auth.sessionTtlMs / 1000)}`,
    );
    res.json({ ok: true, user: publicUser(user, row?.credits ?? null) });
  }),
);

/**
 * Extension sign-in: an ID token from chrome.identity.launchWebAuthFlow.
 *
 * An ID token rather than an access token because its audience is checked:
 * an access token proves only that Google issued it to *some* app, so one
 * captured from any other site could be replayed here as a sign-in.
 */
app.post(
  '/api/auth/extension',
  wrap(async (req, res) => {
    const body = req.body as { idToken?: unknown; nonce?: unknown };
    if (typeof body.idToken !== 'string' || typeof body.nonce !== 'string' || !body.idToken || !body.nonce) {
      res.status(400).json({ error: 'idToken and nonce are required.' });
      return;
    }
    let user: GoogleUser;
    try {
      user = await verifyIdToken(body.idToken, { nonce: body.nonce });
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!user.emailVerified) {
      res.status(403).json({ error: 'That Google account has no verified email address.' });
      return;
    }
    const row = await recordSignIn(user);
    // The extension stores this and sends it as a bearer token.
    res.json({ ok: true, user: publicUser(user, row?.credits ?? null), sessionToken: issueSessionToken(user) });
  }),
);

/**
 * "Go to your account" from the extension. The extension already holds a
 * signed session token; it opens the account page with that token in the URL
 * fragment (never sent to any server or logged), and the page trades it here
 * for the same session as a cookie — no second Google sign-in.
 */
app.post('/api/auth/handoff', (req, res) => {
  const token = String((req.body as { token?: unknown }).token ?? '');
  const user = readSessionToken(token);
  if (!user) {
    res.status(401).json({ error: 'That sign-in has expired. Sign in again.' });
    return;
  }
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(config.auth.sessionTtlMs / 1000)}`,
  );
  res.json({ ok: true });
});

app.post('/api/auth/signout', (_req, res) => {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${GATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
  res.json({ ok: true });
});

// --- Billing (customers) -------------------------------------------------------

/** What a customer may see of a plan. */
function publicPlan(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    mode: plan.mode,
    interval: plan.interval,
    amountCents: plan.amount_cents,
    currency: plan.currency,
    credits: plan.credits,
    badge: plan.badge,
    features: plan.features,
    // A plan without a price ID is shown but cannot be bought yet.
    purchasable: Boolean(plan.stripe_price_id),
  };
}

function billingFailure(res: Response, error: unknown): void {
  const status = error instanceof BillingError ? error.statusCode : 500;
  if (status >= 500) console.error('[billing]', error);
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

app.get('/api/billing/plans', wrap(async (_req, res) => {
  if (!dbConfigured()) {
    res.json({ plans: [] });
    return;
  }
  res.json({ plans: (await listPlans({ activeOnly: true })).map(publicPlan) });
}));

app.get('/api/billing/me', wrap(async (req, res) => {
  const user = currentUser(req);
  // The dashboard password opens these paths too, but has no account behind it.
  if (!user) {
    res.status(401).json({ error: 'Sign in with Google to do that.', reason: 'unauthenticated' });
    return;
  }
  const row = dbConfigured() ? await userBySub(user.sub) : null;
  res.json({
    user: publicUser(user, row?.credits ?? null),
    requireCredits: readSettings().billing.requireCredits && !isAdmin(user.email),
    hasPurchases: Boolean(row?.stripe_customer_id),
  });
}));

app.post('/api/billing/checkout', wrap(async (req, res) => {
  const user = currentUser(req);
  // The dashboard password opens these paths too, but has no account behind it.
  if (!user) {
    res.status(401).json({ error: 'Sign in with Google to do that.', reason: 'unauthenticated' });
    return;
  }
  const planId = String((req.body as { planId?: unknown }).planId ?? '');
  try {
    if (!dbConfigured()) throw new BillingError('Purchases are not open yet.', 503);
    const [row, plan] = await Promise.all([userBySub(user.sub), planById(planId)]);
    if (!row) throw new BillingError('Sign in again before buying.', 401);
    if (!plan) throw new BillingError('No such plan.', 404);
    res.json({ url: await createCheckout(row, plan) });
  } catch (error) {
    billingFailure(res, error);
  }
}));

app.post('/api/billing/portal', wrap(async (req, res) => {
  const user = currentUser(req);
  // The dashboard password opens these paths too, but has no account behind it.
  if (!user) {
    res.status(401).json({ error: 'Sign in with Google to do that.', reason: 'unauthenticated' });
    return;
  }
  try {
    const row = dbConfigured() ? await userBySub(user.sub) : null;
    if (!row) throw new BillingError('No account found.', 404);
    res.json({ url: await createPortal(row) });
  } catch (error) {
    billingFailure(res, error);
  }
}));

// --- Billing (operators) -------------------------------------------------------

app.get('/api/admin/billing', wrap(async (_req, res) => {
  res.json({
    db: { configured: dbConfigured() },
    stripe: stripeStatus(),
    settings: readSettings().billing,
    plans: dbConfigured() ? await listPlans() : [],
  });
}));

function parsePlan(input: unknown, index: number): Plan {
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = (key: string, fallback = '') => String(raw[key] ?? fallback).trim();
  const id = text('id').toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(id)) {
    throw new BillingError(`Plan ${index + 1}: the id must be 2–32 lowercase letters, digits or dashes.`);
  }
  const mode = text('mode') === 'recurring' ? 'recurring' : 'one_time';
  const interval = mode === 'recurring' ? (text('interval') === 'year' ? 'year' : 'month') : null;
  const amount = Math.round(Number(raw.amount_cents));
  const credits = Math.round(Number(raw.credits));
  if (!Number.isFinite(amount) || amount < 0) throw new BillingError(`Plan "${id}": the price must be zero or more.`);
  if (!Number.isFinite(credits) || credits < 1) throw new BillingError(`Plan "${id}": it must grant at least one credit.`);
  const currency = text('currency', 'usd').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new BillingError(`Plan "${id}": currency must be a 3-letter code like usd.`);
  const features = Array.isArray(raw.features) ? raw.features : text('features').split('\n');
  return {
    id,
    name: text('name') || id,
    description: text('description'),
    mode,
    interval,
    amount_cents: amount,
    currency,
    credits,
    stripe_price_id: text('stripe_price_id') || null,
    badge: text('badge'),
    features: features.map((f) => String(f).trim()).filter(Boolean).slice(0, 8),
    active: raw.active !== false,
    sort: index,
  };
}

app.post('/api/admin/plans', wrap(async (req, res) => {
  try {
    if (!dbConfigured()) throw new BillingError('Connect the database first.', 503);
    const list = (req.body as { plans?: unknown }).plans;
    if (!Array.isArray(list)) throw new BillingError('plans must be a list.');
    const plans = list.map(parsePlan);
    const ids = new Set(plans.map((p) => p.id));
    if (ids.size !== plans.length) throw new BillingError('Two plans share an id.');
    res.json({ ok: true, plans: await savePlans(plans) });
  } catch (error) {
    billingFailure(res, error);
  }
}));

/** Checks every plan's price ID against Stripe: amount, currency, one-off vs recurring, interval. */
app.post('/api/admin/plans/check', wrap(async (_req, res) => {
  try {
    if (!dbConfigured()) throw new BillingError('Connect the database first.', 503);
    const plans = await listPlans();
    res.json({ stripe: stripeStatus(), checks: await checkPlans(plans) });
  } catch (error) {
    billingFailure(res, error);
  }
}));

app.post('/api/admin/billing-settings', wrap(async (req, res) => {
  const body = (req.body ?? {}) as { signupCredits?: unknown; requireCredits?: unknown };
  const settings = await writeSettings({
    billing: {
      signupCredits: Number(body.signupCredits ?? readSettings().billing.signupCredits),
      requireCredits: body.requireCredits !== false,
    },
  });
  res.json({ ok: true, billing: settings.billing });
}));

/** Sessions each person has run, from the ledger. Only sessions that streamed count. */
function usageByEmail(entries: LedgerEntry[]) {
  const usage = new Map<string, { sessions: number; seconds: number; lastAt: string | null }>();
  for (const entry of entries) {
    const email = entry.user?.email?.toLowerCase();
    if (!email || entry.billedSeconds <= 0) continue;
    const row = usage.get(email) ?? { sessions: 0, seconds: 0, lastAt: null };
    row.sessions += 1;
    row.seconds += entry.billedSeconds;
    if (!row.lastAt || entry.endedAt > row.lastAt) row.lastAt = entry.endedAt;
    usage.set(email, row);
  }
  return usage;
}

app.get('/api/admin/users', wrap(async (_req, res) => {
  if (!dbConfigured()) {
    res.json({ summary: null, users: [] });
    return;
  }
  const [users, entries, payments] = await Promise.all([listUsers(1000), ledger.entries(), allPaymentTotals()]);
  const usage = usageByEmail(entries);
  const paid = new Map<string, { count: number; usdCents: number }>();
  for (const p of payments) {
    if (!p.user_id) continue;
    const row = paid.get(p.user_id) ?? { count: 0, usdCents: 0 };
    row.count += 1;
    if (p.currency === 'usd') row.usdCents += p.amount_cents;
    paid.set(p.user_id, row);
  }
  const day = 86_400_000;
  const since = (days: number) => users.filter((u) => Date.now() - Date.parse(u.created_at) < days * day).length;
  const rows = users.map((u) => {
    const use = usage.get(u.email.toLowerCase());
    const pay = paid.get(u.id);
    return {
      id: u.id, email: u.email, name: u.name, picture: u.picture, role: u.role, credits: u.credits,
      createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      sessions: use?.sessions ?? 0, secondsUsed: use?.seconds ?? 0, lastSessionAt: use?.lastAt ?? null,
      purchases: pay?.count ?? 0, spentUsd: (pay?.usdCents ?? 0) / 100,
    };
  });
  res.json({
    summary: {
      users: users.length,
      newToday: since(1),
      new7d: since(7),
      new30d: since(30),
      paying: rows.filter((r) => r.purchases > 0).length,
      activeUsers: rows.filter((r) => r.sessions > 0).length,
      sessions: rows.reduce((t, r) => t + r.sessions, 0),
    },
    users: rows,
  });
}));

// --- Customer account page -------------------------------------------------------

app.get('/api/account', wrap(async (req, res) => {
  const user = currentUser(req);
  // The dashboard password opens these paths too, but has no account behind it.
  if (!user) {
    res.status(401).json({ error: 'Sign in with Google to do that.', reason: 'unauthenticated' });
    return;
  }
  const row = dbConfigured() ? await userBySub(user.sub) : null;
  const mine = (await ledger.entries())
    .filter((e) => e.user?.email?.toLowerCase() === user.email.toLowerCase())
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  const streamed = mine.filter((e) => e.billedSeconds > 0);
  const [purchases, subscriptions, plans] = row
    ? await Promise.all([paymentsForUser(row.id), subscriptionsForUser(row.id), listPlans({ activeOnly: true })])
    : [[], [], []];
  res.json({
    user: {
      name: user.name,
      email: user.email,
      picture: user.picture,
      memberSince: row?.created_at ?? null,
      admin: isAdmin(user.email),
    },
    credits: row?.credits ?? null,
    requireCredits: readSettings().billing.requireCredits && !isAdmin(user.email),
    usage: {
      sessions: streamed.length,
      seconds: streamed.reduce((t, e) => t + e.billedSeconds, 0),
      recent: streamed.slice(0, 15).map((e) => ({
        at: e.endedAt,
        seconds: e.billedSeconds,
        site: (() => {
          try {
            return e.garmentUrl ? new URL(e.garmentUrl).hostname.replace(/^www\./, '') : null;
          } catch {
            return null;
          }
        })(),
      })),
    },
    purchases: purchases.map((p) => ({
      at: p.created_at, amountCents: p.amount_cents, currency: p.currency, credits: p.credits,
      plan: p.plan_id, recurring: Boolean(p.stripe_subscription_id),
    })),
    subscriptions: subscriptions.map((s) => ({
      plan: s.plan_id, status: s.status, renewsAt: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end,
    })),
    plans: plans.map(publicPlan).filter((p) => p.purchasable),
    hasBillingPortal: Boolean(row?.stripe_customer_id),
    support: readSettings().contact.supportEmail,
  });
}));

// --- Landing page pricing --------------------------------------------------------

/** tryoncam.com reads its pricing section from here, so it always matches what checkout charges. */
const SITE_ORIGINS = new Set(['https://tryoncam.com', 'https://www.tryoncam.com', 'http://localhost:5180']);

app.get('/api/public/pricing', wrap(async (req, res) => {
  const origin = String(req.headers.origin ?? '');
  if (SITE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // Never cached: a price saved in the dashboard must show on the next page
  // load, not a minute later. The payload is a few hundred bytes.
  res.setHeader('Cache-Control', 'no-store');
  const settings = readSettings();
  res.json({
    copy: renderPricingCopy(settings.pricing, runtime.sessionSeconds),
    sessionSeconds: runtime.sessionSeconds,
    freeCredits: settings.billing.signupCredits,
    plans: dbConfigured() ? (await listPlans({ activeOnly: true })).map(publicPlan) : [],
  });
}));

/** tryoncam.com's pages fill in the support address from here, so changing it in the dashboard changes it everywhere. */
/**
 * The link-preview picture. Every tryoncam.com page names this one address in
 * og:image; it serves whichever image the dashboard picked. The bytes are
 * served here rather than redirected, because not every preview crawler
 * follows redirects for images.
 */
app.get('/api/public/share-image.jpg', wrap(async (_req, res) => {
  const url = shareImageUrl(readSettings().share.image);
  try {
    const upstream = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const type = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !type.startsWith('image/')) throw new Error(`${upstream.status} ${type}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 5 * 1024 * 1024) throw new Error('image over 5 MB');
    res.setHeader('Content-Type', type);
    // Short: a new pick should reach crawlers that re-fetch, without a redeploy.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.send(body);
  } catch (error) {
    console.error('share image failed, sending the default', url, error);
    res.redirect(302, DEFAULT_SHARE_IMAGE.url);
  }
}));

/** The designs the dashboard offers for the link preview. */
app.get('/api/admin/share-images', (_req, res) => {
  res.json({ images: SHARE_IMAGES, current: readSettings().share.image });
});

app.get('/api/public/site', (req, res) => {
  const origin = String(req.headers.origin ?? '');
  if (SITE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');
  const settings = readSettings();
  res.json({
    supportEmail: settings.contact.supportEmail,
    sessionSeconds: runtime.sessionSeconds,
    maxSessionSeconds: config.session.maxSeconds,
    freeCredits: settings.billing.signupCredits,
    // The landing page's words and switches, tokens already filled in.
    content: renderSiteContent(settings.site, {
      credits: settings.billing.signupCredits,
      seconds: runtime.sessionSeconds,
      email: settings.contact.supportEmail,
    }),
  });
});

/** Manual adjustment for support cases: a goodwill top-up, or a correction. */
app.post('/api/admin/users/:id/credits', wrap(async (req, res) => {
  try {
    if (!dbConfigured()) throw new BillingError('Connect the database first.', 503);
    const delta = Math.round(Number((req.body as { delta?: unknown }).delta));
    const note = String((req.body as { note?: unknown }).note ?? '').slice(0, 200);
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) {
      throw new BillingError('delta must be a whole number between -1000 and 1000, not zero.');
    }
    const target = await userById(String(req.params.id));
    if (!target) throw new BillingError('No such user.', 404);
    await grantCredits({
      userId: target.id,
      delta,
      reason: 'admin_adjust',
      ref: `admin:${randomUUID()}`,
      note: note || 'Adjusted from the dashboard',
    });
    res.json({ ok: true, credits: (await userById(target.id))?.credits ?? null });
  } catch (error) {
    billingFailure(res, error);
  }
}));

// --- Environment (operators) ---------------------------------------------------

/**
 * Viewing is for any operator. Changing a key needs an admin's own Google
 * sign-in: the shared password is one secret many people may hold, and a
 * swapped Stripe key would send the takings to somebody else's account. With
 * Google, every change in the log has a name on it.
 */
function keyEditor(req: Request): string | null {
  const user = currentUser(req);
  return user && isAdmin(user.email) ? user.email : null;
}

app.get('/api/admin/env', wrap(async (req, res) => {
  await refreshSettings();
  const editor = keyEditor(req);
  res.json({
    ...describeEnvironment(),
    editor,
    canEdit: editor !== null,
  });
}));

function overrideFailure(res: Response, error: unknown): void {
  const status = error instanceof OverrideError ? error.statusCode : 500;
  if (status >= 500) console.error('[env]', error);
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

app.put('/api/admin/env/:name', wrap(async (req, res) => {
  const editor = keyEditor(req);
  if (!editor) {
    res.status(403).json({ error: 'Changing keys needs an admin Google sign-in. The shared password can only view them.', reason: 'google_required' });
    return;
  }
  try {
    const result = await setOverride(String(req.params.name), (req.body as { value?: unknown }).value, editor);
    console.log(`[env] ${editor} set ${req.params.name}`);
    res.json({ ok: true, ...result });
  } catch (error) {
    overrideFailure(res, error);
  }
}));

app.delete('/api/admin/env/:name', wrap(async (req, res) => {
  const editor = keyEditor(req);
  if (!editor) {
    res.status(403).json({ error: 'Changing keys needs an admin Google sign-in. The shared password can only view them.', reason: 'google_required' });
    return;
  }
  try {
    await clearOverride(String(req.params.name), editor);
    console.log(`[env] ${editor} cleared ${req.params.name}`);
    res.json({ ok: true });
  } catch (error) {
    overrideFailure(res, error);
  }
}));

app.get('/api/analytics', wrap(async (req, res) => {
  const requested = Number(req.query.days ?? 14);
  const days = Math.min(Math.max(Number.isFinite(requested) ? Math.round(requested) : 14, 1), 90);
  // ?fresh=1 is the dashboard's "Refresh balance": read Decart now, not from the one-minute cache.
  res.json(await overview(ledger, days, { freshBalance: req.query.fresh === '1' }));
}));

/** Kept because the brief asks for it by name. */
app.get('/api/budget', wrap(async (_req, res) => {
  res.json((await providerState(runtime.activeProvider)).budget);
}));

// --- Admin controls --------------------------------------------------------

app.post('/api/admin/provider', wrap(async (req, res) => {
  const next = (req.body as { provider?: unknown }).provider;
  if (!isProviderId(next)) {
    res.status(400).json({ error: 'provider must be "decart" or "vidu".' });
    return;
  }
  const status = getProvider(next).status();
  if (!status.configured || !status.implemented) {
    res.status(409).json({ error: `Cannot select ${next}: ${status.detail}` });
    return;
  }
  await writeRun({ activeProvider: next });
  res.json({ ok: true, activeProvider: runtime.activeProvider });
}));

app.post('/api/admin/session-seconds', wrap(async (req, res) => {
  const value = Number((req.body as { seconds?: unknown }).seconds);
  if (!Number.isFinite(value) || value <= 0) {
    res.status(400).json({ error: 'seconds must be a positive number.' });
    return;
  }
  // Read the ceiling fresh: a Longest-session change made moments ago on the
  // Environment tab may not have reached this instance yet, and clamping to
  // the stale one silently put sessions back to 15 seconds.
  await refreshSettings();
  const floor = getProvider(runtime.activeProvider).minSessionSeconds;
  const clamped = Math.min(Math.max(Math.round(value), floor), config.session.maxSeconds);
  await writeRun({ sessionSeconds: clamped });
  res.json({
    ok: true,
    sessionSeconds: clamped,
    clamped: clamped !== Math.round(value),
    floor,
    ceiling: config.session.maxSeconds,
  });
}));

app.post('/api/admin/kill-switch', wrap(async (req, res) => {
  const enabled = (req.body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean.' });
    return;
  }
  await writeRun({ killSwitch: enabled });
  res.json({ ok: true, killSwitch: runtime.killSwitch });
}));

// --- Garment image proxy ---------------------------------------------------

/**
 * Fetches a product image server-side. Shopping sites frequently block
 * cross-origin reads or hotlinking, so going through here is what makes
 * "click Try On on any site" work at all.
 */
app.get(
  '/api/garment',
  wrap(async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: 'url must be an absolute http(s) URL.' });
      return;
    }
    // Hotlink protection checks the Referer against the PAGE the image is
    // embedded in, not the image's own host. Sending the image origin (what
    // this did first) is exactly the request such a check rejects.
    // `pageUrl` is the product page when the caller knows it.
    const pageUrl = typeof req.query.pageUrl === 'string' ? req.query.pageUrl : '';
    let referer = '';
    try {
      referer = pageUrl && /^https?:\/\//i.test(pageUrl) ? new URL(pageUrl).origin + '/' : '';
    } catch {
      referer = '';
    }
    if (!referer) {
      // No page given: guess the site from the CDN host. i.pinimg.com wants
      // pinterest.com, scene7/demandware hosts want the retailer, and so on.
      try {
        const host = new URL(url).hostname;
        const guess = host.replace(/^(i|img|images?|cdn|static|media|assets)[0-9-]*\./i, '');
        referer = `https://www.${guess}/`;
      } catch {
        referer = '';
      }
    }
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      res.status(502).json({
        error:
          upstream.status === 403
            ? `That host refused the request (HTTP 403) — it blocks hotlinking. Save the image and host it somewhere, or use a different product image.`
            : `Garment fetch failed: HTTP ${upstream.status}`,
      });
      return;
    }
    const type = upstream.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) {
      if (type.includes('html') && req.query.followed !== '1') {
        // A product/pin page rather than an image. Pull the main image out of
        // its metadata and fetch that instead, so pasting the page URL works.
        const html = await upstream.text();
        const found = extractPageImage(html, url);
        if (found) {
          const target = `/api/garment?url=${encodeURIComponent(found)}&followed=1&pageUrl=${encodeURIComponent(url)}`;
          res.redirect(302, target);
          return;
        }
      }
      res.status(415).json({
        error: type.includes('html')
          ? 'That page has no usable product image in its metadata. Right-click the photo and choose "Copy image address".'
          : `Expected an image, got "${type}".`,
      });
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buffer);
  }),
);

// --- Session lifecycle -----------------------------------------------------

app.post(
  '/api/session',
  wrap(async (req, res) => {
    const body = req.body as {
      garmentUrl?: unknown; prompt?: unknown; seconds?: unknown; provider?: unknown; enhance?: unknown;
    };

    const providerId = isProviderId(body.provider) ? body.provider : runtime.activeProvider;
    const garmentUrl = typeof body.garmentUrl === 'string' ? body.garmentUrl.trim() : '';
    if (!/^https?:\/\//i.test(garmentUrl)) {
      res.status(400).json({ error: 'garmentUrl must be an absolute http(s) URL.' });
      return;
    }

    // No explicit duration (the extension never sends one) falls back to the
    // runtime default, which the admin panel controls.
    const requested = Number(body.seconds ?? runtime.sessionSeconds);
    const asked = Math.min(
      Number.isFinite(requested) && requested > 0 ? Math.ceil(requested) : config.session.maxSeconds,
      config.session.maxSeconds,
    );
    // Raise to the provider's floor BEFORE reserving: the provider will
    // enforce its minimum regardless, so reserving less would under-account
    // the budget by the difference.
    const seconds = Math.max(asked, getProvider(providerId).minSessionSeconds);

    // Operators reach here without a Google account (the shared password);
    // customers always have one — the access middleware saw to that.
    const user = currentUser(req);

    // Read the run controls fresh: another instance may have flipped the kill
    // switch within the last 30 seconds of this one's cache.
    await refreshSettings();

    // The kill switch outranks every other refusal, so that its message is
    // the one the operator sees when more than one reason applies.
    if (runtime.killSwitch) {
      res.status(403).json({ error: 'KILL_SWITCH is on; session minting is disabled.', reason: 'kill_switch' });
      return;
    }

    // Refuse an unusable provider before reserving anything.
    const providerStatus = getProvider(providerId).status();
    if (!providerStatus.configured || !providerStatus.implemented) {
      res.status(503).json({ error: providerStatus.detail, reason: 'provider_unconfigured' });
      return;
    }

    const provider = getProvider(providerId);
    const sessionId = randomUUID();
    // Empty by default, exactly as Anywear ships: the garment image is the
    // instruction. A description is an optional override, not a requirement.
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

    // Take the customer's credit before anything else is committed. Operators
    // try on for free, as does everyone while credits are switched off.
    const chargesCredit =
      user !== null && dbConfigured() && readSettings().billing.requireCredits && !isAdmin(user.email);
    let creditsLeft: number | null = null;
    if (chargesCredit) {
      creditsLeft = await holdCredit(user.sub, sessionId);
      if (creditsLeft < 0) {
        res.status(402).json({ error: 'You are out of credits.', reason: 'no_credits' });
        return;
      }
    }

    // Reserve atomically: the slot and its worst-case seconds are held while
    // the provider call is in flight, so two simultaneous requests cannot both
    // pass — across instances as well as within one.
    const reservation = await guard.reserve({
      sessionId, provider: providerId, model: provider.model, seconds, garmentUrl,
      user: user ? { email: user.email, name: user.name } : null,
    });
    if (!reservation.ok) {
      // Nothing was reserved, so no release will ever run to refund it.
      if (chargesCredit) await refundCredit(sessionId);
      res.status(reservation.reason === 'concurrency_limit' ? 429 : 403).json({
        error: reservation.detail,
        reason: reservation.reason,
      });
      return;
    }

    try {
      const grant = await provider.createSession({
        sessionId,
        garmentUrl,
        prompt,
        maxSessionSeconds: seconds,
        enhance: body.enhance === true,
        allowedOrigin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      });
      grants.set(sessionId, grant);
      res.json({ sessionId, seconds, grant, creditsLeft });
    } catch (error) {
      // Creation failed, so nothing can be billed — release without a charge.
      await guard.release(sessionId, {
        billedSeconds: 0,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
      });
      const status = error instanceof ProviderError ? error.statusCode : 502;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }),
);

app.post('/api/session/:id/started', wrap(async (req, res) => {
  const decision = await guard.markStarted(String(req.params.id));
  if (!decision.ok) {
    res.status(404).json({ error: decision.detail });
    return;
  }
  res.json({ ok: true });
}));

app.post('/api/session/:id/extend', wrap(async (req, res) => {
  // A credit buys one session of fixed length. Extending is an operator tool;
  // open to customers it would be free seconds on request.
  if (!isOperator(req)) {
    res.status(403).json({ error: 'Sessions cannot be extended.', reason: 'not_admin' });
    return;
  }
  const result = await guard.extend(String(req.params.id), config.session.extensionSeconds);
  if (!result.ok) {
    res.status(result.reason === 'session_unknown' ? 404 : 403).json({ error: result.detail, reason: result.reason });
    return;
  }
  res.json({ ok: true, totalSeconds: result.totalSeconds });
}));

app.post(
  '/api/session/:id/end',
  wrap(async (req, res) => {
    const sessionId = String(req.params.id);
    const body = req.body as { timeToFirstFrameMs?: unknown; note?: unknown; billedSeconds?: unknown };
    const grant = grants.get(sessionId) ?? null;

    let billedSeconds: number | undefined;
    let estimated = true;
    let note: string | null = typeof body.note === 'string' ? body.note : null;

    if (grant) {
      const provider = getProvider(grant.provider);
      const billing = await provider.endSession(sessionId, grant);
      if (typeof billing.billedSeconds === 'number') {
        billedSeconds = billing.billedSeconds;
        estimated = billing.estimated;
      }
      if (billing.note) note = note ? `${note} | ${billing.note}` : billing.note;
    }
    grants.delete(sessionId);

    const entry = await guard.release(sessionId, {
      billedSeconds,
      estimated,
      timeToFirstFrameMs:
        typeof body.timeToFirstFrameMs === 'number' ? Math.round(body.timeToFirstFrameMs) : null,
      note,
    });

    if (!entry) {
      res.status(404).json({ error: `No active session ${sessionId}. It may already have been swept.` });
      return;
    }
    res.json({ ok: true, entry, budget: (await providerState(entry.provider)).budget });
  }),
);

/**
 * Pulls the primary image out of a product or pin page. og:image is what every
 * commerce platform and Pinterest fill in for link previews, so it is both the
 * most reliable and the most likely to be the hero shot.
 */
function extractPageImage(html: string, baseUrl: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /"contentUrl"\s*:\s*"([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i,
    /"image"\s*:\s*"(https?:[^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return new URL(match[1].replace(/&amp;/g, '&'), baseUrl).href;
      } catch {
        // Try the next pattern.
      }
    }
  }
  return null;
}

// --- Static ----------------------------------------------------------------

const root = process.cwd();
// The control panel is gone: its provider switch, kill switch and session
// length now live in the dashboard's Settings tab, and its try-on harness was
// superseded by the extension itself. Old links keep working.
app.get(['/admin', '/admin/*'], (_req, res) => res.redirect(302, '/dashboard/#settings'));
app.use('/dashboard', express.static(path.join(root, 'public/dashboard')));
// Served by Vercel's CDN in production; the same files locally.
app.use('/account', express.static(path.join(root, 'public/account')));
app.use('/billing', express.static(path.join(root, 'public/billing')));
// Dev convenience: serve the extension's own assets so its UI can be previewed
// in a normal tab without loading the unpacked extension.
app.use('/ext', express.static(path.join(root, 'extension')));
// Served locally rather than from a CDN so the exact same UI can be bundled
// into the MV3 extension later, where remote scripts are forbidden.
app.use('/vendor/decart-sdk', express.static(path.join(root, 'node_modules/@decartai/sdk/dist')));
app.get('/', (_req, res) => res.redirect('/dashboard/'));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', error.message);
  res.status(500).json({ error: error.message });
});

// Reclaim abandoned leases even when nobody is calling the API.
setInterval(() => {
  guard
    .sweep()
    .then((expired) => {
      for (const entry of expired) {
        grants.delete(entry.id);
        console.warn(`[sweep] reclaimed ${entry.id} (${entry.provider}) — billed ${entry.billedSeconds}s`);
      }
    })
    .catch((error) => console.error('[sweep] failed:', error));
}, 5_000).unref();

// A long-lived process listens; serverless imports `app` and never reaches here.
export { app };

export function start(): void {
  assertDurableIfServerless();
  app.listen(config.port, () => {
    console.log(`\n  tryoncam backend`);
    console.log(`  Dashboard   http://localhost:${config.port}/dashboard/`);
    console.log(`  Store       ${getStore().kind}${GATE_PASSWORD ? '  ·  password gate on' : ''}`);
    console.log(`  Provider    ${runtime.activeProvider}${runtime.killSwitch ? '  [KILL SWITCH ON]' : ''}`);
    for (const provider of allProviders()) {
      const status = provider.status();
      const mark = status.configured && status.implemented ? 'ready' : 'unavailable';
      console.log(`    ${provider.id.padEnd(7)} ${mark.padEnd(12)} ${status.detail}`);
    }
    console.log('');
  });
}
