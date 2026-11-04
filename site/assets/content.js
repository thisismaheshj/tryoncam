/* tryoncam · landing page content
   The words, links, roadmap and section switches come from the dashboard's
   Website tab (app.tryoncam.com). The HTML already carries the same words, so
   the page reads correctly, and search engines index it, without this.

   Timing matters: site.js splits headings into letters and lines for its
   animations, and pins sections for scroll scenes. So this script fills the
   page first and site.js waits for `window.tryoncamContent` before it starts.
   If the answer is slow, the animations start on the page's own words after
   GATE_MS, and a late answer only swaps words that are not animated. */
(function () {
  'use strict';

  // On a developer's machine, ?api=http://localhost:8799 reads a local backend instead.
  const local = location.hostname === 'localhost' && new URLSearchParams(location.search).get('api');
  const API = (local && /^http:\/\/localhost:\d+$/.test(local) ? local : 'https://app.tryoncam.com') + '/api/public/site';
  const GATE_MS = 1800;
  const root = document.documentElement;

  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const get = (obj, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);

  /** Only links a visitor can trust: the site's own pages, anchors, https and mail. */
  const safeHref = (href) => (/^(https:\/\/|mailto:|#|[\w-]+\.html(#[\w-]*)?$)/i.test(href) ? href : '');

  /** Escaped text with **bold** and [label](link). Nothing else becomes markup. */
  function markup(value) {
    return esc(value)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
        const url = safeHref(href.replace(/&amp;/g, '&'));
        if (!url) return label;
        const external = /^https:/i.test(url) ? ' target="_blank" rel="noopener"' : '';
        return '<a href="' + esc(url) + '"' + external + '>' + label + '</a>';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  /** A heading never ends on one short word alone on its line. */
  const noWidow = (html) => html.replace(/ ([^ <>]{1,8})$/, '&nbsp;$1');

  const ICONS = {
    chrome: '<svg class="chrome-ico"><use href="#chrome"/></svg>',
    shopify: '<svg><use href="#i-shopify"/></svg>',
    apple: '<svg><use href="#i-apple"/></svg>',
    android: '<svg><use href="#i-android"/></svg>',
    spark: '<svg><use href="#spark"/></svg>',
  };
  const STATUS = { live: 'Live now', building: 'In progress', soon: 'Coming soon', planned: 'Planned' };
  const NAV_TAG = { building: 'Soon', soon: 'Soon', planned: 'Planned' };

  const SECTIONS = { demo: '#demo', how: '#how', features: '#features', gallery: '#gallery', flow: '#flow', roadmap: '#roadmap', pricing: '#pricing', faq: '#faq' };

  /** Elements whose words an animation has split or will split. */
  const animated = (el) => Boolean(el.closest('[data-split], [data-hero-title], #statement'));

  function fillText(content, late) {
    $$('[data-c]').forEach((el) => {
      if (late && animated(el)) return;
      const value = get(content, el.dataset.c);
      if (typeof value !== 'string') return;
      const box = el.closest('[data-c-box]') || el;
      if (!value.trim()) { box.hidden = true; return; }
      box.hidden = false;
      const html = markup(value);
      el.innerHTML = /^H[1-3]$/.test(el.tagName) ? noWidow(html) : html;
    });
  }

  function renderRoadmap(items, showRoadmap, late) {
    // Reveal-on-scroll is wired once at start; a late card must simply be visible.
    const reveal = late ? '' : ' data-reveal';
    const list = document.getElementById('roadmapList');
    if (list && items.length) {
      list.innerHTML = items.map((item) =>
        '<li class="rcard rcard--' + esc(item.status) + '"' + reveal + '>' +
          '<span class="rcard__dot" aria-hidden="true"></span>' +
          '<div class="rcard__ico rcard__ico--' + esc(item.icon) + '">' + (ICONS[item.icon] || ICONS.spark) + '</div>' +
          '<span class="rcard__status">' + esc(STATUS[item.status] || '') + '</span>' +
          '<h3>' + esc(item.title) + '</h3>' +
          (item.text ? '<p>' + markup(item.text) + '</p>' : '') +
        '</li>').join('');
    }

    // The top bar's buttons are the roadmap items marked for it.
    const nav = items.filter((item) => item.inNav);
    const buttons = nav.map((item) => {
      const tag = NAV_TAG[item.status];
      const inner = '<svg class="soon__ico soon__ico--' + esc(item.icon) + '">' +
        (ICONS[item.icon] || ICONS.spark).replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</svg>' +
        '<span class="soon__label">' + esc(item.navLabel) + '</span>' + (tag ? '<em>' + tag + '</em>' : '');
      const title = esc(item.title + (STATUS[item.status] ? ' · ' + STATUS[item.status] : ''));
      return showRoadmap
        ? '<a class="soon" href="#roadmap" data-soon title="' + title + '">' + inner + '</a>'
        : '<span class="soon" data-soon title="' + title + '">' + inner + '</span>';
    }).join('');
    ['navSoon', 'mobileSoon'].forEach((id) => {
      const host = document.getElementById(id);
      if (!host) return;
      host.innerHTML = buttons;
      host.hidden = !nav.length;
    });
  }

  function renderFaq(items, late) {
    const reveal = late ? '' : ' data-reveal';
    const list = document.getElementById('faqList');
    if (!list || !items.length) return;
    list.innerHTML = items.map((item, i) =>
      '<details' + reveal + (i === 0 ? ' open' : '') + '>' +
        '<summary>' + esc(item.q) + '<i></i></summary>' +
        '<div class="answer"><p>' + markup(item.a) + '</p></div>' +
      '</details>').join('');
  }

  /** A section switched off leaves the page, with every link that pointed at it. */
  function applySections(sections) {
    Object.keys(SECTIONS).forEach((id) => {
      if (sections[id] !== false) return;
      const el = document.querySelector(SECTIONS[id]);
      if (el) el.remove();
      $$('a[href="' + SECTIONS[id] + '"]').forEach((a) => {
        if (a.matches('[data-soon]')) return; // re-rendered without a link below
        (a.closest('li') || a).remove();
      });
    });
  }

  function applyLinks(links) {
    if (links.chromeStore) {
      window.TRYONCAM_STORE_URL = links.chromeStore;
      $$('[data-install]').forEach((a) => { a.href = links.chromeStore; });
    }
    const video = document.getElementById('video');
    if (video && links.demoVideo) {
      const youtube = !/^https:/i.test(links.demoVideo);
      video.dataset.youtube = youtube ? links.demoVideo : '';
      if (!youtube) video.dataset.mp4 = links.demoVideo;
    }
  }

  function apply(content, late) {
    fillText(content, late);
    applyLinks(content.links || {});
    const sections = content.sections || {};
    renderRoadmap((content.roadmap && content.roadmap.items) || [], sections.roadmap !== false, late);
    renderFaq((content.faq && content.faq.items) || [], late);
    // Removing a section after its scroll scene is built would leave the scene
    // pinned to nothing, so only an on-time answer may do it.
    if (!late) applySections(sections);
  }

  let settled = false;
  const data = fetch(API, { credentials: 'omit', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .catch(() => null);
  window.tryoncamSiteData = data; // site.js reads the support address from the same answer

  const ready = new Promise((resolve) => {
    const done = () => { if (!settled) { settled = true; root.classList.add('content-ready'); resolve(); } };
    setTimeout(done, GATE_MS);
    data.then((answer) => {
      try {
        if (answer && answer.content) apply(answer.content, settled);
      } catch (error) {
        console.warn('[tryoncam] content failed to apply', error);
      }
      if (settled && window.ScrollTrigger) window.ScrollTrigger.refresh();
      done();
    });
  });
  window.tryoncamContent = ready;
})();
