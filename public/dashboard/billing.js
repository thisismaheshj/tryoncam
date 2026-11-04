/**
 * Billing tab: plans, their Stripe prices, credit rules and customers.
 *
 * Plans are edited as a whole list and saved together, so their order on
 * screen is their order in the extension and on checkout. "Check price IDs"
 * asks Stripe what each price actually charges and puts the answer next to
 * what customers are shown.
 */

import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let plans = [];
let checks = new Map();
let stripeReady = false;
/** Which plan cards are expanded. Keyed per card, so reordering keeps the state. */
const openCards = new Set();
let nextKey = 1;
const keyed = (plan) => (plan._key ??= `k${nextKey++}`, plan);

function money(cents, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
  }
}

function flash(message) {
  toast(message);
}

async function call(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

// --- Connections ------------------------------------------------------------------

function statusRow(ok, label, detail) {
  return `<div class="status-row">
    <span class="dot ${ok ? 'good' : 'bad'}" aria-hidden="true"></span>
    <b>${label}</b><span>${detail}</span>
  </div>`;
}

function renderStatus(state) {
  const { db, stripe } = state;
  $('#billingStatus').innerHTML = [
    statusRow(db.configured, 'Database', db.configured ? 'Supabase connected' : 'Set SUPABASE_URL and SUPABASE_SECRET_KEY'),
    statusRow(
      stripe.configured,
      'Stripe',
      stripe.configured ? `${stripe.mode === 'live' ? 'Live' : 'Test'} mode` : 'Set STRIPE_SECRET_KEY',
    ),
    statusRow(
      stripe.webhookConfigured,
      'Webhook',
      stripe.webhookConfigured
        ? 'Signing secret set'
        : `Add an endpoint in Stripe for <code>${esc(stripe.webhookUrl)}</code>, then set STRIPE_WEBHOOK_SECRET`,
    ),
    `<details class="events"><summary>Webhook events to subscribe</summary><code>${stripe.events.map(esc).join('<br>')}</code></details>`,
  ].join('');
}

// --- Plans ------------------------------------------------------------------------

function checkBadge(plan) {
  const check = checks.get(plan.id);
  if (!check) return '';
  if (check.ok) {
    const s = check.stripe;
    return `<div class="check ok">✓ Matches Stripe — ${esc(s.productName)}, ${money(s.unitAmount, s.currency)}
      ${s.type === 'recurring' ? `every ${esc(s.interval)}` : 'one-off'}${s.livemode ? '' : ' (test mode)'}</div>`;
  }
  return `<div class="check bad">${check.problems.map((p) => `<div>✗ ${esc(p)}</div>`).join('')}</div>`;
}

/** The one-word verdict shown on a collapsed card. */
function statusBadge(plan) {
  const check = checks.get(plan.id);
  if (!plan.stripe_price_id) return '<span class="pstatus warn">No price ID</span>';
  if (!check) return `<span class="pstatus">${stripeReady ? 'Checking…' : 'Not checked'}</span>`;
  return check.ok ? '<span class="pstatus good">✓ Matches Stripe</span>' : '<span class="pstatus bad">✗ Mismatch</span>';
}

function planCard(plan, index) {
  const recurring = plan.mode === 'recurring';
  const open = openCards.has(plan._key);
  return `<div class="plan-card ${plan.active ? '' : 'inactive'} ${open ? 'open' : ''}" data-index="${index}">
    <div class="plan-top" data-toggle role="button" tabindex="0" aria-expanded="${open}">
      <svg class="plan-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      <span class="plan-title">${esc(plan.name || 'New plan')}</span>
      ${statusBadge(plan)}
      <span class="plan-price">${money(plan.amount_cents, plan.currency)}${recurring ? ` / ${esc(plan.interval)}` : ' once'}
        · ${plan.credits} credits</span>
      <label class="inline"><input type="checkbox" data-k="active" ${plan.active ? 'checked' : ''}> On sale</label>
      <button class="icon-btn" type="button" data-move="-1" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" type="button" data-move="1" title="Move down" ${index === plans.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn danger" type="button" data-remove title="Remove">✕</button>
    </div>
    <div class="plan-body" ${open ? '' : 'hidden'}>
    <div class="plan-grid">
      <label class="field"><span>Name</span><input data-k="name" value="${esc(plan.name)}"></label>
      <label class="field"><span>ID <em>permanent</em></span><input data-k="id" value="${esc(plan.id)}" ${plan._saved ? 'readonly' : ''}></label>
      <label class="field"><span>Billing</span>
        <select data-k="mode">
          <option value="one_time" ${!recurring ? 'selected' : ''}>One-off pack</option>
          <option value="recurring" ${recurring ? 'selected' : ''}>Recurring subscription</option>
        </select>
      </label>
      <label class="field" ${recurring ? '' : 'hidden'}><span>Renews every</span>
        <select data-k="interval">
          <option value="month" ${plan.interval !== 'year' ? 'selected' : ''}>Month</option>
          <option value="year" ${plan.interval === 'year' ? 'selected' : ''}>Year</option>
        </select>
      </label>
      <label class="field"><span>Price <em>${esc(plan.currency.toUpperCase())}</em></span>
        <input data-k="price" type="number" min="0" step="0.01" value="${(plan.amount_cents / 100).toFixed(2)}"></label>
      <label class="field"><span>Currency</span><input data-k="currency" value="${esc(plan.currency)}" maxlength="3"></label>
      <label class="field"><span>Credits${recurring ? ' per renewal' : ''}</span>
        <input data-k="credits" type="number" min="1" step="1" value="${plan.credits}"></label>
      <label class="field"><span>Badge <em>optional</em></span><input data-k="badge" value="${esc(plan.badge)}" placeholder="Most popular"></label>
      <label class="field wide"><span>Stripe price ID</span>
        <input data-k="stripe_price_id" value="${esc(plan.stripe_price_id ?? '')}" placeholder="price_…" autocomplete="off"></label>
      <label class="field wide"><span>Description</span><input data-k="description" value="${esc(plan.description)}"></label>
      <label class="field wide"><span>Features <em>one per line</em></span>
        <textarea data-k="features" rows="3">${esc((plan.features ?? []).join('\n'))}</textarea></label>
    </div>
    ${checkBadge(plan)}
    </div>
  </div>`;
}

function renderPlans() {
  plans.forEach(keyed);
  const host = $('#plansEditor');
  host.innerHTML = plans.length
    ? plans.map(planCard).join('')
    : '<p class="empty">No plans yet. Add one to start selling.</p>';
}

/** Reads the form back into `plans`, so a re-render never loses an edit. */
function readForm() {
  for (const card of document.querySelectorAll('.plan-card')) {
    const plan = plans[Number(card.dataset.index)];
    const value = (k) => card.querySelector(`[data-k="${k}"]`);
    plan.name = value('name').value.trim();
    if (!plan._saved) plan.id = value('id').value.trim().toLowerCase();
    plan.mode = value('mode').value;
    plan.interval = plan.mode === 'recurring' ? value('interval').value : null;
    plan.amount_cents = Math.round(Number(value('price').value || 0) * 100);
    plan.currency = value('currency').value.trim().toLowerCase() || 'usd';
    plan.credits = Math.round(Number(value('credits').value || 0));
    plan.badge = value('badge').value.trim();
    plan.stripe_price_id = value('stripe_price_id').value.trim() || null;
    plan.description = value('description').value.trim();
    plan.features = value('features').value.split('\n').map((f) => f.trim()).filter(Boolean);
    plan.active = value('active').checked;
  }
}

function wirePlans() {
  const host = $('#plansEditor');

  // Structural edits re-render; typing does not, so focus is never lost mid-word.
  host.addEventListener('change', (event) => {
    if (!event.target.matches('[data-k="mode"], [data-k="active"], [data-k="currency"]')) return;
    readForm();
    renderPlans();
  });

  const toggle = (card) => {
    const plan = plans[Number(card.dataset.index)];
    if (openCards.has(plan._key)) openCards.delete(plan._key);
    else openCards.add(plan._key);
    card.classList.toggle('open');
    card.querySelector('.plan-body').hidden = !card.classList.contains('open');
    card.querySelector('[data-toggle]').setAttribute('aria-expanded', String(card.classList.contains('open')));
  };
  host.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-toggle]')) {
      event.preventDefault();
      toggle(event.target.closest('.plan-card'));
    }
  });

  host.addEventListener('click', (event) => {
    const card = event.target.closest('.plan-card');
    if (!card) return;
    // The header toggles, but not when the click was on a control inside it.
    if (event.target.closest('[data-toggle]') && !event.target.closest('button, input, label')) {
      toggle(card);
      return;
    }
    const index = Number(card.dataset.index);
    if (event.target.matches('[data-remove]')) {
      readForm();
      const plan = plans[index];
      if (plan._saved && !confirm(`Remove "${plan.name}"? Past payments keep their record.`)) return;
      plans.splice(index, 1);
      renderPlans();
    }
    const move = Number(event.target.dataset.move);
    if (move) {
      readForm();
      const [plan] = plans.splice(index, 1);
      plans.splice(index + move, 0, plan);
      renderPlans();
    }
  });

  $('#addPlan').addEventListener('click', () => {
    readForm();
    const fresh = keyed({
      id: `plan-${plans.length + 1}`, name: '', description: '', mode: 'one_time', interval: null,
      amount_cents: 0, currency: 'usd', credits: 10, stripe_price_id: null, badge: '', features: [], active: false,
    });
    plans.push(fresh);
    openCards.add(fresh._key); // a new plan starts open, ready to fill in
    renderPlans();
  });

  /** Saves the list as shown. Returns false (having said why) when the server refused it. */
  async function save() {
    readForm();
    try {
      const result = await call('/api/admin/plans', {
        method: 'POST',
        body: JSON.stringify({ plans: plans.map(({ _saved, ...plan }) => plan) }),
      });
      const keys = new Map(plans.map((plan) => [plan.id, plan._key]));
      plans = result.plans.map((plan) => ({ ...plan, _saved: true, _key: keys.get(plan.id) }));
      checks = new Map();
      renderPlans();
      return true;
    } catch (error) {
      flash(`Could not save: ${error.message}`);
      return false;
    }
  }

  $('#savePlans').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    if (await save()) {
      flash('Plans saved — live in the extension and on tryoncam.com now.');
      runCheck(); // every save is re-verified against Stripe
    }
    button.disabled = false;
  });

  $('#checkPlans').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Checking…';
    // Stripe is compared with what is saved, so save first: otherwise the
    // answer would describe a plan that is not the one on screen.
    if (await save()) await runCheck({ announce: true });
    button.disabled = false;
    button.textContent = 'Check price IDs with Stripe';
  });

}

// --- Price check ------------------------------------------------------------------

/**
 * Asks Stripe what each saved plan's price ID actually charges, and lays it
 * beside what the platform shows customers. Runs on opening the tab and after
 * every save, so a wrong price ID never waits for someone to think of checking.
 */
async function runCheck({ announce = false } = {}) {
  if (!stripeReady || !plans.length) {
    renderCheckTable(null);
    return;
  }
  $('#priceCheckWhen').textContent = 'Checking with Stripe…';
  try {
    const result = await call('/api/admin/plans/check', { method: 'POST' });
    checks = new Map(result.checks.map((check) => [check.planId, check]));
    readForm();
    renderPlans();
    renderCheckTable(result.checks);
    if (announce) {
      const bad = result.checks.filter((check) => !check.ok).length;
      flash(bad ? `Could not confirm ${bad} of ${result.checks.length} plans — see Price check.` : 'Every plan matches Stripe.');
    }
  } catch (error) {
    renderCheckTable(null, error.message);
  }
}

function renderCheckTable(results, error) {
  const body = $('#priceCheckTable');
  if (error) {
    $('#priceCheckWhen').textContent = '';
    body.innerHTML = `<tr class="empty-row"><td colspan="5">Could not reach Stripe: ${esc(error)}</td></tr>`;
    return;
  }
  if (!results) {
    $('#priceCheckWhen').textContent = '';
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${
      stripeReady ? 'Add a plan to check it.' : 'Connect Stripe in the Environment tab to check prices.'
    }</td></tr>`;
    return;
  }
  $('#priceCheckWhen').textContent = `Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  body.innerHTML = results
    .map((check) => {
      const plan = plans.find((p) => p.id === check.planId);
      const platform = plan
        ? `${money(plan.amount_cents, plan.currency)} · ${plan.mode === 'recurring' ? `every ${esc(plan.interval)}` : 'one-off'}`
        : '—';
      const stripe = check.stripe
        ? `${check.stripe.unitAmount === null ? 'no fixed amount' : money(check.stripe.unitAmount, check.stripe.currency)} · ${
            check.stripe.type === 'recurring' ? `every ${esc(check.stripe.interval)}` : 'one-off'
          }${check.stripe.livemode ? '' : ' · test'}<br><small class="muted">${esc(check.stripe.productName)}</small>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><b>${esc(plan?.name ?? check.planId)}</b></td>
        <td>${platform}</td>
        <td>${stripe}</td>
        <td><code class="price-id">${esc(check.priceId ?? 'none')}</code></td>
        <td>${
          check.ok
            ? '<span class="pstatus good">✓ Right</span>'
            : `<span class="pstatus bad">✗ Wrong</span><div class="check-why">${check.problems.map(esc).join('<br>')}</div>`
        }</td>
      </tr>`;
    })
    .join('');
}

// --- Credit rules -----------------------------------------------------------------

function wireCreditRules(settings) {
  $('#signupCredits').value = String(settings.signupCredits);
  $('#requireCredits').checked = settings.requireCredits;
  $('#saveBillingSettings').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await call('/api/admin/billing-settings', {
        method: 'POST',
        body: JSON.stringify({
          signupCredits: Number($('#signupCredits').value),
          requireCredits: $('#requireCredits').checked,
        }),
      });
      $('#signupCredits').value = String(result.billing.signupCredits);
      flash('Credit rules saved.');
    } catch (error) {
      flash(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
}

// --- Entry ------------------------------------------------------------------------

export async function initBilling() {
  let state;
  try {
    state = await call('/api/admin/billing');
  } catch {
    return; // locked; the gate screen is up
  }
  renderStatus(state);
  wireCreditRules(state.settings);
  plans = state.plans.map((plan) => ({ ...plan, _saved: true }));
  stripeReady = state.stripe.configured;
  renderPlans();
  wirePlans();
  runCheck(); // not awaited: the tab is usable while Stripe answers
  await initPricingCopy();
}

// --- Pricing page copy --------------------------------------------------------------

async function initPricingCopy() {
  const { settings } = await call('/api/admin/settings').then((s) => ({ settings: s })).catch(() => ({ settings: null }));
  if (!settings?.pricing) return;
  const pricing = settings.pricing;
  const fields = document.querySelectorAll('[data-p]');
  for (const input of fields) {
    const value = pricing[input.dataset.p];
    if (input.type === 'checkbox') input.checked = value !== false;
    else input.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
  }
  const foot = [...(pricing.foot ?? [])];
  while (foot.length < 3) foot.push({ title: '', text: '' });
  $('#pricingFoot').innerHTML = foot
    .slice(0, 3)
    .map(
      (f, i) => `<div class="foot-row">
        <input data-foot="${i}" data-k="title" value="${esc(f.title)}" placeholder="Title">
        <input data-foot="${i}" data-k="text" value="${esc(f.text)}" placeholder="One line underneath">
      </div>`,
    )
    .join('');

  $('#savePricing').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const next = {};
    for (const input of fields) {
      next[input.dataset.p] = input.type === 'checkbox' ? input.checked : input.value;
    }
    next.freeFeatures = String(next.freeFeatures).split('\n');
    next.foot = [0, 1, 2].map((i) => ({
      title: document.querySelector(`[data-foot="${i}"][data-k="title"]`).value,
      text: document.querySelector(`[data-foot="${i}"][data-k="text"]`).value,
    }));
    try {
      await call('/api/admin/settings', { method: 'POST', body: JSON.stringify({ pricing: next }) });
      flash('Pricing page saved — tryoncam.com shows it within a minute.');
    } catch (error) {
      flash(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
}
