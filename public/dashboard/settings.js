/**
 * Settings tab: everything an operator can change without a redeploy.
 *
 * Two different stores behind one screen — run controls (provider, kill switch,
 * session length) are process state applied instantly, while the rest is the
 * settings file the extension reads on open. They are saved together so the
 * distinction never has to be explained.
 */

import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);

const CATEGORIES = ['top', 'bottom', 'dress', 'outerwear', 'activewear', 'swimwear', 'lingerie', 'headwear'];

const TEXT_LABELS = {
  panelTitle: ['Trial room title', 'The heading of the panel that opens on the page'],
  dropHeadline: ['Trial room headline', 'Shown when the panel opens, before a try-on'],
  dropSubtext: ['Trial room subtext', ''],
  startingTitle: ['Starting title', 'Shown the moment Try On is clicked'],
  startingNote: ['Starting note', ''],
  signInTitle: ['Sign-in title', ''],
  signInSubtext: ['Sign-in subtext', ''],
  menuOpenLabel: ['Menu: open label', ''],
  menuOpenHint: ['Menu: open hint', ''],
  menuTutorialLabel: ['Menu: tutorial label', ''],
  menuTutorialHint: ['Menu: tutorial hint', ''],
};

let settings = null;
let runtime = null;

const get = (obj, path) => path.split('.').reduce((node, key) => node?.[key], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((node, key) => (node[key] ??= {}), obj);
  target[last] = value;
}

function flash(message) {
  toast(message);
}

function renderCategoryChips() {
  const chosen = new Set(get(settings, 'discovery.wearableCategories') ?? CATEGORIES);
  $('#categoryChips').innerHTML = CATEGORIES.map(
    (c) => `<label class="chip"><input type="checkbox" value="${c}" ${chosen.has(c) ? 'checked' : ''}>${c}</label>`,
  ).join('');
}

/** The category chips only matter in garments mode; dim them otherwise. */
function paintMode() {
  const garments = document.querySelector('[data-mode]:checked')?.value === 'garments';
  $('#categoryField')?.classList.toggle('dimmed', !garments);
}
document.addEventListener('change', (event) => {
  if (event.target.matches?.('[data-mode]')) paintMode();
});

function renderTextFields() {
  $('#textFields').innerHTML = Object.entries(TEXT_LABELS)
    .map(
      ([key, [label, hint]]) => `<label class="field">
        <span>${label}${hint ? ` <em>${hint}</em>` : ''}</span>
        <input type="text" data-path="texts.${key}" autocomplete="off">
      </label>`,
    )
    .join('');
}

function renderVideoPreview() {
  const id = String(get(settings, 'tutorial.videoId') ?? '').trim();
  const host = $('#videoPreview');
  const safe = id.replace(/"/g, '%22');
  host.innerHTML = !id
    ? '<span class="none">No video set: the tutorial entry is hidden from the toolbar menu.</span>'
    : isFileUrl(id)
      ? `<video src="${safe}" controls preload="metadata"></video>`
      : `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0" allowfullscreen></iframe>`;
}

/** An https link straight to a video file (the landing page's demo, for one). */
function isFileUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /\.(mp4|webm|mov)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// --- Link preview ------------------------------------------------------------

let shareImages = [];

/** Marks the picked design, or shows the custom link in its field. */
function paintShare() {
  const current = $('#shareImage').value;
  const isDesign = shareImages.some((image) => image.id === current);
  for (const tile of document.querySelectorAll('#shareGrid [data-share]')) {
    const on = tile.dataset.share === current;
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-checked', String(on));
  }
  if (document.activeElement !== $('#shareCustom')) $('#shareCustom').value = isDesign ? '' : current;
}

async function initShare() {
  const response = await fetch('/api/admin/share-images');
  if (!response.ok) return;
  shareImages = (await response.json()).images ?? [];
  $('#shareGrid').innerHTML = shareImages
    .map((image) => `<button type="button" class="share-tile" role="radio" data-share="${image.id}">
        <img src="${image.url}" alt="" loading="lazy"><span>${image.label}</span>
      </button>`)
    .join('');
  $('#shareGrid').addEventListener('click', (event) => {
    const tile = event.target.closest('[data-share]');
    if (!tile) return;
    $('#shareImage').value = tile.dataset.share;
    $('#shareCustom').value = '';
    paintShare();
  });
  $('#shareCustom').addEventListener('input', () => {
    const url = $('#shareCustom').value.trim();
    $('#shareImage').value = url || shareImages[0]?.id || '';
    paintShare();
  });
  paintShare();
}

function fill() {
  for (const input of document.querySelectorAll('[data-path]')) {
    const value = get(settings, input.dataset.path);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (Array.isArray(value)) input.value = value.join(input.dataset.list === 'lines' ? '\n' : ', ');
    else input.value = value ?? '';
  }
  renderVideoPreview();
  renderAnnouncement();
  paintShare();
  renderCategoryChips();
  const mode = get(settings, 'discovery.mode') === 'all' ? 'all' : 'garments';
  for (const radio of document.querySelectorAll('[data-mode]')) radio.checked = radio.value === mode;
  paintMode();

  const auth = settings.auth ?? {};
  $('#authStatus').textContent = auth.webClientId
    ? 'Configured'
    : 'Not configured — customers cannot sign in yet';
}

/**
 * The fields inside one part of the page, as a patch of whole top-level
 * records. A tab sends only what it shows: sending everything let a tab opened
 * an hour ago put back words another tab had since changed.
 */
function collect(root) {
  const patch = {};
  const own = (key) => (patch[key] ??= structuredClone(settings[key] ?? {}));
  for (const input of root.querySelectorAll('[data-path]')) {
    const path = input.dataset.path;
    const [key, ...rest] = path.split('.');
    const target = own(key);
    const inner = rest.join('.');
    if (input.type === 'checkbox') set(target, inner, input.checked);
    else if (input.dataset.list === 'lines') set(target, inner, input.value.split('\n').map((s) => s.trim()).filter(Boolean));
    else if (path === 'auth.allowedEmails') set(target, inner, input.value.split(',').map((s) => s.trim()).filter(Boolean));
    else set(target, inner, input.value.trim());
  }
  if (root.querySelector('[data-mode]')) {
    const discovery = own('discovery');
    discovery.mode = root.querySelector('[data-mode]:checked')?.value ?? 'garments';
    discovery.wearableCategories = [...root.querySelectorAll('#categoryChips input:checked')].map((i) => i.value);
  }
  return patch;
}

/** Tells the other tabs (Website) that the saved record changed. */
function announce() {
  document.dispatchEvent(new CustomEvent('settings:change', { detail: settings }));
}

export function getSettings() {
  return settings;
}

/**
 * Saves one part of the page — its [data-path] fields plus `extra` — and
 * refreshes everything that shows settings.
 */
export async function saveScope(root, extra = {}) {
  const result = await post('/api/admin/settings', { ...collect(root), ...extra });
  // Keep the read-only extras (the Google Cloud values) the save does not return.
  settings = { ...settings, ...result.settings };
  fill();
  announce();
  return settings;
}

// --- Toolbar menu announcement ------------------------------------------------

function renderAnnouncement() {
  const host = $('#announcePreview');
  if (!host) return;
  const field = (name) => document.querySelector(`[data-path="extension.announcement.${name}"]`)?.value.trim() ?? '';
  const text = field('text');
  const label = field('linkLabel') || (field('url') ? 'Learn more' : '');
  host.innerHTML = text
    ? `<div class="announce"><span class="announce-dot"></span><span></span>${label ? '<a></a>' : ''}</div>`
    : '<span class="none">Nothing shown. Type a message to add one.</span>';
  if (!text) return;
  host.querySelector('.announce span:nth-child(2)').textContent = text;
  if (label) host.querySelector('.announce a').textContent = `${label} →`;
}
document.addEventListener('input', (event) => {
  if (event.target.matches?.('[data-path^="extension.announcement"]')) renderAnnouncement();
});

// --- Run controls -----------------------------------------------------------

function fillRunControls(state) {
  runtime = state;
  const active = state.providers.find((p) => p.id === state.activeProvider);
  $('#setProvider').innerHTML = state.providers
    .map(
      (p) => `<option value="${p.id}" ${p.id === state.activeProvider ? 'selected' : ''}
              ${p.selectable ? '' : 'disabled'}>${p.displayName}${p.selectable ? '' : ' — unavailable'}</option>`,
    )
    .join('');
  $('#setKill').checked = state.killSwitch;

  const slider = $('#setSeconds');
  slider.min = String(active?.minSessionSeconds ?? 10);
  slider.max = String(state.session.maxSeconds);
  if (document.activeElement !== slider) slider.value = String(state.session.sessionSeconds);
  paintLength();
}

function paintLength() {
  const seconds = Number($('#setSeconds').value);
  const active = runtime?.providers.find((p) => p.id === runtime.activeProvider);
  $('#setSecondsOut').textContent = `${seconds}s`;
  $('[data-role="lenCost"]').textContent = active
    ? `$${(seconds * active.usdPerSecond).toFixed(2)} per run · ${Math.floor((active.remainingSeconds || 0) / seconds)} runs left in budget`
    : '';
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function loadSettings() {
  try {
    const response = await fetch('/api/admin/settings');
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function initSettings({ onRunChange }) {
  renderTextFields();

  // A refused request still has a JSON body ({ error }), so status is what
  // decides here — reading that body as settings crashes fill() on the first
  // missing key and takes the rest of the page down with it.
  settings = await loadSettings();
  if (!settings) return;
  fill();
  announce();
  initShare().catch(() => {});
  const google = settings.google ?? {};
  $('#googleOrigin').textContent = google.origin ?? location.origin;
  $('#googleRedirect').textContent = google.extensionRedirect ?? '';
  $('#envAdmins').textContent = google.adminEmailsFromEnv?.length
    ? `Also admin, from ADMIN_EMAILS: ${google.adminEmailsFromEnv.join(', ')}`
    : '';

  for (const input of document.querySelectorAll('[data-path^="tutorial.videoId"]')) {
    input.addEventListener('input', () => {
      set(settings, 'tutorial.videoId', extractId(input.value));
      renderVideoPreview();
    });
  }

  $('#setSeconds').addEventListener('input', paintLength);

  // Settings holds only the run controls now; each has its own endpoint.
  $('#saveSettings').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await post('/api/admin/provider', { provider: $('#setProvider').value }).catch(() => {});
      await post('/api/admin/kill-switch', { enabled: $('#setKill').checked });
      const length = await post('/api/admin/session-seconds', { seconds: Number($('#setSeconds').value) });
      flash(length?.clamped
        ? `Saved, but sessions were set to ${length.sessionSeconds}s: that is the most the Session length limit on the Environment tab allows.`
        : `Saved — ${length?.sessionSeconds ?? ''}s sessions, live for new sessions now.`);
      onRunChange?.();
    } catch (error) {
      flash(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  $('#saveExtension')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveScope(document.querySelector('[data-panel="extension"]'));
      flash('Saved — every extension picks this up within a minute.');
    } catch (error) {
      flash(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  // The Google card lives on the Environment tab but is part of this record,
  // so it saves through the same endpoint — without touching run controls.
  $('#saveGoogle')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveScope($('#googleCard'));
      flash('Sign-in settings saved — live for the extension and this dashboard.');
    } catch (error) {
      flash(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  // Every tab's "Discard changes": back to what is saved.
  for (const button of document.querySelectorAll('[data-discard]')) {
    button.addEventListener('click', async () => {
      const fresh = await loadSettings();
      if (!fresh) {
        flash('Could not reload — the dashboard is locked.');
        return;
      }
      settings = fresh;
      fill();
      announce();
      flash('Reverted to what is saved.');
    });
  }

  return { fillRunControls };
}

/** Mirrors the server's parser so the preview updates as you paste. */
function extractId(value) {
  const raw = String(value ?? '').trim();
  if (isFileUrl(raw)) return raw;
  if (/^[\w-]{6,20}$/.test(raw)) return raw;
  for (const pattern of [/[?&]v=([\w-]{6,20})/, /youtu\.be\/([\w-]{6,20})/, /embed\/([\w-]{6,20})/, /shorts\/([\w-]{6,20})/]) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

export { fillRunControls };
