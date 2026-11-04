/**
 * Users tab: every account, how much it has used, and what it has paid.
 *
 * Sessions come from the budget ledger (every session records who ran it);
 * accounts, credits and payments from the database.
 */

import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let rows = [];

function flash(message, ok = true) {
  toast(message, ok);
}

async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};

function tile(label, value, sub = '') {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${
    sub ? `<div class="tile-sub">${sub}</div>` : ''
  }</div>`;
}

function renderSummary(summary) {
  $('#userTiles').innerHTML = summary
    ? [
        tile('Users', summary.users, `${summary.newToday} joined today`),
        tile('New this week', summary.new7d, `${summary.new30d} in 30 days`),
        tile('Have tried on', summary.activeUsers, `${summary.sessions} sessions in total`),
        tile('Paying', summary.paying, summary.users ? `${Math.round((summary.paying / summary.users) * 100)}% of users` : ''),
      ].join('')
    : '';
}

function renderRows() {
  const query = $('#userSearch').value.trim().toLowerCase();
  const shown = query
    ? rows.filter((u) => `${u.name ?? ''} ${u.email}`.toLowerCase().includes(query))
    : rows;
  $('#usersHint').textContent = query ? `${shown.length} of ${rows.length}` : `${rows.length} accounts, newest activity first`;
  $('#usersTable').innerHTML = shown.length
    ? shown
        .map(
          (u) => `<tr>
          <td class="who">${
            u.picture
              ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`
              : `<span class="initial">${esc((u.name || u.email)[0].toUpperCase())}</span>`
          }<span><b>${esc(u.name ?? u.email)}${u.role === 'admin' ? ' <em class="role">admin</em>' : ''}</b><small>${esc(u.email)}</small></span></td>
          <td>${date(u.createdAt)}</td>
          <td class="num">${u.sessions}</td>
          <td class="num">${u.credits}</td>
          <td class="num">${u.purchases}</td>
          <td class="num">${u.spentUsd ? `$${u.spentUsd.toFixed(2)}` : '—'}</td>
          <td>${ago(u.lastSessionAt ?? u.lastSeenAt)}</td>
          <td class="adjust">
            <input type="number" step="1" value="1" aria-label="Credits to add or remove" data-user="${u.id}">
            <button class="btn small" type="button" data-adjust="${u.id}">Apply</button>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr class="empty-row"><td colspan="8">${rows.length ? 'Nobody matches that search.' : 'Nobody has signed in yet.'}</td></tr>`;
}

async function load() {
  const data = await call('/api/admin/users');
  rows = data.users;
  renderSummary(data.summary);
  renderRows();
  if (!data.summary) $('#usersHint').textContent = 'Database not connected';
}

export async function initUsers() {
  try {
    await load();
  } catch {
    return; // locked; the gate screen is up
  }
  $('#userSearch').addEventListener('input', renderRows);
  $('#usersTable').addEventListener('click', async (event) => {
    const id = event.target.dataset.adjust;
    if (!id) return;
    const delta = Math.round(Number(document.querySelector(`input[data-user="${id}"]`).value));
    if (!delta) return;
    event.target.disabled = true;
    try {
      await call(`/api/admin/users/${encodeURIComponent(id)}/credits`, {
        method: 'POST',
        body: JSON.stringify({ delta, note: 'Adjusted from the dashboard' }),
      });
      flash(`${delta > 0 ? 'Added' : 'Removed'} ${Math.abs(delta)} credit${Math.abs(delta) === 1 ? '' : 's'}.`);
      await load();
    } catch (error) {
      flash(`Could not adjust: ${error.message}`, false);
      event.target.disabled = false;
    }
  });
}
