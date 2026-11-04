import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

/**
 * Users, credits, plans and payments, in Supabase Postgres.
 *
 * Kept apart from the Redis store on purpose. Redis holds the hot path — the
 * atomic budget reservation that every session start goes through — and has
 * been proven under a race. What lives here is relational (a payment belongs
 * to a user and a plan) and must be auditable, which is what Postgres is for.
 *
 * Every balance change goes through a SQL function (see the `billing_and_users`
 * migration) so the check and the write happen in one statement: two requests
 * cannot both spend a user's last credit, and a webhook Stripe delivers twice
 * grants once.
 */

export type DbUser = {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: 'customer' | 'admin';
  credits: number;
  stripe_customer_id: string | null;
  created_at: string;
  last_seen_at: string;
};

export type Plan = {
  id: string;
  name: string;
  description: string;
  mode: 'one_time' | 'recurring';
  interval: 'month' | 'year' | null;
  amount_cents: number;
  currency: string;
  credits: number;
  stripe_price_id: string | null;
  badge: string;
  features: string[];
  active: boolean;
  sort: number;
};

let client: SupabaseClient | null = null;

export function dbConfigured(): boolean {
  return config.db.url !== '' && config.db.secretKey !== '';
}

/** Called when the key changes from the dashboard, so the next call uses the new one. */
export function resetDbClient(): void {
  client = null;
}

function db(): SupabaseClient {
  if (!dbConfigured()) {
    throw new Error('The database is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY.');
  }
  client ??= createClient(config.db.url, config.db.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Supabase reports errors as values; this turns them back into exceptions. */
function must<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

// --- Users ---------------------------------------------------------------------

export async function upsertUser(
  user: { sub: string; email: string; name: string; picture: string },
  options: { admin: boolean; signupCredits: number },
): Promise<DbUser> {
  const row = must(
    await db().rpc('upsert_user', {
      p_sub: user.sub,
      p_email: user.email,
      p_name: user.name,
      p_picture: user.picture,
      p_admin: options.admin,
      p_signup_credits: Math.max(0, Math.round(options.signupCredits)),
    }),
    'Could not record the sign-in',
  );
  return row as DbUser;
}

export async function userBySub(sub: string): Promise<DbUser | null> {
  const rows = must(await db().from('users').select('*').eq('google_sub', sub).limit(1), 'Could not load the user');
  return (rows?.[0] as DbUser | undefined) ?? null;
}

export async function userById(id: string): Promise<DbUser | null> {
  const rows = must(await db().from('users').select('*').eq('id', id).limit(1), 'Could not load the user');
  return (rows?.[0] as DbUser | undefined) ?? null;
}

export async function listUsers(limit = 200): Promise<DbUser[]> {
  return must(
    await db().from('users').select('*').order('last_seen_at', { ascending: false }).limit(limit),
    'Could not list users',
  ) as DbUser[];
}

export async function setStripeCustomer(userId: string, customerId: string): Promise<void> {
  must(await db().from('users').update({ stripe_customer_id: customerId }).eq('id', userId), 'Could not save the customer');
}

// --- Credits -------------------------------------------------------------------

/** Takes one credit. Returns the balance left, or -1 when there was none. */
export async function holdCredit(sub: string, sessionId: string): Promise<number> {
  return Number(must(await db().rpc('hold_credit', { p_sub: sub, p_session: sessionId }), 'Could not take a credit'));
}

/** Gives back the credit held for a session that never started. Idempotent. */
export async function refundCredit(sessionId: string): Promise<boolean> {
  return Boolean(must(await db().rpc('refund_credit', { p_session: sessionId }), 'Could not refund the credit'));
}

/** Adds credits against an external reference. Returns false if that reference was already granted. */
export async function grantCredits(input: {
  userId: string;
  delta: number;
  reason: 'purchase' | 'subscription_renewal' | 'admin_adjust';
  ref: string;
  note: string;
}): Promise<boolean> {
  return Boolean(
    must(
      await db().rpc('grant_credits', {
        p_user: input.userId,
        p_delta: input.delta,
        p_reason: input.reason,
        p_ref: input.ref,
        p_note: input.note,
      }),
      'Could not grant credits',
    ),
  );
}

// --- Plans ---------------------------------------------------------------------

const PLAN_COLUMNS =
  'id,name,description,mode,interval,amount_cents,currency,credits,stripe_price_id,badge,features,active,sort';

export async function listPlans(options: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  let query = db().from('plans').select(PLAN_COLUMNS).order('sort', { ascending: true });
  if (options.activeOnly) query = query.eq('active', true);
  return must(await query, 'Could not load plans') as unknown as Plan[];
}

export async function planById(id: string): Promise<Plan | null> {
  const rows = must(await db().from('plans').select(PLAN_COLUMNS).eq('id', id).limit(1), 'Could not load the plan');
  return (rows?.[0] as unknown as Plan | undefined) ?? null;
}

/**
 * Replaces the plan list with exactly what the dashboard sent.
 *
 * A plan removed here is deleted; payments that referenced it keep their row
 * with `plan_id` set to null, so revenue history is never lost with it.
 */
export async function savePlans(plans: Plan[]): Promise<Plan[]> {
  const rows = plans.map((plan) => ({ ...plan, updated_at: new Date().toISOString() }));
  if (rows.length) must(await db().from('plans').upsert(rows, { onConflict: 'id' }), 'Could not save plans');

  const keep = new Set(plans.map((plan) => plan.id));
  const existing = await listPlans();
  const gone = existing.filter((plan) => !keep.has(plan.id)).map((plan) => plan.id);
  if (gone.length) must(await db().from('plans').delete().in('id', gone), 'Could not remove plans');

  return listPlans();
}

// --- Payments ------------------------------------------------------------------

export async function recordPayment(input: {
  userId: string | null;
  planId: string | null;
  ref: string;
  subscriptionId: string | null;
  amountCents: number;
  currency: string;
  credits: number;
  status: string;
}): Promise<void> {
  must(
    await db().from('payments').upsert(
      {
        user_id: input.userId,
        plan_id: input.planId,
        external_ref: input.ref,
        stripe_subscription_id: input.subscriptionId,
        amount_cents: input.amountCents,
        currency: input.currency,
        credits: input.credits,
        status: input.status,
      },
      { onConflict: 'external_ref', ignoreDuplicates: true },
    ),
    'Could not record the payment',
  );
}

export type PaymentRow = {
  created_at: string;
  amount_cents: number;
  currency: string;
  credits: number;
  plan_id: string | null;
  user_id: string | null;
};

export async function paymentsSince(since: Date): Promise<PaymentRow[]> {
  return must(
    await db()
      .from('payments')
      .select('created_at,amount_cents,currency,credits,plan_id,user_id')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true }),
    'Could not load payments',
  ) as PaymentRow[];
}

export async function upsertSubscription(input: {
  id: string;
  userId: string;
  planId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): Promise<void> {
  must(
    await db().from('subscriptions').upsert(
      {
        stripe_subscription_id: input.id,
        user_id: input.userId,
        plan_id: input.planId,
        status: input.status,
        current_period_end: input.currentPeriodEnd?.toISOString() ?? null,
        cancel_at_period_end: input.cancelAtPeriodEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'stripe_subscription_id' },
    ),
    'Could not record the subscription',
  );
}

/** A log of handled Stripe events. Grants are idempotent on their own; this is for auditing. */
export async function noteStripeEvent(id: string, type: string): Promise<void> {
  must(
    await db().from('stripe_events').upsert({ id, type }, { onConflict: 'id', ignoreDuplicates: true }),
    'Could not log the Stripe event',
  );
}

// --- Per-user views ----------------------------------------------------------------

export type UserPayment = {
  created_at: string;
  amount_cents: number;
  currency: string;
  credits: number;
  plan_id: string | null;
  status: string;
  stripe_subscription_id: string | null;
};

export async function paymentsForUser(userId: string): Promise<UserPayment[]> {
  return must(
    await db()
      .from('payments')
      .select('created_at,amount_cents,currency,credits,plan_id,status,stripe_subscription_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    'Could not load purchases',
  ) as UserPayment[];
}

export type UserSubscription = {
  stripe_subscription_id: string;
  plan_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export async function subscriptionsForUser(userId: string): Promise<UserSubscription[]> {
  return must(
    await db()
      .from('subscriptions')
      .select('stripe_subscription_id,plan_id,status,current_period_end,cancel_at_period_end')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
    'Could not load subscriptions',
  ) as UserSubscription[];
}

/** Every payment's owner and amount — summed per user by the caller. Fine at this scale. */
export async function allPaymentTotals(): Promise<{ user_id: string | null; amount_cents: number; currency: string }[]> {
  return must(
    await db().from('payments').select('user_id,amount_cents,currency').limit(10_000),
    'Could not load payments',
  ) as { user_id: string | null; amount_cents: number; currency: string }[];
}
