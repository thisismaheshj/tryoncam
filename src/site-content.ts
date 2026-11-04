import { extractVideoId } from './video.js';

/**
 * The words and switches of tryoncam.com, edited from the dashboard's Website tab.
 *
 * The page ships with these same words written into its HTML, so it reads
 * correctly (and search engines index it) before this arrives or if the
 * backend is down. site/assets/content.js swaps them in before the page's
 * animations start.
 *
 * Copy may use tokens, filled in server-side from live settings:
 *   {credits}  free credits on sign-in    {seconds}  session length
 *   {email}    the support address
 * and two bits of markup, rendered by the page: **bold** and [label](link).
 */

export const SECTION_IDS = ['demo', 'how', 'features', 'gallery', 'flow', 'roadmap', 'pricing', 'faq'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const ROADMAP_ICONS = ['chrome', 'shopify', 'apple', 'android', 'spark'] as const;
export const ROADMAP_STATUSES = ['live', 'building', 'soon', 'planned'] as const;

export type RoadmapItem = {
  icon: (typeof ROADMAP_ICONS)[number];
  title: string;
  text: string;
  status: (typeof ROADMAP_STATUSES)[number];
  /** Also shown as a button in the top bar, tagged with the status. */
  inNav: boolean;
  navLabel: string;
};

type Titled = { title: string; text: string };

export type SiteContent = {
  links: {
    /** Every "Add to Chrome" button. */
    chromeStore: string;
    /** A YouTube id/link or an https .mp4. Empty plays the video bundled with the site. */
    demoVideo: string;
  };
  sections: Record<SectionId, boolean>;
  hero: { badgeTag: string; badge: string; title: string; lede: string; cta: string; secondaryCta: string; note: string };
  statement: { text: string; foot: string };
  demo: { eyebrow: string; heading: string; lede: string; captions: string[] };
  how: { steps: (Titled & { eyebrow: string })[] };
  features: { eyebrow: string; heading: string; tiles: Titled[] };
  gallery: { eyebrow: string; heading: string; lede: string };
  flow: { eyebrow: string; heading: string; steps: Titled[] };
  roadmap: { eyebrow: string; heading: string; lede: string; items: RoadmapItem[] };
  faq: { eyebrow: string; heading: string; lede: string; items: { q: string; a: string }[] };
  join: { heading: string; text: string; cta: string; small: string };
  sticky: { title: string; text: string };
  footer: { about: string };
};

export const DEFAULT_CHROME_STORE = 'https://chromewebstore.google.com/detail/aadnmnhilcphhjnchilngaeandeldngc';

/** Exactly what the HTML says, so a fresh store changes nothing on the page. */
export const SITE_DEFAULTS: SiteContent = {
  links: { chromeStore: DEFAULT_CHROME_STORE, demoVideo: '' },
  sections: { demo: true, how: true, features: true, gallery: true, flow: true, roadmap: true, pricing: true, faq: true },
  hero: {
    badgeTag: 'New',
    badge: 'Live try-on in any Chrome tab',
    title: 'See it on you before you buy it.',
    lede: 'tryoncam puts clothes from any online store on you, live, through your own camera. Hover a garment, click **Try On**, and watch yourself wear it in seconds, without leaving the page.',
    cta: "Add to Chrome, it's free",
    secondaryCta: 'Watch the demo',
    note: '**{credits} free try-ons** when you sign in. No card needed.',
  },
  statement: {
    text: 'Shopping for clothes online is guessing. You squint at a model who is nothing like you, order two sizes, and send one back. tryoncam puts the garment on you, live, on the page you are already looking at.',
    foot: 'A free Chrome extension for desktop. Takes ten seconds to install.',
  },
  demo: {
    eyebrow: 'The demo',
    heading: 'Sixty seconds, start to wearing it.',
    lede: "Find a garment, click Try On, see it on you, and swap until it's the one.",
    captions: ["Works on the store's own product photos", 'No photo upload, no body scan', 'Swap garments mid-session for free'],
  },
  how: {
    steps: [
      { eyebrow: '01 · Find', title: 'Hover. Click Try On.', text: 'Shop the way you already do. A small **Try On** pill appears on every garment it recognises. Logos, banners and shoes are left alone.' },
      { eyebrow: '02 · Open', title: 'The trial room opens on the page.', text: 'No new tab, no upload, no photoshoot. Allow your camera once and a live session starts right beside the product.' },
      { eyebrow: '03 · Decide', title: 'See it on you. Swap for free.', text: 'You are wearing it, live, moving as you move. Swap in other garments during the same session at no extra cost.' },
    ],
  },
  features: {
    eyebrow: 'What you get',
    heading: 'A fitting room that follows you around the internet.',
    tiles: [
      { title: 'Works on the stores you already use', text: 'Product pages, collection grids, independent Shopify shops, big retailers, and inspiration feeds like Pinterest and Instagram. If there is a garment in the picture, you can try it.' },
      { title: 'Live video, not a still', text: 'Turn, step back, raise your arms. The garment moves with you in real time, so you see how it hangs, not just how it looks head-on.' },
      { title: 'Swap garments for free', text: 'One credit opens a session. Try the shirt, then the knit, then the tee. Swapping inside the session costs nothing.' },
      { title: 'Private by default', text: 'Your camera switches on only when you press start, and switches off when the session ends.' },
      { title: 'Hover, then click Try On', text: 'A Try On button appears on product photos as you browse. Click it and the trial room opens with that garment on you.' },
      { title: 'Knows a garment from a banner', text: 'tryoncam reads the page the way you do. Pills go on clothes you can wear, and stay off logos, storefront photos, payment badges and campaign banners, so the page never feels cluttered.' },
    ],
  },
  gallery: {
    eyebrow: 'Try anything',
    heading: 'Tees, knits, shirts, shorts. If it goes on your body, it goes on you.',
    lede: 'Tops, dresses, outerwear, bottoms, activewear and swimwear all work. Shoes, bags and jewellery are left out for now, because a live model cannot place them convincingly yet.',
  },
  flow: {
    eyebrow: 'Getting started',
    heading: 'From install to wearing it in under a minute.',
    steps: [
      { title: 'Add to Chrome', text: 'One click from the Chrome Web Store. It sits quietly in your toolbar until you need it.' },
      { title: 'Sign in with Google', text: 'No password to make up. Your {credits} free credits land in your account straight away.' },
      { title: 'Hover any garment', text: 'Go to any clothing store. Hover a product, click the Try On pill, and allow your camera once.' },
      { title: 'Decide before you buy', text: "Keep what suits you, skip what doesn't, and send back fewer parcels." },
    ],
  },
  roadmap: {
    eyebrow: 'Roadmap',
    heading: 'Chrome today. Your store and your phone next.',
    lede: 'tryoncam starts in your browser. Here is where it is going.',
    items: [
      { icon: 'chrome', title: 'Chrome extension', text: 'Try on clothes from any online store, live, right in your browser.', status: 'live', inNav: false, navLabel: 'Chrome' },
      { icon: 'shopify', title: 'Shopify app', text: 'A Try On button on your own product pages, so your customers see it on themselves before they buy. No code to install.', status: 'soon', inNav: true, navLabel: 'Shopify' },
      { icon: 'apple', title: 'iPhone app', text: 'The same live trial room on your phone. Try on what you find while you scroll.', status: 'soon', inNav: true, navLabel: 'iOS app' },
    ],
  },
  faq: {
    eyebrow: 'FAQ',
    heading: 'Fair questions.',
    lede: 'Anything else, email [{email}](mailto:{email}).',
    items: [
      { q: 'What do I need to use it?', a: 'Google Chrome on a laptop or desktop computer with a webcam. Other Chromium browsers such as Edge and Brave can install Chrome Web Store extensions, but we only test on Chrome. Phones and tablets are not supported yet.' },
      { q: 'What exactly is a credit?', a: 'One credit starts one live try-on session of up to {seconds} seconds. Inside that session you can swap between as many garments as you like at no extra cost. A credit is used when the live video actually starts, not when you open the trial room.' },
      { q: 'Do you record or store my camera?', a: 'No. Your camera switches on only when you start a session. The video is streamed to our AI processing partner to render the try-on in real time, and is not saved by us. We never use the microphone. Full details are in the [privacy policy](privacy.html).' },
      { q: 'Will it tell me my size?', a: "No, and we would rather be upfront about that. tryoncam shows you how a garment looks on you: colour, cut, print, proportion, the overall vibe. It is a visual preview, not a sizing tool, so always check the store's size guide before you order." },
      { q: 'Which stores and clothes work?', a: 'Most clothing stores, including independent Shopify shops, plus inspiration feeds like Pinterest. Tops, shirts, dresses, outerwear, bottoms, activewear and swimwear are supported. Shoes, bags, eyewear and jewellery are not, yet.' },
      { q: 'Do credits expire?', a: 'No. Credits stay in your account until you use them.' },
      { q: 'Can I get a refund?', a: 'All credit purchases are final and non-refundable, which is why every account starts with {credits} free credits so you can try it properly before paying. If you were charged twice or charged in error, email us and we will put it right. See the [refund policy](refunds.html).' },
    ],
  },
  join: {
    heading: 'Stop guessing. Start trying.',
    text: 'Install tryoncam, sign in, and your first {credits} try-ons are on us.',
    cta: "Add to Chrome, it's free",
    small: 'Chrome on desktop · takes ten seconds',
  },
  sticky: { title: 'tryoncam for Chrome', text: '{credits} free try-ons. No card needed.' },
  footer: { about: 'Live virtual try-on for any clothing store, right inside Chrome. Made by tryoncam, a company of One Man Holdings LLC.' },
};

// --- Merging -------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Stored values over defaults, one level of objects deep. A list replaces the
 * default list whole: an operator who deleted a FAQ question means it gone.
 */
export function mergeSite(stored: unknown): SiteContent {
  const source = isObject(stored) ? stored : {};
  const out = structuredClone(SITE_DEFAULTS) as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (!(key in out)) continue;
    const base = out[key];
    out[key] = isObject(base) && isObject(value) ? { ...base, ...value } : base;
  }
  return out as SiteContent;
}

// --- Cleaning --------------------------------------------------------------------

export class SiteContentError extends Error {}

const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function httpsUrl(v: unknown, label: string): string {
  const value = String(v ?? '').trim();
  if (!value) return '';
  try {
    if (new URL(value).protocol === 'https:' && value.length <= 500) return value;
  } catch {
    /* fall through */
  }
  throw new SiteContentError(`${label} must be an https link.`);
}

/** Keeps shapes and lengths sane whatever the form sent, and fills gaps from the defaults. */
export function cleanSite(input: unknown): SiteContent {
  const s = mergeSite(input);
  const d = SITE_DEFAULTS;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback;
  const list = <T>(v: unknown, max: number, map: (x: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(v) ? v : []).map((x) => map(isObject(x) ? x : { value: x })).filter((x): x is T => x !== null).slice(0, max);
  const or = (value: string, fallback: string) => value || fallback;

  const video = String(s.links.demoVideo ?? '').trim();
  const demoVideo = video ? extractVideoId(video) : '';
  if (video && !demoVideo) throw new SiteContentError('The demo video must be a YouTube link or an https link to an .mp4.');

  return {
    links: { chromeStore: httpsUrl(s.links.chromeStore, 'The Chrome Web Store link') || DEFAULT_CHROME_STORE, demoVideo },
    sections: Object.fromEntries(SECTION_IDS.map((id) => [id, s.sections?.[id] !== false])) as SiteContent['sections'],
    hero: {
      badgeTag: text(s.hero.badgeTag, 16),
      badge: text(s.hero.badge, 70),
      title: or(text(s.hero.title, 90), d.hero.title),
      lede: text(s.hero.lede, 320),
      cta: or(text(s.hero.cta, 40), d.hero.cta),
      secondaryCta: text(s.hero.secondaryCta, 40),
      note: text(s.hero.note, 120),
    },
    statement: { text: or(text(s.statement.text, 400), d.statement.text), foot: text(s.statement.foot, 120) },
    demo: {
      eyebrow: text(s.demo.eyebrow, 40),
      heading: or(text(s.demo.heading, 120), d.demo.heading),
      lede: text(s.demo.lede, 240),
      captions: list(s.demo.captions, 3, (x) => text(x.value, 70) || null),
    },
    how: {
      // Always three: the pinned animation has three states.
      steps: d.how.steps.map((fallback, i) => {
        const step = isObject(s.how.steps?.[i]) ? (s.how.steps[i] as Record<string, unknown>) : {};
        return {
          eyebrow: text(step.eyebrow, 30) || fallback.eyebrow,
          title: text(step.title, 70) || fallback.title,
          text: text(step.text, 240) || fallback.text,
        };
      }),
    },
    features: {
      eyebrow: text(s.features.eyebrow, 40),
      heading: or(text(s.features.heading, 120), d.features.heading),
      // One per tile: each tile has its own illustration.
      tiles: d.features.tiles.map((fallback, i) => {
        const tile = isObject(s.features.tiles?.[i]) ? (s.features.tiles[i] as Record<string, unknown>) : {};
        return { title: text(tile.title, 60) || fallback.title, text: text(tile.text, 280) || fallback.text };
      }),
    },
    gallery: {
      eyebrow: text(s.gallery.eyebrow, 40),
      heading: or(text(s.gallery.heading, 120), d.gallery.heading),
      lede: text(s.gallery.lede, 280),
    },
    flow: {
      eyebrow: text(s.flow.eyebrow, 40),
      heading: or(text(s.flow.heading, 120), d.flow.heading),
      steps: d.flow.steps.map((fallback, i) => {
        const step = isObject(s.flow.steps?.[i]) ? (s.flow.steps[i] as Record<string, unknown>) : {};
        return { title: text(step.title, 50) || fallback.title, text: text(step.text, 200) || fallback.text };
      }),
    },
    roadmap: {
      eyebrow: text(s.roadmap.eyebrow, 40),
      heading: or(text(s.roadmap.heading, 120), d.roadmap.heading),
      lede: text(s.roadmap.lede, 240),
      items: list(s.roadmap.items, 6, (x) => {
        const title = text(x.title, 50);
        if (!title) return null;
        return {
          icon: pick(x.icon, ROADMAP_ICONS, 'spark'),
          title,
          text: text(x.text, 240),
          status: pick(x.status, ROADMAP_STATUSES, 'planned'),
          inNav: x.inNav === true,
          navLabel: text(x.navLabel, 20) || title.slice(0, 20),
        };
      }),
    },
    faq: {
      eyebrow: text(s.faq.eyebrow, 40),
      heading: or(text(s.faq.heading, 120), d.faq.heading),
      lede: text(s.faq.lede, 200),
      items: list(s.faq.items, 16, (x) => {
        const q = text(x.q, 140);
        const a = text(x.a, 900);
        return q && a ? { q, a } : null;
      }),
    },
    join: {
      heading: or(text(s.join.heading, 90), d.join.heading),
      text: text(s.join.text, 200),
      cta: or(text(s.join.cta, 40), d.join.cta),
      small: text(s.join.small, 80),
    },
    sticky: { title: or(text(s.sticky.title, 40), d.sticky.title), text: text(s.sticky.text, 80) },
    footer: { about: text(s.footer.about, 240) },
  };
}

// --- Rendering ---------------------------------------------------------------------

/** Every string in the record with its tokens filled in. Markup is left for the page. */
export function renderSiteContent(site: SiteContent, values: { credits: number; seconds: number; email: string }): SiteContent {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .split('{credits}').join(String(values.credits))
        .split('{seconds}').join(String(values.seconds))
        .split('{email}').join(values.email);
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    return value;
  };
  return fill(site) as SiteContent;
}
