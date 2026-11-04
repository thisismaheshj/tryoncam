import { isProviderId, type ProviderId, runtime } from './config.js';
import { refreshOverrides } from './overrides.js';
import { getStore } from './store/index.js';
import { cleanSite, mergeSite, type SiteContent } from './site-content.js';
import { extractVideoId } from './video.js';

// Kept importable from here: tests and the server already reach for them through settings.
export { extractVideoId, isVideoFileUrl } from './video.js';

/**
 * Operator-editable settings, stored as one JSON file and served to the
 * extension at runtime.
 *
 * Anything here can be changed from the dashboard and takes effect on the next
 * extension request — no rebuild, no reload of the unpacked extension. Secrets
 * stay in .env; these are all things that are safe for a client to read,
 * because the extension does read them.
 */

export type Settings = {
  tutorial: {
    /**
     * A YouTube id, or an https link to a video file (.mp4/.webm). Empty hides
     * the tutorial entry in the toolbar menu.
     */
    videoId: string;
    title: string;
    /** Set when an operator deliberately emptied the video, so the default stays away. */
    cleared?: boolean;
  };
  texts: {
    panelTitle: string;
    dropHeadline: string;
    dropSubtext: string;
    startingTitle: string;
    startingNote: string;
    signInTitle: string;
    signInSubtext: string;
    menuOpenLabel: string;
    menuOpenHint: string;
    menuTutorialLabel: string;
    menuTutorialHint: string;
    /** The label on the button put on every garment. */
    pillLabel: string;
  };
  /** Extension behaviour the operator can change without shipping a new build. */
  extension: {
    /** Off pauses the Try On buttons on every page; the toolbar menu keeps working. */
    showPills: boolean;
    /** Hostnames where no Try On button ever appears (subdomains included). */
    blockedSites: string[];
    /** A message at the top of the toolbar menu. Empty text hides it. */
    announcement: { text: string; linkLabel: string; url: string };
  };
  /** tryoncam.com's words and switches — the dashboard's Website tab. */
  site: SiteContent;
  discovery: {
    /**
     * 'all': every product image on a shopping page. 'garments': only the
     * categories below.
     */
    mode: 'all' | 'garments';
    /** Which built-in categories this record has already been offered. */
    categoriesVersion?: number;
    /**
     * Categories offered a Try-On. The right set is per catalogue: a store
     * selling shorts needs `bottom`, one selling only dresses may not want it.
     */
    wearableCategories: string[];
  };
  /** Where customers write to. Every page that shows an email reads it from here. */
  contact: {
    supportEmail: string;
  };
  /** The picture shown when someone shares a tryoncam.com link. */
  share: {
    /** One of SHARE_IMAGES' ids, or an https link to an image. */
    image: string;
  };
  auth: {
    /** Public identifiers, not secrets — the browser sees them either way. */
    webClientId: string;
    extensionClientId: string;
    /** Operators who may open the dashboard (in addition to ADMIN_EMAILS). */
    allowedEmails: string[];
    required: boolean;
  };
  /** The pricing section of tryoncam.com. Plans come from the database; the words come from here. */
  pricing: {
    eyebrow: string;
    heading: string;
    lede: string;
    note: string;
    showFree: boolean;
    freeName: string;
    freeNote: string;
    freeFeatures: string[];
    freeCta: string;
    foot: { title: string; text: string }[];
  };
  billing: {
    /** Credits a new account starts with. */
    signupCredits: number;
    /** When off, signed-in customers try on without spending credits. */
    requireCredits: boolean;
  };
  /**
   * Run controls. Changed only through their own endpoints, never through a
   * settings save, so a dashboard holding a stale copy cannot undo a kill switch.
   */
  run: {
    activeProvider: ProviderId | null;
    killSwitch: boolean | null;
    sessionSeconds: number | null;
  };
};

/** The one-minute demo on YouTube (youtube.com/watch?v=ikWsa3Cd8UE). */
export const DEFAULT_SUPPORT_EMAIL = 'support@tryoncam.com';

/** Link-preview designs (1200x630), rendered by store/og/build.sh into site/assets/og/. */
export const SHARE_IMAGES = [
  { id: 'og-a', label: 'See it on you' },
  { id: 'og-b', label: 'Click Try On' },
  { id: 'og-c', label: 'Fitting room' },
  { id: 'og-d', label: 'Brand' },
  { id: 'og-e', label: 'Swap outfits' },
  { id: 'og-f', label: 'Try anything' },
].map((image) => ({ ...image, url: `https://tryoncam.com/assets/og/${image.id}.jpg` }));
export const DEFAULT_SHARE_IMAGE = { id: 'og-a', url: 'https://tryoncam.com/assets/og/og-a.jpg' };

/** The image URL a share-preview crawler should get for the chosen setting. */
export function shareImageUrl(choice: string): string {
  return SHARE_IMAGES.find((image) => image.id === choice)?.url ?? (isHttpsUrl(choice) ? choice : DEFAULT_SHARE_IMAGE.url);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function cleanShareImage(value: unknown): string {
  const choice = String(value ?? '').trim();
  if (!choice) return DEFAULT_SHARE_IMAGE.id;
  if (SHARE_IMAGES.some((image) => image.id === choice)) return choice;
  if (isHttpsUrl(choice) && choice.length <= 500) return choice;
  throw new Error('The link preview must be one of the designs, or an https link to an image.');
}

export const DEFAULT_TUTORIAL_VIDEO = 'ikWsa3Cd8UE';
/** Earlier defaults: a record still holding one of these gets the current default. */
const RETIRED_TUTORIAL_VIDEOS = ['https://tryoncam.com/assets/demo.mp4'];

const DEFAULTS: Settings = {
  // The one-minute demo; replace it from the dashboard.
  tutorial: { videoId: DEFAULT_TUTORIAL_VIDEO, title: 'How the trial room works' },
  texts: {
    panelTitle: 'Welcome to the Trial Room',
    dropHeadline: 'Hover any product and click Try On',
    dropSubtext: 'The Try On button appears on product photos as you shop.',
    startingTitle: 'Starting your session',
    startingNote: 'Getting the garment ready…',
    signInTitle: 'Sign in to try things on',
    signInSubtext: 'New accounts get free try-ons to start.',
    menuOpenLabel: 'Open the trial room',
    menuOpenHint: 'Hover any product and click Try On',
    menuTutorialLabel: 'Just watch the tutorial',
    menuTutorialHint: 'A 60-second walkthrough',
    pillLabel: 'Try On',
  },
  extension: { showPills: true, blockedSites: [], announcement: { text: '', linkLabel: '', url: '' } },
  site: mergeSite(undefined),
  discovery: {
    // Garments by default: the model dresses a torso, and jewellery comes back
    // as the wrong thing entirely (earrings rendered as a necklace).
    mode: 'garments',
    categoriesVersion: 2,
    wearableCategories: ['top', 'bottom', 'dress', 'outerwear', 'activewear', 'swimwear', 'lingerie', 'headwear'],
  },
  contact: { supportEmail: DEFAULT_SUPPORT_EMAIL },
  share: { image: 'og-a' },
  auth: { webClientId: '', extensionClientId: '', allowedEmails: [], required: true },
  pricing: {
    eyebrow: 'Pricing',
    heading: 'Pay for try-ons, not a subscription.',
    lede: 'Buy a pack of credits once and use them whenever you shop. No monthly fee, and credits never expire.',
    // {seconds} is filled in with the live session length from the run controls.
    note: '1 credit = 1 live session, up to {seconds} seconds, with unlimited garment swaps',
    showFree: true,
    freeName: 'Free',
    freeNote: 'no card needed',
    freeFeatures: ['Every feature, no watermark', 'Works on any clothing store', 'Unlimited swaps per session'],
    freeCta: 'Add to Chrome',
    foot: [
      { title: 'Credits never expire', text: 'Use them this week or next year.' },
      { title: 'Buy inside the extension', text: 'Top up any time after you sign in.' },
      { title: 'All sales are final', text: 'Try the free credits first.' },
    ],
  },
  billing: { signupCredits: 3, requireCredits: true },
  // Null means "whatever .env says", so a fresh store changes nothing.
  run: { activeProvider: null, killSwitch: null, sessionSeconds: null },
};

/** Deep merge over defaults, so a new field appears without a migration. */
function merge(stored: unknown): Settings {
  const source = (stored ?? {}) as Partial<Settings>;
  return {
    tutorial: withDefaultVideo({ ...DEFAULTS.tutorial, ...(source.tutorial ?? {}) }),
    texts: retireOldCopy({ ...DEFAULTS.texts, ...(source.texts ?? {}) }),
    extension: {
      ...DEFAULTS.extension,
      ...(source.extension ?? {}),
      announcement: { ...DEFAULTS.extension.announcement, ...(source.extension?.announcement ?? {}) },
    },
    site: mergeSite(source.site),
    discovery: addNewCategories({ ...DEFAULTS.discovery, ...(source.discovery ?? {}) }, source.discovery),
    contact: { ...DEFAULTS.contact, ...(source.contact ?? {}) },
    share: { ...DEFAULTS.share, ...(source.share ?? {}) },
    auth: { ...DEFAULTS.auth, ...(source.auth ?? {}) },
    pricing: retirePricingCopy({ ...DEFAULTS.pricing, ...(source.pricing ?? {}) }),
    billing: { ...DEFAULTS.billing, ...(source.billing ?? {}) },
    run: { ...DEFAULTS.run, ...(source.run ?? {}) },
  };
}

/** The old note hard-coded 15 seconds; saved copies of it follow the session length now. */
const RETIRED_NOTES = ['1 credit = 1 live session, up to 15 seconds, with unlimited garment swaps'];
function retirePricingCopy(pricing: Settings['pricing']): Settings['pricing'] {
  if (RETIRED_NOTES.includes(pricing.note)) pricing.note = DEFAULTS.pricing.note;
  return pricing;
}

/** Pricing copy as customers see it: `{seconds}` becomes the live session length. */
export function renderPricingCopy(pricing: Settings['pricing'], seconds: number): Settings['pricing'] {
  const fill = (text: string) => text.split('{seconds}').join(String(seconds));
  return { ...pricing, lede: fill(pricing.lede), note: fill(pricing.note) };
}

/**
 * Records saved before a default video existed hold an empty id, which would
 * keep the tutorial hidden forever. Empty only stays empty when an operator
 * cleared it on purpose.
 */
function withDefaultVideo(tutorial: Settings['tutorial']): Settings['tutorial'] {
  if (!tutorial.videoId && !tutorial.cleared) tutorial.videoId = DEFAULT_TUTORIAL_VIDEO;
  if (RETIRED_TUTORIAL_VIDEOS.includes(tutorial.videoId)) tutorial.videoId = DEFAULT_TUTORIAL_VIDEO;
  return tutorial;
}

/**
 * Copy that was once the default and has since been replaced. A stored record
 * saved from the dashboard holds the old default verbatim; this swaps it for
 * the new one without overwriting anything the operator actually wrote.
 */
const RETIRED_COPY: Partial<Record<keyof Settings['texts'], string>> = {
  signInSubtext: 'Your sessions are tracked against your account.',
  // Drag and drop was removed; saved copy that still describes it is replaced.
  dropHeadline: "Drag & drop anything you'd like to try",
  dropSubtext: 'or hover any product image and click Try On',
  menuOpenHint: 'Drag a garment in, or hover one on the page',
};

function retireOldCopy(texts: Settings['texts']): Settings['texts'] {
  for (const [key, old] of Object.entries(RETIRED_COPY) as [keyof Settings['texts'], string][]) {
    if (texts[key] === old) texts[key] = DEFAULTS.texts[key];
  }
  return texts;
}

/**
 * A category added after an operator saved their list would otherwise stay
 * off for them forever. Each is added once, tracked by version, so unticking
 * it afterwards sticks.
 */
const CATEGORY_VERSION = 2; // 2: headwear
function addNewCategories(
  discovery: Settings['discovery'],
  stored: Partial<Settings['discovery']> | undefined,
): Settings['discovery'] {
  // The version that counts is the stored one. The merged record always has
  // the default's, which is what made a saved list look already up to date.
  if (!stored?.wearableCategories) return discovery; // never saved: defaults already include everything
  if ((stored.categoriesVersion ?? 1) >= CATEGORY_VERSION) return discovery;
  const list = new Set(discovery.wearableCategories);
  list.add('headwear');
  return { ...discovery, wearableCategories: [...list], categoriesVersion: CATEGORY_VERSION };
}

/** The .env values, captured before any stored override is applied. */
const ENV_RUN = { ...runtime };

/** Makes the stored run controls the live ones, falling back to .env for anything unset. */
function applyRun(settings: Settings): void {
  const run = settings.run;
  runtime.activeProvider = isProviderId(run.activeProvider) ? run.activeProvider : ENV_RUN.activeProvider;
  runtime.killSwitch = typeof run.killSwitch === 'boolean' ? run.killSwitch : ENV_RUN.killSwitch;
  runtime.sessionSeconds =
    typeof run.sessionSeconds === 'number' && run.sessionSeconds > 0 ? run.sessionSeconds : ENV_RUN.sessionSeconds;
}

/**
 * Settings live in the store, cached in memory with a synchronous reader.
 *
 * The reader has to be synchronous because the auth layer consults it from
 * `readSessionToken`, which sits on a synchronous path. Making that async
 * would ripple through every request guard for a value that changes rarely.
 *
 * `refreshSettings` keeps the cache honest: called once at boot for a
 * long-lived process, and per invocation (TTL-guarded) on serverless, where
 * a cold start would otherwise serve defaults and a warm one stale values.
 */
let cache: Settings = { ...DEFAULTS };
let loadedAt = 0;

/** Env is the source of truth for client IDs whenever it supplies them. */
function applyEnvOverrides(settings: Settings): Settings {
  const web = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
  const ext = (process.env.GOOGLE_EXTENSION_CLIENT_ID ?? '').trim();
  if (web) settings.auth.webClientId = web;
  if (ext) settings.auth.extensionClientId = ext;
  return settings;
}

export async function refreshSettings(maxAgeMs = 0): Promise<Settings> {
  if (maxAgeMs > 0 && Date.now() - loadedAt < maxAgeMs) return cache;
  const [stored] = await Promise.all([
    getStore().settings(),
    // Keys and limits saved from the Environment tab ride the same refresh,
    // so a change reaches every instance on the same 30-second clock.
    refreshOverrides(),
  ]);
  cache = applyEnvOverrides(merge(stored));
  applyRun(cache);
  loadedAt = Date.now();
  return cache;
}

/** The cached record. Call `refreshSettings` first on a cold path. */
export function readSettings(): Settings {
  return cache;
}

export async function writeSettings(patch: unknown): Promise<Settings> {
  const current = readSettings();
  const incoming = (patch ?? {}) as Partial<Settings>;
  const next: Settings = {
    tutorial: { ...current.tutorial, ...(incoming.tutorial ?? {}) },
    texts: { ...current.texts, ...(incoming.texts ?? {}) },
    extension: {
      ...current.extension,
      ...(incoming.extension ?? {}),
      announcement: { ...current.extension.announcement, ...(incoming.extension?.announcement ?? {}) },
    },
    // The Website tab sends the whole record; anything missing keeps its saved value.
    site: incoming.site ? mergeSite({ ...current.site, ...incoming.site }) : current.site,
    discovery: { ...current.discovery, ...(incoming.discovery ?? {}) },
    contact: { ...current.contact, ...(incoming.contact ?? {}) },
    share: { ...current.share, ...(incoming.share ?? {}) },
    auth: { ...current.auth, ...(incoming.auth ?? {}) },
    pricing: { ...current.pricing, ...(incoming.pricing ?? {}) },
    billing: { ...current.billing, ...(incoming.billing ?? {}) },
    run: { ...current.run, ...(incoming.run ?? {}) },
  };

  next.pricing = retirePricingCopy(cleanPricing(next.pricing));
  next.site = cleanSite(next.site);
  next.extension = cleanExtension(next.extension);
  next.texts.pillLabel = String(next.texts.pillLabel ?? '').trim().slice(0, 24) || DEFAULTS.texts.pillLabel;
  next.contact.supportEmail = cleanEmail(next.contact.supportEmail);
  next.share.image = cleanShareImage(next.share.image);

  // Normalise the bits that are easy to get wrong by hand.
  next.tutorial.videoId = extractVideoId(next.tutorial.videoId);
  next.tutorial.cleared = !next.tutorial.videoId;
  next.discovery.mode = next.discovery.mode === 'all' ? 'all' : 'garments';
  next.texts = retireOldCopy(next.texts);
  next.auth.allowedEmails = (next.auth.allowedEmails ?? [])
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);

  next.billing.signupCredits = Math.min(Math.max(Math.round(Number(next.billing.signupCredits) || 0), 0), 100);
  next.billing.requireCredits = next.billing.requireCredits !== false;

  await getStore().saveSettings(next);
  cache = applyEnvOverrides(next);
  applyRun(cache);
  loadedAt = Date.now();
  return cache;
}

/** Persists one run control so every instance sees it, not just this one. */
export async function writeRun(patch: Partial<Settings['run']>): Promise<Settings> {
  // Read fresh: another instance may have changed a different control since.
  const current = await refreshSettings();
  return writeSettings({ run: { ...current.run, ...patch } });
}

/**
 * The support address is shown on public pages and put into mailto: links, so
 * only a plain address is accepted; anything else is a mistake and refused.
 */
export class SettingsError extends Error {}
export function cleanEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return DEFAULT_SUPPORT_EMAIL;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 120) {
    throw new SettingsError(`"${String(value).slice(0, 60)}" is not an email address.`);
  }
  return email;
}

/**
 * Blocked sites arrive as whatever was pasted — full links, "www." prefixes,
 * one per line or comma-separated — and are stored as bare hostnames.
 */
export function cleanHostList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const hosts = raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry.includes('://') ? entry : `https://${entry}`).hostname;
      } catch {
        return '';
      }
    })
    .map((host) => host.replace(/^www\./, ''))
    .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host));
  return [...new Set(hosts)].slice(0, 200);
}

function cleanExtension(ext: Settings['extension']): Settings['extension'] {
  const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  const url = text(ext.announcement?.url, 500);
  if (url) {
    let ok = false;
    try {
      ok = new URL(url).protocol === 'https:';
    } catch {
      /* not a URL */
    }
    if (!ok) throw new SettingsError('The announcement link must be an https link.');
  }
  return {
    showPills: ext.showPills !== false,
    blockedSites: cleanHostList(ext.blockedSites),
    announcement: { text: text(ext.announcement?.text, 160), linkLabel: text(ext.announcement?.linkLabel, 30), url },
  };
}

/** Trims the copy and keeps list shapes sane, whatever the form sent. */
function cleanPricing(p: Settings['pricing']): Settings['pricing'] {
  const text = (v: unknown, max = 240) => String(v ?? '').trim().slice(0, max);
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => text(x, 120)).filter(Boolean).slice(0, 8);
  const foot = (Array.isArray(p.foot) ? p.foot : [])
    .map((f) => ({ title: text(f?.title, 60), text: text(f?.text, 140) }))
    .filter((f) => f.title)
    .slice(0, 3);
  return {
    eyebrow: text(p.eyebrow, 40),
    heading: text(p.heading, 120),
    lede: text(p.lede, 300),
    note: text(p.note, 160),
    showFree: p.showFree !== false,
    freeName: text(p.freeName, 40),
    freeNote: text(p.freeNote, 80),
    freeFeatures: list(p.freeFeatures),
    freeCta: text(p.freeCta, 40),
    foot,
  };
}

/** What the extension is allowed to read without signing in. */
export function publicSettings() {
  const settings = readSettings();
  return {
    tutorial: settings.tutorial,
    texts: settings.texts,
    extension: settings.extension,
    discovery: settings.discovery,
    auth: {
      configured: Boolean(settings.auth.webClientId || settings.auth.extensionClientId),
      // The extension signs in through this client with launchWebAuthFlow. It
      // is an identifier, not a secret: Google shows it in every sign-in URL.
      webClientId: settings.auth.webClientId,
    },
    billing: { signupCredits: settings.billing.signupCredits, requireCredits: settings.billing.requireCredits },
  };
}
