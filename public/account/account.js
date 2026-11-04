/**
 * The customer's account page: overview, profile, buying credits, billing,
 * settings and support, one section at a time from the sidebar.
 *
 * Reached from the extension's "Go to your account" or "Upgrade", which pass
 * the session in the URL fragment (#handoff=…) and optionally a section
 * (?section=buy). A fragment never reaches a server or a log; the page trades
 * it for a cookie and removes it from the address bar at once.
 */

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (cents, currency) => {
  try {
    // en-US, as on tryoncam.com: "$4.99" there must not be "US$4.99" here.
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SECTIONS = ['overview', 'profile', 'buy', 'billing', 'settings', 'support'];

async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// --- Arriving --------------------------------------------------------------------

/** Reads the handoff and the requested section, then leaves a clean #section URL. */
async function arrive() {
  const params = new URLSearchParams(location.search);
  const handoff = location.hash.match(/handoff=([^&]+)/);
  const hashSection = location.hash.slice(1);
  const section = params.get('section') ?? (SECTIONS.includes(hashSection) ? hashSection : 'overview');
  if (params.get('paid') === '1') {
    $('notice').hidden = false;
    $('notice').textContent = 'Payment received — your credits are on their way and show here within a few seconds.';
  } else if (params.get('cancelled') === '1') {
    $('notice').hidden = false;
    $('notice').classList.add('neutral');
    $('notice').textContent = 'Checkout cancelled — nothing was charged. Pick a pack whenever you are ready.';
  }
  history.replaceState(null, '', `${location.pathname}#${SECTIONS.includes(section) ? section : 'overview'}`);
  if (handoff) {
    await call('/api/auth/handoff', { method: 'POST', body: JSON.stringify({ token: decodeURIComponent(handoff[1]) }) }).catch(() => {});
  }
}

function show(section) {
  const target = SECTIONS.includes(section) ? section : 'overview';
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== target;
  for (const link of document.querySelectorAll('[data-section]')) link.classList.toggle('active', link.dataset.section === target);
  window.scrollTo(0, 0);
}

addEventListener('hashchange', () => {
  if (!$('side').hidden) show(location.hash.slice(1));
});

// --- Sign-in ---------------------------------------------------------------------

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(script);
  });
}

async function showSignIn() {
  $('signin').hidden = false;
  $('side').hidden = true;
  $('me').hidden = true;
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = true;
  const error = $('signinError');
  try {
    const settings = await call('/api/settings');
    const clientId = settings.auth?.webClientId;
    if (!clientId) throw new Error('Sign-in is not available yet.');
    await loadGis();
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        error.hidden = true;
        try {
          await call('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential, as: 'customer' }) });
          await load();
        } catch (e) {
          error.hidden = false;
          error.textContent = e.message;
        }
      },
    });
    google.accounts.id.renderButton($('googleButton'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
  } catch (e) {
    error.hidden = false;
    error.textContent = e.message;
  }
}

// --- Rendering -------------------------------------------------------------------

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

/**
 * The same pricing table as tryoncam.com, from the same endpoint, so the
 * account page and the landing page can never disagree about a price.
 */
async function renderPricing(data) {
  let pricing;
  try {
    pricing = await call('/api/public/pricing');
  } catch {
    pricing = { copy: {}, plans: data.plans };
  }
  const plans = (pricing.plans ?? []).filter((p) => p.credits > 0);
  const copy = pricing.copy ?? {};
  const hot = plans.findIndex((p) => p.badge);

  const card = (p, i) => {
    const recurring = p.mode === 'recurring';
    const label = !data.requireCredits
      ? 'Included for you'
      : !p.purchasable
        ? 'Coming soon'
        : recurring ? 'Subscribe' : `Get ${p.credits} credits`;
    return `<article class="pcard ${i === hot ? 'hot' : ''}">
      ${p.badge ? `<span class="tag">${esc(p.badge)}</span>` : ''}
      <h3>${esc(p.name)}</h3>
      <div class="amount">${money(p.amountCents, p.currency)}<small>${recurring ? `/${esc(p.interval)}` : 'once'}</small></div>
      <div class="credits"><i>${p.credits}</i>${p.credits} credits${recurring ? ` every ${esc(p.interval)}` : ''}</div>
      <ul>${[p.description, ...(p.features ?? [])].filter(Boolean).map((f) => `<li>${CHECK}<span>${esc(f)}</span></li>`).join('')}</ul>
      <button class="buy" type="button" data-plan="${esc(p.id)}" ${data.requireCredits && p.purchasable ? '' : 'disabled'}>${label}</button>
    </article>`;
  };

  const html = plans.length
    ? `<div class="pricing-head">
        <h2>${esc(copy.heading ?? 'Credit packs')}</h2>
        ${copy.lede ? `<p>${esc(copy.lede)}</p>` : ''}
        ${copy.note ? `<span class="pricing-note">${esc(copy.note)}</span>` : ''}
      </div>
      <div class="pricing-cards">${plans.map(card).join('')}</div>
      ${(copy.foot ?? []).length ? `<div class="pricing-foot">${copy.foot.map((f) => `<div><b>${esc(f.title)}</b>${esc(f.text)}</div>`).join('')}</div>` : ''}`
    : '<p class="empty-state">Credit packs are coming soon.</p>';

  for (const host of document.querySelectorAll('[data-pricing-table]')) {
    host.innerHTML = html;
    for (const button of host.querySelectorAll('[data-plan]:not([disabled])')) {
      button.addEventListener('click', async () => {
        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Opening checkout…';
        try {
          const { url } = await call('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ planId: button.dataset.plan }) });
          location.href = url;
        } catch (e) {
          button.disabled = false;
          button.textContent = label;
          alert(e.message);
        }
      });
    }
  }
}

/** Numbers count up rather than appear — a small thing that makes the page feel alive. */
function countUp(el, to) {
  if (typeof to !== 'number' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const duration = 700;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    el.textContent = String(Math.round(to * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function render(data) {
  $('signin').hidden = true;
  $('side').hidden = false;
  $('me').hidden = false;

  const { user } = data;
  for (const img of [$('meAvatar'), $('avatar')]) {
    if (user.picture) img.src = user.picture;
    else img.hidden = true;
  }
  // No Google photo: the top-right link still needs something to click.
  if (!user.picture && !document.querySelector('.avatar-link .initial')) {
    const initial = document.createElement('span');
    initial.className = 'initial';
    initial.textContent = (user.name || user.email || '?').trim()[0].toUpperCase();
    document.querySelector('.avatar-link').appendChild(initial);
  }
  $('meAvatar').title = `${user.name} · ${user.email}`;
  $('name').textContent = user.name;
  for (const id of ['email', 'email2', 'email3']) $(id).textContent = user.email;
  const since = user.memberSince ? day(user.memberSince) : '—';
  $('since').textContent = user.memberSince ? `Member since ${since}` : '';
  $('since2').textContent = since;

  // Overview
  if (data.requireCredits) {
    countUp($('ovCredits'), data.credits ?? 0);
    $('topUpCount').textContent = String(data.credits ?? 0);
  } else {
    $('ovCredits').textContent = 'Unlimited';
    $('ovCreditsNote').textContent = user.admin ? 'Operators try on for free.' : 'Try-ons are free right now.';
    $('topUp').hidden = true;
    $('ovTopUp').hidden = true;
  }
  countUp($('ovSessions'), data.usage.sessions);
  countUp($('ovMinutes'), Math.round(data.usage.seconds / 60));
  $('ovSince').textContent = since;
  $('recent').innerHTML = data.usage.recent.length
    ? data.usage.recent
        .map((r) => `<li><span>${day(r.at)}${r.site ? ` · ${esc(r.site)}` : ''}</span><span>${r.seconds}s</span></li>`)
        .join('')
    : '<li class="empty">No try-ons yet. Hover any clothing on a shopping site and click Try On.</li>';

  // Buy credits
  $('buyBalance').textContent = data.requireCredits ? `You have ${plural(data.credits ?? 0, 'credit')}.` : '';
  renderPricing(data);

  // Billing
  const subs = data.subscriptions.filter((s) => s.status !== 'incomplete_expired');
  $('subscriptionPanel').hidden = subs.length === 0;
  $('subscriptions').innerHTML = subs
    .map(
      (s) => `<p><b>${esc(s.plan ?? 'Plan')}</b><span class="status ${s.status === 'active' ? 'active' : ''}">${esc(s.status)}</span><br>
        <span class="muted">${s.renewsAt ? `${s.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${day(s.renewsAt)}` : ''}</span></p>`,
    )
    .join('');
  $('portal').hidden = !data.hasBillingPortal;
  $('purchases').innerHTML = data.purchases.length
    ? data.purchases
        .map(
          (p) => `<li><span>${day(p.at)} · ${esc(p.plan ?? 'Credits')} · ${plural(p.credits, 'credit')}${p.recurring ? ' (subscription)' : ''}</span>
            <span>${money(p.amountCents, p.currency)}</span></li>`,
        )
        .join('')
    : '<li class="empty">No purchases yet.</li>';

  // Support
  $('supportLink').href = `mailto:${data.support}`;
  $('supportLink').textContent = data.support;
  $('deleteLink').href = `mailto:${data.support}?subject=${encodeURIComponent('Delete my tryoncam account')}&body=${encodeURIComponent(`Please delete the account for ${user.email}.`)}`;

  show(location.hash.slice(1));
}

async function load() {
  try {
    render(await call('/api/account'));
  } catch (e) {
    if (e.status === 401 || e.status === 403) await showSignIn();
    else {
      $('notice').hidden = false;
      $('notice').textContent = `Could not load your account: ${e.message}`;
    }
  }
}

async function signOut() {
  await fetch('/api/auth/signout', { method: 'POST' });
  location.replace(location.pathname);
}
$('signOut').addEventListener('click', signOut);
$('signOut2').addEventListener('click', signOut);

$('portal').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    const { url } = await call('/api/billing/portal', { method: 'POST' });
    location.href = url;
  } catch (e) {
    event.currentTarget.disabled = false;
    alert(e.message);
  }
});

// FAQ search: hides non-matching questions, and whole groups left empty.
$('faqSearch').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  let shown = 0;
  for (const group of document.querySelectorAll('.faq-group')) {
    let inGroup = 0;
    for (const qa of group.querySelectorAll('.qa')) {
      const match = !query || qa.textContent.toLowerCase().includes(query);
      qa.hidden = !match;
      if (match) inGroup += 1;
      if (match && query) qa.open = true;
      if (!query) qa.open = false;
    }
    group.hidden = inGroup === 0;
    shown += inGroup;
  }
  $('faqEmpty').hidden = shown > 0;
});

$('year').textContent = String(new Date().getFullYear());
await arrive();
await load();
if (new URLSearchParams(location.search).get('paid') === '1' || $('notice').textContent.startsWith('Payment received')) {
  // Credits arrive by Stripe webhook a moment after the redirect; look again
  // so the new balance appears without a manual refresh.
  let tries = 0;
  const poll = setInterval(async () => {
    tries += 1;
    await load();
    if (tries >= 5) clearInterval(poll);
  }, 3000);
}
