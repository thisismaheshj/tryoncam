import Stripe from 'stripe';
import { config } from './config.js';
import {
  type DbUser, grantCredits, noteStripeEvent, type Plan, recordPayment, setStripeCustomer, upsertSubscription,
} from './db.js';

/**
 * Stripe: checkout, price verification and the webhook that turns a payment
 * into credits.
 *
 * The rule this module exists to enforce: **a customer is never charged a
 * price that differs from the one they were shown.** The dashboard can check
 * every plan against Stripe on demand, and checkout re-checks the one plan
 * being bought and refuses on any mismatch — a wrong price ID pasted into the
 * dashboard fails loudly instead of billing somebody the wrong amount.
 */

export class BillingError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return config.stripe.secretKey !== '';
}

export function stripeMode(): 'test' | 'live' | null {
  const key = config.stripe.secretKey;
  if (!key) return null;
  return /^(sk|rk)_live_/.test(key) ? 'live' : 'test';
}

/** Called when the key changes from the dashboard, so the next call uses the new one. */
export function resetStripeClient(): void {
  client = null;
}

function stripe(): Stripe {
  if (!stripeConfigured()) throw new BillingError('Stripe is not configured: set STRIPE_SECRET_KEY.', 503);
  client ??= new Stripe(config.stripe.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  return client;
}

// --- Price verification ---------------------------------------------------------

/** The parts of a Stripe price that decide what a customer pays. */
export type PriceFacts = {
  unitAmount: number | null;
  currency: string;
  type: 'one_time' | 'recurring';
  interval: string | null;
  intervalCount: number | null;
  active: boolean;
  productActive: boolean;
  productName: string;
  livemode: boolean;
};

export type PlanCheck = {
  planId: string;
  priceId: string | null;
  ok: boolean;
  problems: string[];
  stripe: PriceFacts | null;
};

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function describeBilling(mode: 'one_time' | 'recurring', interval: string | null): string {
  return mode === 'one_time' ? 'one-off' : `recurring every ${interval}`;
}

/**
 * Every way a Stripe price can disagree with the plan shown to customers.
 * Pure, so the rules are tested without a network.
 */
export function comparePlanToPrice(plan: Plan, price: PriceFacts): string[] {
  const problems: string[] = [];
  if (price.unitAmount === null) {
    problems.push('The Stripe price has no fixed amount (tiered or customer-chosen). Only fixed prices are supported.');
  } else if (price.unitAmount !== plan.amount_cents || price.currency !== plan.currency.toLowerCase()) {
    problems.push(
      `Amount: customers are shown ${formatMoney(plan.amount_cents, plan.currency)}, ` +
        `Stripe would charge ${formatMoney(price.unitAmount, price.currency)}.`,
    );
  }

  if (price.type !== plan.mode) {
    problems.push(
      `Billing: the plan is ${describeBilling(plan.mode, plan.interval)}, ` +
        `the Stripe price is ${describeBilling(price.type, price.interval)}.`,
    );
  } else if (plan.mode === 'recurring') {
    if (price.interval !== plan.interval) {
      problems.push(`Interval: the plan renews every ${plan.interval}, the Stripe price every ${price.interval}.`);
    }
    if (price.intervalCount !== null && price.intervalCount !== 1) {
      problems.push(`Stripe bills every ${price.intervalCount} ${price.interval}s; plans support a single month or year.`);
    }
  }

  if (!price.active) problems.push('The Stripe price is archived, so checkout would fail.');
  if (!price.productActive) problems.push(`The Stripe product "${price.productName}" is archived.`);
  return problems;
}

async function priceFacts(priceId: string): Promise<PriceFacts> {
  const price = await stripe().prices.retrieve(priceId, { expand: ['product'] });
  const product = price.product as Stripe.Product | Stripe.DeletedProduct | string;
  const live =
    typeof product === 'object' && !(product as { deleted?: boolean }).deleted ? (product as Stripe.Product) : null;
  return {
    unitAmount: price.unit_amount,
    currency: price.currency,
    type: price.type === 'recurring' ? 'recurring' : 'one_time',
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    active: price.active,
    productActive: live?.active ?? false,
    productName: live?.name ?? (typeof product === 'string' ? product : 'a deleted product'),
    livemode: price.livemode,
  };
}

function lookupProblem(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'resource_missing') {
    return `Stripe has no price with this ID in ${stripeMode()} mode. A ${stripeMode() === 'test' ? 'live' : 'test'}-mode ID used with a ${stripeMode()} key looks exactly like this.`;
  }
  return `Stripe refused the lookup: ${error instanceof Error ? error.message : String(error)}`;
}

export async function checkPlan(plan: Plan): Promise<PlanCheck> {
  const priceId = plan.stripe_price_id?.trim() || null;
  if (!priceId) {
    return { planId: plan.id, priceId: null, ok: false, problems: ['No Stripe price ID set, so it cannot be bought.'], stripe: null };
  }
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
    return {
      planId: plan.id,
      priceId,
      ok: false,
      problems: ['That is not a price ID. It should start with "price_"; a "prod_" ID is the product, not its price.'],
      stripe: null,
    };
  }
  try {
    const facts = await priceFacts(priceId);
    const problems = comparePlanToPrice(plan, facts);
    return { planId: plan.id, priceId, ok: problems.length === 0, problems, stripe: facts };
  } catch (error) {
    return { planId: plan.id, priceId, ok: false, problems: [lookupProblem(error)], stripe: null };
  }
}

export async function checkPlans(plans: Plan[]): Promise<PlanCheck[]> {
  return Promise.all(plans.map(checkPlan));
}

// --- Checkout -------------------------------------------------------------------

export async function createCheckout(user: DbUser, plan: Plan): Promise<string> {
  if (!plan.active) throw new BillingError('That plan is not on sale.', 404);

  // Re-checked at the moment of sale, not only when the operator last pressed
  // "Check with Stripe" — a price can be archived or edited in Stripe since.
  const check = await checkPlan(plan);
  if (!check.ok) {
    console.error(`[billing] refusing checkout for ${plan.id}: ${check.problems.join(' | ')}`);
    throw new BillingError('This pack is temporarily unavailable. Please try again later.', 409);
  }

  let customer = user.stripe_customer_id;
  if (!customer) {
    const created = await stripe().customers.create({
      email: user.email,
      name: user.name ?? undefined,
      metadata: { user_id: user.id },
    });
    customer = created.id;
    await setStripeCustomer(user.id, customer);
  }

  // The credit count travels with the purchase, so editing a plan later never
  // changes what somebody already paid for.
  const metadata = { user_id: user.id, plan_id: plan.id, credits: String(plan.credits) };
  const recurring = plan.mode === 'recurring';

  const session = await stripe().checkout.sessions.create({
    mode: recurring ? 'subscription' : 'payment',
    customer,
    client_reference_id: user.id,
    line_items: [{ price: plan.stripe_price_id!, quantity: 1 }],
    metadata,
    ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
    // Back to the account page either way: paid lands on Overview with the new
    // balance, and Stripe's back arrow returns to the packs they were choosing.
    success_url: `${config.publicUrl}/account/?section=overview&paid=1`,
    cancel_url: `${config.publicUrl}/account/?section=buy&cancelled=1`,
  });
  if (!session.url) throw new BillingError('Stripe returned no checkout URL.', 502);
  return session.url;
}

/** Stripe's hosted page for managing a subscription or viewing receipts. */
export async function createPortal(user: DbUser): Promise<string> {
  if (!user.stripe_customer_id) throw new BillingError('No purchases yet.', 404);
  const session = await stripe().billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${config.publicUrl}/account/?section=billing`,
  });
  return session.url;
}

// --- Webhook --------------------------------------------------------------------

export function webhookConfigured(): boolean {
  return config.stripe.webhookSecret !== '';
}

/** The field moved in 2025 API versions; accept either shape. */
function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const loose = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const value = loose.parent?.subscription_details?.subscription ?? loose.subscription ?? null;
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const userId = subscription.metadata?.user_id;
  if (!userId) return; // not created by our checkout
  const loose = subscription as unknown as { current_period_end?: number };
  const periodEnd = loose.current_period_end ?? subscription.items?.data?.[0]?.current_period_end ?? null;
  await upsertSubscription({
    id: subscription.id,
    userId,
    planId: subscription.metadata?.plan_id ?? null,
    status: subscription.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

async function fulfilCheckout(session: Stripe.Checkout.Session): Promise<string> {
  if (session.mode === 'subscription') {
    // Credits for subscriptions arrive with each paid invoice, including the
    // first — granting here as well would pay out twice.
    const id = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (id) await syncSubscription(await stripe().subscriptions.retrieve(id));
    return 'subscription recorded; credits follow invoice.paid';
  }
  // Bank debits and similar settle later and arrive as async_payment_succeeded.
  if (session.payment_status !== 'paid') return `payment ${session.payment_status}; waiting`;

  const userId = session.metadata?.user_id ?? session.client_reference_id ?? null;
  const credits = Number(session.metadata?.credits ?? 0);
  const planId = session.metadata?.plan_id ?? null;
  if (!userId || !(credits > 0)) return 'not one of our checkouts; ignored';

  const granted = await grantCredits({
    userId,
    delta: credits,
    reason: 'purchase',
    ref: session.id,
    note: `${planId ?? 'pack'} via Checkout`,
  });
  await recordPayment({
    userId,
    planId,
    ref: session.id,
    subscriptionId: null,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    credits,
    status: 'paid',
  });
  return granted ? `granted ${credits} credits` : 'already granted';
}

async function fulfilInvoice(invoice: Stripe.Invoice): Promise<string> {
  const subscriptionId = subscriptionIdOf(invoice);
  if (!subscriptionId) return 'not a subscription invoice; ignored';

  const subscription = await stripe().subscriptions.retrieve(subscriptionId);
  await syncSubscription(subscription);
  const userId = subscription.metadata?.user_id;
  const credits = Number(subscription.metadata?.credits ?? 0);
  if (!userId || !(credits > 0)) return 'subscription not created by our checkout; ignored';
  if (!invoice.id) return 'invoice has no id; ignored';

  const renewal = invoice.billing_reason !== 'subscription_create';
  const granted = await grantCredits({
    userId,
    delta: credits,
    reason: renewal ? 'subscription_renewal' : 'purchase',
    ref: invoice.id,
    note: `${subscription.metadata?.plan_id ?? 'plan'} ${renewal ? 'renewal' : 'first payment'}`,
  });
  await recordPayment({
    userId,
    planId: subscription.metadata?.plan_id ?? null,
    ref: invoice.id,
    subscriptionId,
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    credits,
    status: 'paid',
  });
  return granted ? `granted ${credits} credits` : 'already granted';
}

/**
 * Verifies and applies one webhook delivery.
 *
 * Signature verification needs the exact bytes Stripe sent, which is why the
 * route is mounted with a raw body parser ahead of the JSON one. Every grant is
 * idempotent on the Stripe object's id, so a retried delivery is harmless.
 */
export async function handleWebhook(raw: Buffer, signature: string): Promise<{ type: string; result: string }> {
  if (!webhookConfigured()) throw new BillingError('STRIPE_WEBHOOK_SECRET is not set.', 503);
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, signature, config.stripe.webhookSecret);
  } catch (error) {
    throw new BillingError(`Webhook signature did not verify: ${error instanceof Error ? error.message : error}`, 400);
  }

  let result = 'ignored';
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      result = await fulfilCheckout(event.data.object as Stripe.Checkout.Session);
      break;
    case 'invoice.paid':
      result = await fulfilInvoice(event.data.object as Stripe.Invoice);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object as Stripe.Subscription);
      result = 'subscription synced';
      break;
    default:
      break;
  }
  await noteStripeEvent(event.id, event.type);
  return { type: event.type, result };
}

/** What the dashboard needs to know about the Stripe connection. */
export function stripeStatus() {
  return {
    configured: stripeConfigured(),
    mode: stripeMode(),
    webhookConfigured: webhookConfigured(),
    webhookUrl: `${config.publicUrl}/api/stripe/webhook`,
    events: [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'invoice.paid',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ],
  };
}
