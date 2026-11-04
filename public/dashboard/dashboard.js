import { initAuth } from './auth.js';
import { initBilling } from './billing.js';
import { initEnvironment } from './env.js';
import { initUsers } from './users.js';
import { fillRunControls, initSettings } from './settings.js';
import { initWebsite } from './website.js';
import { initAssets } from './assets.js';
import { attachHover, lineChart } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const usd4 = (n) => `$${Number(n ?? 0).toFixed(4)}`;
const int = (n) => Math.round(Number(n ?? 0)).toLocaleString();
const secs = (n) => `${Math.round(Number(n ?? 0))}s`;

/** Each chart is one series, with its own scale and its own hue. */
const METRICS = {
  sessions: { color: 'series-sessions', format: int, total: (t) => int(t.sessions) },
  credits: { color: 'series-credits', format: int, total: (t) => int(t.credits) },
  spentUsd: { color: 'series-spent', format: usd, total: (t) => usd(t.spentUsd) },
  earnedUsd: { color: 'series-earned', format: usd, total: (t) => usd(t.earnedUsd) },
};

let data = null;

function banner(message) {
  const el = $('#banner');
  el.hidden = !message;
  if (message) el.textContent = message;
}

// --- Tabs -------------------------------------------------------------------

/**
 * Five groups in the top bar, each page a sub-tab. Pages keep their old names,
 * so #settings, #billing and every data-goto link still land where they did.
 */
const GROUPS = {
  overview: [['overview', 'Overview']],
  customers: [['users', 'Accounts'], ['sessions', 'Sessions']],
  money: [['costs', 'Decart & costs'], ['billing', 'Plans & payments']],
  content: [['website', 'Website'], ['extension', 'Extension'], ['assets', 'Brand assets']],
  system: [['settings', 'Run controls'], ['providers', 'Providers'], ['environment', 'Environment']],
};
const groupOf = (page) => Object.keys(GROUPS).find((group) => GROUPS[group].some(([id]) => id === page));
/** The page each group last showed, so switching groups comes back to it. */
const lastPage = {};

function selectTab(name) {
  const group = groupOf(name) ?? 'overview';
  const page = groupOf(name) ? name : 'overview';
  lastPage[group] = page;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.group === group));
  const pages = GROUPS[group];
  const sub = $('#subtabs');
  sub.hidden = pages.length < 2;
  sub.innerHTML = pages
    .map(([id, label]) => `<button class="subtab" role="tab" data-page="${id}" aria-selected="${id === page}">${label}</button>`)
    .join('');
  for (const panel of $$('.panel')) panel.hidden = panel.dataset.panel !== page;
  if (location.hash.slice(1) !== page) history.replaceState(null, '', `#${page}`);
}

for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => selectTab(lastPage[tab.dataset.group] ?? GROUPS[tab.dataset.group][0][0]));
}
$('#subtabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (button) selectTab(button.dataset.page);
});
addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
// In-page links between tabs ("managed in the Environment tab").
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-goto]');
  if (!link) return;
  event.preventDefault();
  selectTab(link.dataset.goto);
  scrollTo({ top: 0 });
});

// --- Rendering --------------------------------------------------------------

function tile(label, value, sub, tone = '') {
  return `<div class="tile">
    <div class="tile-label">${label}</div>
    <div class="tile-value ${tone}">${value}</div>
    ${sub ? `<div class="tile-sub">${sub}</div>` : ''}
  </div>`;
}

const rangeLabel = () => `last ${data.days} day${data.days === 1 ? '' : 's'}`;
const credits = (n) => `${int(n)} credit${Math.round(n) === 1 ? '' : 's'}`;
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Money in and out of the Decart account, and what customers are still owed. */
function renderAccount() {
  const a = data.account;
  if (!a) return;
  const { decart, rate, customers, needed, coverage, runway } = a;
  const live = decart.status === 'live';

  const balanceTile = live
    ? tile('Decart balance', credits(decart.credits), `${usd(decart.usd)} · live from Decart at ${timeOf(decart.fetchedAt)}`)
    : decart.status === 'not_connected'
      ? tile('Decart balance', 'Not connected', '<a href="#environment" class="link" data-goto="environment">Connect it in System → Environment</a>', 'warn')
      : tile('Decart balance', decart.status === 'expired' ? 'Session expired' : 'Unavailable',
          `${escapeHtml(decart.message)} <a href="#environment" class="link" data-goto="environment">Fix</a>`, 'bad');

  const owed = customers
    ? tile('Owed to customers', credits(customers.outstanding),
        `${int(customers.holding)} of ${int(customers.accounts)} customer${customers.accounts === 1 ? '' : 's'} hold credits`)
    : tile('Owed to customers', '—', 'Customer database not connected');

  const need = needed
    ? tile('Decart credits to honour them', credits(needed.credits), `${usd(needed.usd)} · ${int(customers.outstanding)} × ${int(rate.creditsPerSession)} per session`)
    : tile('Decart credits to honour them', '—', '');

  const cover = coverage
    ? coverage.credits >= 0
      ? tile('Balance after honouring them', credits(coverage.credits), `${usd(coverage.usd)} to spare`, 'good')
      : tile('Short by', credits(-coverage.credits), `top up at least ${usd(-coverage.usd)} at platform.decart.ai`, 'bad')
    : tile('Balance after honouring them', '—', live ? '' : 'Needs the live balance');

  const limitedBy = runway.balanceSessions === null
    ? `the spending cap allows ${int(runway.capSessions)}`
    : runway.balanceSessions <= runway.capSessions
      ? `the balance runs out first · the cap would allow ${int(runway.capSessions)}`
      : `the spending cap stops first · the balance would pay for ${int(runway.balanceSessions)}`;
  const runwayTone = runway.sessions < 20 ? 'bad' : runway.sessions < 100 ? 'warn' : 'good';

  $('#accountTiles').innerHTML = [
    balanceTile,
    tile('Try-ons left', int(runway.sessions), limitedBy, runwayTone),
    owed,
    need,
    cover,
  ].join('');
  $('#accountHint').textContent = `1 try-on = up to ${rate.sessionSeconds}s = ${int(rate.creditsPerSession)} Decart credits (${usd4(rate.usdPerSession)})`;
  $('#accountNote').innerHTML = `Decart sells credits at $0.01 each and charges $${rate.usdPerSecond}/second. Customer credits are priced at a
    full-length session, since that is what each one entitles a customer to. Admin accounts (${int(customers?.adminCredits ?? 0)} credits) try on free and are left out.`;
}

function renderTiles() {
  const { totals } = data;
  const margin = totals.earnedUsd - totals.spentUsd;
  $('#rangeTitle').textContent = `Last ${data.days} day${data.days === 1 ? '' : 's'}`;
  $('#tiles').innerHTML = [
    tile('Try-ons', int(totals.sessions), `${int(totals.attempts)} attempts · ${int(totals.failedAttempts)} never started`),
    tile('Decart credits used', int(totals.credits), `${secs(totals.billedSeconds)} of stream`),
    tile('Spent at Decart', usd(totals.spentUsd), totals.sessions ? `${usd4(totals.spentUsd / totals.sessions)} per try-on` : 'no try-ons'),
    tile('Earned', usd(totals.earnedUsd), `${int(totals.purchases)} purchase${totals.purchases === 1 ? '' : 's'}`),
    tile('Earned − spent', `${margin < 0 ? '−' : ''}${usd(Math.abs(margin))}`, 'before Stripe fees', margin < 0 ? 'bad' : 'good'),
    tile('Avg first frame', totals.averageTtffMs ? `${int(totals.averageTtffMs)} ms` : '—', 'connect → generating'),
  ].join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderCharts() {
  for (const figure of $$('.chart')) {
    const metric = figure.dataset.metric;
    const spec = METRICS[metric];
    const points = data.series.map((day) => ({ date: day.date, value: day[metric] ?? 0 }));

    $('[data-role="total"]', figure).textContent = spec.total(data.totals);

    const host = $('[data-role="host"]', figure);
    const tip = $('.chart-tip', host);
    // Render at the host's actual width so the viewBox maps 1:1 to pixels.
    const chart = lineChart({
      points,
      color: spec.color,
      format: spec.format,
      width: Math.max(host.clientWidth || 600, 280),
    });
    host.innerHTML = chart.svg;
    host.appendChild(tip);
    attachHover(host, chart, spec.format);
  }
}

function renderSeriesTable() {
  $('#seriesTable').innerHTML = [...data.series]
    .reverse()
    .map(
      (day) => `<tr>
        <td>${day.date}</td>
        <td class="num">${int(day.sessions)}</td>
        <td class="num">${int(day.credits)}</td>
        <td class="num">${secs(day.billedSeconds)}</td>
        <td class="num">${usd(day.spentUsd)}</td>
        <td class="num">${usd(day.earnedUsd)}</td>
      </tr>`,
    )
    .join('');
}

function renderSessions() {
  const rows = data.recent;
  $('#sessionsHint').textContent = `${rows.length} most recent`;
  $('#sessionsTable').innerHTML = rows.length
    ? rows
        .map((entry) => {
          const when = new Date(entry.endedAt);
          const billed = `${entry.billedSeconds}s${entry.estimated ? ' <span class="est">est</span>' : ''}`;
          return `<tr>
            <td>${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
            <td>${entry.provider}</td>
            <td><span class="pill ${entry.status}">${entry.status}</span></td>
            <td class="num">${billed}</td>
            <td class="num">${usd4(entry.usd)}</td>
            <td class="num">${entry.timeToFirstFrameMs ? `${int(entry.timeToFirstFrameMs)} ms` : '—'}</td>
            <td>${entry.note ? String(entry.note).slice(0, 70) : ''}</td>
          </tr>`;
        })
        .join('')
    : '<tr class="empty-row"><td colspan="7">No sessions yet.</td></tr>';
}

function renderCosts() {
  const { providers, totals } = data;
  const perSession = totals.sessions ? totals.spentUsd / totals.sessions : 0;
  const decart = providers.find((p) => p.id === 'decart');

  $('#costTiles').innerHTML = [
    tile('Spent at Decart', usd(totals.spentUsd), rangeLabel()),
    tile('Cost per try-on', usd4(perSession), `${int(totals.sessions)} billed try-ons · ${rangeLabel()}`),
    tile('Seconds billed', secs(totals.billedSeconds), 'only on-stream time bills'),
    tile('Wasted attempts', int(totals.failedAttempts), 'refused or failed — cost nothing'),
    tile('Spending cap left', secs(decart?.remainingSeconds ?? 0), `of ${secs(decart?.budgetSeconds ?? 0)}, all time`),
  ].join('');

  // Only providers that can run or have run; a switched-off provider with no spend is noise.
  $('#budgetBars').innerHTML = providers
    .filter((p) => p.selectable || p.billedSeconds > 0)
    .map((p) => {
      const pct = p.budgetSeconds ? Math.min(100, (p.billedSeconds / p.budgetSeconds) * 100) : 0;
      const tone = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
      return `<div class="budget-row">
        <div class="budget-top">
          <span class="budget-name">${p.displayName ?? p.id}</span>
          <span class="budget-figures">${usd(p.spentUsd)} of ${usd(p.budgetUsd)} cap · ${secs(p.remainingSeconds)} left</span>
        </div>
        <div class="bar ${tone}"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>`;
    })
    .join('');
}

function renderProviders() {
  $('#providerCards').innerHTML = data.providers
    .map(
      (p) => `<div class="card">
        <div class="prov-head">
          <span class="prov-name">${p.id}</span>
          <span class="prov-rate">$${p.usdPerSecond}/sec</span>
        </div>
        <div class="bar"><i style="width:${p.budgetSeconds ? Math.min(100, (p.billedSeconds / p.budgetSeconds) * 100).toFixed(1) : 0}%"></i></div>
        <div class="prov-stats">
          <div class="prov-stat"><b>${int(p.sessions)}</b><span>sessions</span></div>
          <div class="prov-stat"><b>${secs(p.billedSeconds)}</b><span>billed</span></div>
          <div class="prov-stat"><b>${usd(p.spentUsd)}</b><span>spent</span></div>
          <div class="prov-stat"><b>${secs(p.remainingSeconds)}</b><span>remaining</span></div>
        </div>
      </div>`,
    )
    .join('');
}

async function load(options = {}) {
  const days = Number($('#range').value);
  try {
    const response = await fetch(`/api/analytics?days=${days}${options.freshBalance ? '&fresh=1' : ''}`);
    if (response.status === 401) {
      // The gate is up. Say so rather than leaving empty cards on screen.
      banner('Locked — unlock the dashboard to see figures.');
      return;
    }
    data = await response.json();
    banner(null);
    renderAccount();
    renderTiles();
    renderCharts();
    renderSeriesTable();
    renderSessions();
    renderCosts();
    renderProviders();
    fillRunControls(data);
  } catch (error) {
    // "Is npm run dev running?" was the localhost-era hint. In production this
    // is nearly always the network between this browser and the server.
    banner(
      location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? `Cannot reach the backend: ${error.message}. Is "npm run dev" running?`
        : "Can't reach the tryoncam server from this network. Check your internet connection, VPN or firewall, then reload.",
    );
  }
}

$('#range').addEventListener('change', load);
$('#refreshBalance').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await load({ freshBalance: true });
  } finally {
    button.disabled = false;
  }
});
// Re-lay the SVGs when the container width changes.
addEventListener('resize', () => data && renderCharts());

selectTab(location.hash.slice(1) || 'overview');
// Brand assets are public files, so they load without waiting for sign-in.
initAssets();
await initAuth({ onSignedIn: () => load() });
await load();
await initSettings({ onRunChange: load });
initWebsite();
await initBilling();
await initUsers();
await initEnvironment({ onChange: load });
setInterval(load, 15000);
