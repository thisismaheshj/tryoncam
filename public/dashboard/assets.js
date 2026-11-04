/**
 * Content → Brand assets: every marketing and graphic asset, from the manifest
 * scripts/build-brand-kit.mjs publishes on tryoncam.com.
 *
 * The files live on the site, not here, so there is one copy of each. The site
 * sends them with Access-Control-Allow-Origin, which is what lets "Download"
 * save a file instead of opening it.
 */

import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** On a developer's machine, ?site=http://localhost:5180 reads a local build of the site. */
function siteBase() {
  const local = new URLSearchParams(location.search).get('site');
  if (['localhost', '127.0.0.1'].includes(location.hostname) && local && /^http:\/\/localhost:\d+$/.test(local)) return `${local}/`;
  return 'https://tryoncam.com/';
}

const bytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const duration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

let manifest = null;
let base = siteBase();
let filter = 'all';

function meta(item) {
  return [
    item.format,
    item.width && item.height ? `${item.width}×${item.height}` : '',
    item.seconds ? duration(item.seconds) : '',
    bytes(item.bytes),
  ].filter(Boolean).join(' · ');
}

function preview(item) {
  const url = base + item.url;
  // White text and marks need a dark stage to be seen at all.
  const dark = /dark/i.test(item.title) || /glyph/i.test(item.url);
  if (item.kind === 'image') {
    return `<div class="asset-stage${dark ? ' dark' : ''}${item.format === 'SVG' || /lockup|icon|glyph|mark/i.test(item.url) ? ' checker' : ''}">
      <img src="${esc(url)}" alt="" loading="lazy"></div>`;
  }
  if (item.kind === 'video') {
    return `<div class="asset-stage dark"><video src="${esc(url)}" preload="metadata" controls muted playsinline></video></div>`;
  }
  return `<div class="asset-stage text"><pre data-text="${esc(url)}">…</pre></div>`;
}

function card(item) {
  return `<article class="asset">
    ${preview(item)}
    <div class="asset-body">
      <b>${esc(item.title)}</b>
      <span class="asset-meta">${esc(meta(item))}</span>
      ${item.use ? `<p>${esc(item.use)}</p>` : ''}
    </div>
    <div class="asset-actions">
      <button class="btn small" type="button" data-download="${esc(item.url)}">Download</button>
      <button class="btn small" type="button" data-copy="${esc(base + item.url)}">Copy link</button>
    </div>
  </article>`;
}

function renderBrand() {
  const swatches = manifest.palette.map((c) => `
    <button class="swatch-chip" type="button" data-copy="${esc(c.hex)}" title="Copy ${esc(c.hex)}">
      <i style="background:${esc(c.hex)}"></i><span><b>${esc(c.name)}</b><code>${esc(c.hex)}</code><small>${esc(c.use)}</small></span>
    </button>`).join('');
  const fonts = manifest.fonts.map((f) => `
    <a class="font-row" href="${esc(f.url)}" target="_blank" rel="noopener">
      <span class="font-sample" style="font-family:'${esc(f.name)}',system-ui">Aa</span>
      <span><b>${esc(f.name)}</b><small>${esc(f.use)}</small></span>
    </a>`).join('');
  $('#assetsBrand').innerHTML = `
    <div class="card-head"><h3>Colours & type</h3><span class="hint">Click a colour to copy its hex</span></div>
    <div class="brand-grid"><div class="swatches">${swatches}</div><div class="fonts">${fonts}</div></div>`;
}

function renderGroups() {
  $('#assetGroups').innerHTML = manifest.groups
    .filter((group) => filter === 'all' || group.id === filter)
    .map((group) => `
      <section class="card asset-group" id="assets-${esc(group.id)}">
        <div class="card-head"><h3>${esc(group.title)}</h3><span class="hint">${group.items.length} · ${esc(group.note ?? '')}</span></div>
        <div class="asset-grid">${group.items.map(card).join('')}</div>
      </section>`).join('');
  // Text assets show their opening lines.
  for (const pre of document.querySelectorAll('#assetGroups pre[data-text]')) {
    fetch(pre.dataset.text).then((r) => r.text()).then((text) => { pre.textContent = text.slice(0, 400); }).catch(() => { pre.textContent = ''; });
  }
}

function renderFilters() {
  const options = [['all', 'All']].concat(manifest.groups.map((g) => [g.id, g.title]));
  $('#assetFilters').innerHTML = options
    .map(([id, label]) => `<label class="chip"><input type="radio" name="assetFilter" value="${id}"${id === filter ? ' checked' : ''}>${esc(label)}</label>`)
    .join('');
}

/** Saves a file from the site. Cross-origin links ignore `download`, so the bytes are fetched first. */
async function download(url, button) {
  const name = url.split('/').pop();
  button.disabled = true;
  try {
    const response = await fetch(base + url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch {
    // The file is public either way: open it, and the browser offers to save it.
    window.open(base + url, '_blank', 'noopener');
  } finally {
    button.disabled = false;
  }
}

export async function initAssets() {
  const panel = $('[data-panel="assets"]');
  if (!panel) return;
  try {
    const response = await fetch(`${base}assets/brand/manifest.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    $('#assetsHint').textContent = `Could not load the asset list from ${base} (${error.message}).`;
    return;
  }
  const count = manifest.groups.reduce((n, g) => n + g.items.length, 0);
  $('#assetsHint').textContent = `${count} assets · rebuilt ${new Date(manifest.generatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const zip = $('#assetsZip');
  zip.textContent = `Download everything · ${bytes(manifest.zip.bytes)}`;
  zip.dataset.download = manifest.zip.url;
  zip.title = `${manifest.zip.files} files, videos excepted`;

  // The type samples, in the brand's own fonts.
  if (!document.getElementById('brandFonts')) {
    document.head.insertAdjacentHTML('beforeend', '<link id="brandFonts" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@800&family=Geist:wght@500&family=Geist+Mono:wght@500&display=swap">');
  }
  renderFilters();
  renderBrand();
  renderGroups();

  panel.addEventListener('change', (event) => {
    if (event.target.name !== 'assetFilter') return;
    filter = event.target.value;
    renderGroups();
  });
  panel.addEventListener('click', async (event) => {
    const dl = event.target.closest('[data-download]');
    const copy = event.target.closest('[data-copy]');
    if (dl) {
      event.preventDefault();
      await download(dl.dataset.download, dl);
    } else if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast(`Copied ${copy.dataset.copy.length > 60 ? 'the link' : copy.dataset.copy}`);
      } catch {
        toast('Could not copy: the browser blocked the clipboard.');
      }
    }
  });
}
