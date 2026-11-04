/**
 * Environment tab: production keys and limits, changed without a redeploy.
 *
 * Secrets are write-only from here. The server returns a masked hint
 * (rk_live_…abcd) and never the value, so the input for a secret always
 * starts empty: typing replaces the key, leaving it empty changes nothing.
 */

import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SOURCE_LABEL = {
  dashboard: 'Set here',
  vercel: 'From Vercel',
  default: 'Default',
  unset: 'Not set',
};

let state = null;
let onChangeHook = null;

function flash(message, ok = true) {
  toast(message, ok);
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

const when = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function row(item) {
  const secret = item.kind === 'secret';
  const disabled = state.canEdit && state.available ? '' : 'disabled';
  const current = secret
    ? item.hint ? `<code>${esc(item.hint)}</code>` : '<span class="muted">not set</span>'
    : `<code>${esc(item.value)}</code>`;
  const input = secret
    ? `<input type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste a new value to replace it" ${disabled}>`
    : `<input type="number" value="${esc(item.value)}" ${item.min !== null ? `min="${item.min}"` : ''} ${item.max !== null ? `max="${item.max}"` : ''} step="any" ${disabled}>`;
  return `<div class="env-row" data-name="${esc(item.name)}">
    <div class="env-meta">
      <div class="env-title"><b>${esc(item.label)}</b> <code class="env-name">${esc(item.name)}</code>
        <span class="source ${item.source}">${SOURCE_LABEL[item.source] ?? item.source}</span></div>
      <div class="env-help">${esc(item.help)}</div>
      <div class="env-current">Now: ${current}${
        item.updatedBy ? ` <span class="muted">· changed by ${esc(item.updatedBy)}, ${when(item.updatedAt)}</span>` : ''
      }${item.unreadable ? ' <span class="warn-text">· saved value cannot be decrypted on this server</span>' : ''}</div>
    </div>
    <div class="env-edit">
      ${input}
      <button class="btn small primary" type="button" data-save ${disabled}>${secret ? 'Test & save' : 'Save'}</button>
      ${item.source === 'dashboard' ? `<button class="btn small" type="button" data-clear ${disabled}>Use Vercel value</button>` : ''}
    </div>
  </div>`;
}

function render() {
  const lock = $('#envLock');
  if (!state.available) {
    lock.hidden = false;
    lock.textContent = 'Editing is off: CONFIG_ENCRYPTION_KEY is not set on Vercel, so there is nowhere safe to keep keys.';
  } else if (!state.canEdit) {
    lock.hidden = false;
    lock.textContent =
      'You are signed in with the shared password, which can view these but not change them. ' +
      'Sign in with an admin Google account to change keys — every change is logged under that name.';
  } else {
    lock.hidden = true;
  }

  for (const card of document.querySelectorAll('[data-env-group]')) {
    const items = state.values.filter((item) => item.group === card.dataset.envGroup);
    $('.env-rows', card).innerHTML = items.map(row).join('');
  }

  $('#envReadonly').innerHTML = state.vercelOnly
    .map(
      (item) => `<div class="status-row">
        <span class="dot ${item.set ? 'good' : 'bad'}" aria-hidden="true"></span>
        <b><code>${esc(item.name)}</code></b>
        <span>${item.display ? `<code>${esc(item.display)}</code> · ` : item.set ? 'set · ' : '<b>not set</b> · '}${esc(item.why)}</span>
      </div>`,
    )
    .join('');

  $('#envAudit').innerHTML = state.audit.length
    ? state.audit
        .map(
          (entry) => `<tr>
          <td>${when(entry.at)}</td>
          <td>${esc(entry.by)}</td>
          <td><code>${esc(entry.name)}</code></td>
          <td>${entry.action === 'set' ? `set to <code>${esc(entry.hint)}</code>` : `back to Vercel's <code>${esc(entry.hint || 'unset')}</code>`}</td>
        </tr>`,
        )
        .join('')
    : '<tr class="empty-row"><td colspan="4">No changes made here yet.</td></tr>';
}

async function reload() {
  state = await call('/api/admin/env');
  render();
}

function wire() {
  const panel = $('[data-panel="environment"]');
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save], [data-clear]');
    if (!button) return;
    const rowEl = button.closest('.env-row');
    const name = rowEl.dataset.name;
    const item = state.values.find((v) => v.name === name);

    if (button.matches('[data-clear]')) {
      if (!confirm(`Stop overriding ${name}? It goes back to the value set on Vercel.`)) return;
      button.disabled = true;
      try {
        await call(`/api/admin/env/${encodeURIComponent(name)}`, { method: 'DELETE' });
        flash(`${item.label} is back to Vercel's value.`);
        await reload();
        onChangeHook?.();
      } catch (error) {
        flash(`Could not change it: ${error.message}`, false);
        button.disabled = false;
      }
      return;
    }

    const input = $('input', rowEl);
    const value = input.value.trim();
    if (!value) {
      flash(item.kind === 'secret' ? 'Paste the new key first.' : 'Enter a number first.', false);
      input.focus();
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = item.kind === 'secret' ? 'Testing…' : 'Saving…';
    try {
      const result = await call(`/api/admin/env/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: item.kind === 'number' ? Number(value) : value }),
      });
      flash(`${item.label} saved. ${result.detail ?? ''} Live on every server within 30 seconds.`);
      await reload();
      onChangeHook?.();
    } catch (error) {
      // The key was not saved; keep what was typed so it can be corrected.
      flash(`Not saved — ${error.message}`, false);
      button.disabled = false;
      button.textContent = label;
    }
  });
}

export async function initEnvironment({ onChange } = {}) {
  onChangeHook = onChange;
  try {
    await reload();
  } catch {
    return; // locked; the gate screen is up
  }
  wire();
}
