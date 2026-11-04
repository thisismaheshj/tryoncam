import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';

const { comparePlanToPrice } = await import('../src/billing.js');
type Plan = import('../src/db.js').Plan;
type PriceFacts = import('../src/billing.js').PriceFacts;

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'starter', name: 'Starter', description: '', mode: 'one_time', interval: null, amount_cents: 499,
  currency: 'usd', credits: 10, stripe_price_id: 'price_123', badge: '', features: [], active: true, sort: 0, ...over,
});

const price = (over: Partial<PriceFacts> = {}): PriceFacts => ({
  unitAmount: 499, currency: 'usd', type: 'one_time', interval: null, intervalCount: null,
  active: true, productActive: true, productName: 'Starter pack', livemode: false, ...over,
});

describe('a Stripe price against the plan customers are shown', () => {
  test('matches when amount, currency and billing agree', () => {
    assert.deepEqual(comparePlanToPrice(plan(), price()), []);
  });

  test('catches a different amount, naming both', () => {
    const [problem] = comparePlanToPrice(plan(), price({ unitAmount: 599 }));
    assert.match(problem!, /\$4\.99/);
    assert.match(problem!, /\$5\.99/);
  });

  test('catches the same number in a different currency', () => {
    assert.equal(comparePlanToPrice(plan(), price({ currency: 'eur' })).length, 1);
  });

  test('catches a recurring price behind a one-off pack', () => {
    const problems = comparePlanToPrice(plan(), price({ type: 'recurring', interval: 'month', intervalCount: 1 }));
    assert.match(problems.join(' '), /one-off.*recurring/);
  });

  test('catches a yearly price behind a monthly plan', () => {
    const monthly = plan({ mode: 'recurring', interval: 'month' });
    const problems = comparePlanToPrice(monthly, price({ type: 'recurring', interval: 'year', intervalCount: 1 }));
    assert.match(problems.join(' '), /every month.*every year/);
  });

  test('catches a quarterly price, which plans cannot express', () => {
    const monthly = plan({ mode: 'recurring', interval: 'month' });
    const problems = comparePlanToPrice(monthly, price({ type: 'recurring', interval: 'month', intervalCount: 3 }));
    assert.equal(problems.length, 1);
  });

  test('accepts a matching monthly subscription', () => {
    const monthly = plan({ mode: 'recurring', interval: 'month' });
    assert.deepEqual(comparePlanToPrice(monthly, price({ type: 'recurring', interval: 'month', intervalCount: 1 })), []);
  });

  test('catches an archived price or product', () => {
    assert.equal(comparePlanToPrice(plan(), price({ active: false })).length, 1);
    assert.equal(comparePlanToPrice(plan(), price({ productActive: false })).length, 1);
  });

  test('refuses a price with no fixed amount', () => {
    assert.equal(comparePlanToPrice(plan(), price({ unitAmount: null })).length, 1);
  });
});
