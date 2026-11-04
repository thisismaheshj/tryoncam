/**
 * Website tab: the words, links, sections and roadmap of tryoncam.com.
 *
 * The form is built from SECTIONS below. Its inputs carry data-s (not
 * data-path), so the settings module leaves them alone; this module keeps a
 * draft of the `site` record, and saves it together with the support email and
 * link preview cards through settings.js's saveScope.
 */

import { getSettings, saveScope } from './settings.js';
import { toast } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const get = (obj, path) => path.split('.').reduce((node, key) => node?.[key], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((node, key) => (node[key] ??= /^\d+$/.test(key) ? [] : {}), obj);
  target[last] = value;
}

const SECTION_LABELS = {
  demo: 'Demo video', how: 'How it works', features: 'Features', gallery: 'Gallery',
  flow: 'Getting started', roadmap: 'Roadmap', pricing: 'Pricing', faq: 'FAQ',
};
const ICON_LABELS = { chrome: 'Chrome', shopify: 'Shopify', apple: 'Apple / iOS', android: 'Android', spark: 'Sparkle' };
const STATUS_LABELS = { live: 'Live now', building: 'In progress', soon: 'Coming soon', planned: 'Planned' };

/** Field helpers: [path, label, options]. */
const line = (path, label, opts = {}) => ({ path, label, ...opts });
const para = (path, label, opts = {}) => ({ path, label, area: true, wide: true, ...opts });

const SECTIONS = [
  {
    id: 'links', title: 'Links & sections', hint: 'Where the buttons go, and which parts of the page show',
    fields: [
      line('links.chromeStore', 'Chrome Web Store link', { hint: 'every “Add to Chrome” button', wide: true, type: 'url' }),
      line('links.demoVideo', 'Demo video', { hint: 'a YouTube link or an https .mp4 · empty plays the video built into the site', wide: true }),
    ],
    custom: 'sections',
  },
  {
    id: 'roadmap', title: 'Roadmap & coming soon', hint: 'The roadmap section, and the “Soon” buttons in the top bar',
    fields: [
      line('roadmap.eyebrow', 'Small label above'),
      line('roadmap.heading', 'Heading', { wide: true }),
      para('roadmap.lede', 'Intro', { rows: 2 }),
    ],
    custom: 'roadmap',
  },
  {
    id: 'hero', title: 'Hero', hint: 'The first screen',
    fields: [
      line('hero.badgeTag', 'Badge tag', { hint: 'the coloured word · empty hides it' }),
      line('hero.badge', 'Badge text', { hint: 'empty hides the badge' }),
      line('hero.title', 'Headline', { wide: true, hint: 'keep it short: it animates letter by letter' }),
      para('hero.lede', 'Intro', { rows: 3 }),
      line('hero.cta', 'Main button', { hint: 'also used in the mobile menu' }),
      line('hero.secondaryCta', 'Second button', { hint: 'scrolls to the demo · empty hides it' }),
      line('hero.note', 'Small print under the buttons', { wide: true }),
    ],
  },
  {
    id: 'statement', title: 'Statement', hint: 'The big paragraph that lights up as you scroll',
    fields: [para('statement.text', 'Statement', { rows: 3 }), line('statement.foot', 'Line under it', { wide: true })],
  },
  {
    id: 'demo', title: 'Demo video section', section: 'demo',
    fields: [
      line('demo.eyebrow', 'Small label above'), line('demo.heading', 'Heading', { wide: true }), para('demo.lede', 'Intro', { rows: 2 }),
      line('demo.captions.0', 'Tick 1'), line('demo.captions.1', 'Tick 2'), line('demo.captions.2', 'Tick 3'),
    ],
  },
  {
    id: 'how', title: 'How it works', section: 'how', hint: 'Three steps that play as the section scrolls',
    fields: [0, 1, 2].flatMap((i) => [
      line(`how.steps.${i}.eyebrow`, `Step ${i + 1} label`),
      line(`how.steps.${i}.title`, `Step ${i + 1} heading`),
      para(`how.steps.${i}.text`, `Step ${i + 1} text`, { rows: 2 }),
    ]),
  },
  {
    id: 'features', title: 'Features', section: 'features', hint: 'Six tiles, each with its own animation',
    fields: [
      line('features.eyebrow', 'Small label above'), line('features.heading', 'Heading', { wide: true }),
      ...['Stores', 'Live video', 'Free swaps', 'Privacy', 'Hover to try', 'Garment detection'].flatMap((name, i) => [
        line(`features.tiles.${i}.title`, `Tile ${i + 1} heading`, { hint: name.toLowerCase() }),
        para(`features.tiles.${i}.text`, `Tile ${i + 1} text`, { rows: 2 }),
      ]),
    ],
  },
  {
    id: 'gallery', title: 'Gallery', section: 'gallery',
    fields: [line('gallery.eyebrow', 'Small label above'), line('gallery.heading', 'Heading', { wide: true }), para('gallery.lede', 'Intro', { rows: 2 })],
  },
  {
    id: 'flow', title: 'Getting started', section: 'flow', hint: 'Four cards that scroll sideways',
    fields: [
      line('flow.eyebrow', 'Small label above'), line('flow.heading', 'Heading', { wide: true }),
      ...[0, 1, 2, 3].flatMap((i) => [line(`flow.steps.${i}.title`, `Card ${i + 1} heading`), para(`flow.steps.${i}.text`, `Card ${i + 1} text`, { rows: 2 })]),
    ],
  },
  {
    id: 'faq', title: 'FAQ', section: 'faq',
    fields: [line('faq.eyebrow', 'Small label above'), line('faq.heading', 'Heading'), line('faq.lede', 'Line under the heading', { wide: true })],
    custom: 'faq',
  },
  {
    id: 'closing', title: 'Closing, sticky bar & footer',
    fields: [
      line('join.heading', 'Closing headline', { wide: true }), para('join.text', 'Closing text', { rows: 2 }),
      line('join.cta', 'Closing button'), line('join.small', 'Small print beside it'),
      line('sticky.title', 'Sticky bar title', { hint: 'the bar that follows you down the page' }), line('sticky.text', 'Sticky bar text'),
      para('footer.about', 'Footer blurb', { rows: 2 }),
    ],
  },
];

let draft = null;
let options = { sections: Object.keys(SECTION_LABELS), icons: Object.keys(ICON_LABELS), statuses: Object.keys(STATUS_LABELS) };
let dirty = false;

function field(f) {
  const hint = f.hint ? ` <em>${esc(f.hint)}</em>` : '';
  const control = f.area
    ? `<textarea data-s="${f.path}" rows="${f.rows ?? 2}"></textarea>`
    : `<input type="${f.type ?? 'text'}" data-s="${f.path}" autocomplete="off"${f.type === 'url' ? ' spellcheck="false"' : ''}>`;
  return `<label class="field${f.wide ? ' wide' : ''}"><span>${esc(f.label)}${hint}</span>${control}</label>`;
}

function sectionSwitch(id) {
  return `<label class="field checkbox inline-switch"><input type="checkbox" data-section="${id}"><span>Show this section</span></label>`;
}

function renderSkeleton() {
  $('#websiteForm').innerHTML = SECTIONS.map((s, i) => `
    <details class="card fold" data-fold="${s.id}"${i < 2 ? ' open' : ''}>
      <summary class="card-head">
        <h3>${esc(s.title)}</h3>
        <span class="hint">${esc(s.hint ?? '')}</span>
        ${s.section ? `<span class="fold-off" data-off="${s.section}">Hidden</span>` : ''}
        <svg class="fold-chev" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </summary>
      <div class="fold-body">
        ${s.section ? sectionSwitch(s.section) : ''}
        <div class="plan-grid">${s.fields.map(field).join('')}</div>
        ${s.custom ? `<div data-custom="${s.custom}"></div>` : ''}
      </div>
    </details>`).join('');
}

// --- Custom editors -------------------------------------------------------------

function renderSections() {
  const host = $('[data-custom="sections"]');
  host.innerHTML = `<div class="field"><span>Sections on the page <em>off removes the section, and its links in the menus</em></span>
    <div class="chips">${options.sections.map((id) => `<label class="chip"><input type="checkbox" data-section="${id}">${esc(SECTION_LABELS[id] ?? id)}</label>`).join('')}</div></div>`;
}

function iconBtn(action, label, path, disabled = false) {
  return `<button type="button" class="icon-btn${action === 'remove' ? ' danger' : ''}" data-act="${action}" title="${label}" aria-label="${label}"${disabled ? ' disabled' : ''}>
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></button>`;
}
const UP = 'm6 15 6-6 6 6', DOWN = 'm6 9 6 6 6-6', TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3';
const controls = (i, n) => `<div class="row-actions">${iconBtn('up', 'Move up', UP, i === 0)}${iconBtn('down', 'Move down', DOWN, i === n - 1)}${iconBtn('remove', 'Remove', TRASH)}</div>`;

/** What the top bar will show: the items ticked for it, tagged by status. */
function renderNavPreview() {
  const nav = draft.roadmap.items.filter((item) => item.inNav);
  const host = $('#navPreview');
  if (!host) return;
  host.innerHTML = nav.length
    ? nav.map((item) => `<span class="nav-chip nav-chip--${esc(item.icon)}">${esc(item.navLabel || item.title)}${item.status === 'live' ? '' : `<em>${item.status === 'planned' ? 'Planned' : 'Soon'}</em>`}</span>`).join('')
    : '<span class="none">Nothing in the top bar.</span>';
}

function renderRoadmap() {
  const items = draft.roadmap.items;
  const host = $('[data-custom="roadmap"]');
  host.innerHTML = `
    <div class="field"><span>In the top bar <em>items ticked “Show in the top bar” · the tag follows the status</em></span>
      <div class="nav-preview" id="navPreview"></div></div>
    <div class="list-editor" data-list="roadmap">
      ${items.map((item, i) => `
        <div class="list-item" data-i="${i}">
          <div class="list-grid">
            <label class="field"><span>Icon</span><select data-k="icon">${options.icons.map((v) => `<option value="${v}"${v === item.icon ? ' selected' : ''}>${esc(ICON_LABELS[v] ?? v)}</option>`).join('')}</select></label>
            <label class="field"><span>Title</span><input data-k="title" value="${esc(item.title)}" maxlength="50"></label>
            <label class="field"><span>Status</span><select data-k="status">${options.statuses.map((v) => `<option value="${v}"${v === item.status ? ' selected' : ''}>${esc(STATUS_LABELS[v] ?? v)}</option>`).join('')}</select></label>
            <label class="field wide"><span>Text</span><textarea data-k="text" rows="2" maxlength="240">${esc(item.text)}</textarea></label>
            <label class="field checkbox"><input type="checkbox" data-k="inNav"${item.inNav ? ' checked' : ''}><span><b>Show in the top bar</b></span></label>
            <label class="field"><span>Top bar label <em>short</em></span><input data-k="navLabel" value="${esc(item.navLabel)}" maxlength="20"></label>
          </div>
          ${controls(i, items.length)}
        </div>`).join('')}
    </div>
    <div class="actions tight"><button type="button" class="btn" data-add="roadmap"${items.length >= 6 ? ' disabled' : ''}>Add a roadmap item</button></div>`;
  renderNavPreview();
}

function renderFaq() {
  const items = draft.faq.items;
  $('[data-custom="faq"]').innerHTML = `
    <div class="list-editor" data-list="faq">
      ${items.map((item, i) => `
        <div class="list-item" data-i="${i}">
          <div class="list-grid">
            <label class="field wide"><span>Question ${i + 1}</span><input data-k="q" value="${esc(item.q)}" maxlength="140"></label>
            <label class="field wide"><span>Answer</span><textarea data-k="a" rows="3" maxlength="900">${esc(item.a)}</textarea></label>
          </div>
          ${controls(i, items.length)}
        </div>`).join('')}
    </div>
    <div class="actions tight"><button type="button" class="btn" data-add="faq"${items.length >= 16 ? ' disabled' : ''}>Add a question</button></div>`;
}

const LIST_PATH = { roadmap: 'roadmap.items', faq: 'faq.items' };
const NEW_ITEM = {
  roadmap: () => ({ icon: 'spark', title: 'New item', text: '', status: 'planned', inNav: false, navLabel: '' }),
  faq: () => ({ q: 'New question?', a: 'The answer.' }),
};
const RENDER = { roadmap: renderRoadmap, faq: renderFaq };

/** Copies what is typed in a list into the draft before it is re-drawn. */
function readList(name) {
  const items = get(draft, LIST_PATH[name]);
  for (const row of $$(`[data-list="${name}"] .list-item`)) {
    const item = items[Number(row.dataset.i)];
    for (const input of $$('[data-k]', row)) item[input.dataset.k] = input.type === 'checkbox' ? input.checked : input.value;
  }
}

// --- Fill and read -------------------------------------------------------------------

function fill() {
  for (const input of $$('[data-s]')) input.value = get(draft, input.dataset.s) ?? '';
  for (const box of $$('[data-section]')) box.checked = draft.sections?.[box.dataset.section] !== false;
  renderRoadmap();
  renderFaq();
  paintSections();
  markDirty(false);
}

function collectSite() {
  readList('roadmap');
  readList('faq');
  const site = structuredClone(draft);
  for (const input of $$('[data-s]')) set(site, input.dataset.s, input.value.trim());
  // The same switch appears twice (overview chips and the section's own card); they are kept in step.
  for (const box of $$('[data-custom="sections"] [data-section]')) site.sections[box.dataset.section] = box.checked;
  return site;
}

/** Folded cards say so when their section is off. */
function paintSections() {
  for (const tag of $$('[data-off]')) tag.hidden = draft.sections?.[tag.dataset.off] !== false;
}

function markDirty(on = true) {
  dirty = on;
  const button = $('#saveWebsite');
  if (button) button.classList.toggle('unsaved', on);
}

function load(settings) {
  if (!settings?.site) return;
  draft = structuredClone(settings.site);
  if (settings.siteOptions) options = settings.siteOptions;
  fill();
}

export function initWebsite() {
  const panel = $('[data-panel="website"]');
  if (!panel) return;
  renderSkeleton();
  renderSections();
  load(getSettings());
  document.addEventListener('settings:change', (event) => load(event.detail));

  panel.addEventListener('input', (event) => {
    if (event.target.closest('#websiteForm, [data-path]')) markDirty();
    // The top bar preview follows the roadmap fields as they are typed.
    if (event.target.closest('[data-list="roadmap"]')) {
      readList('roadmap');
      renderNavPreview();
    }
  });

  panel.addEventListener('change', (event) => {
    const target = event.target;
    markDirty();
    if (target.matches('[data-section]')) {
      const id = target.dataset.section;
      for (const box of $$(`[data-section="${id}"]`)) box.checked = target.checked;
      draft.sections[id] = target.checked;
      paintSections();
    }
    if (target.closest('[data-list="roadmap"]')) {
      readList('roadmap');
      renderNavPreview();
    }
  });

  panel.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    const act = event.target.closest('[data-act]');
    if (!add && !act) return;
    const name = add ? add.dataset.add : act.closest('[data-list]').dataset.list;
    readList(name);
    const items = get(draft, LIST_PATH[name]);
    if (add) items.push(NEW_ITEM[name]());
    else {
      const i = Number(act.closest('.list-item').dataset.i);
      const move = { up: -1, down: 1 }[act.dataset.act];
      if (move) [items[i], items[i + move]] = [items[i + move], items[i]];
      else items.splice(i, 1);
    }
    RENDER[name]();
    markDirty();
  });

  $('#saveWebsite').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveScope(panel, { site: collectSite() });
      toast('Saved — tryoncam.com shows it on the next page load.');
    } catch (error) {
      toast(`Could not save: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
