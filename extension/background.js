/**
 * Service worker. Two jobs, both of which must not happen in the page:
 *
 *  1. Fetch garment bytes. `host_permissions: <all_urls>` means a fetch from
 *     here is not subject to the page's CORS rules, and the returned data: URL
 *     does not taint a canvas. This is how Anywear does it, and it is why the
 *     extension needs no backend for images.
 *  2. Talk to our backend for session minting, so the budget guardrails and
 *     the API key stay server-side.
 */

/**
 * Where the backend lives.
 *
 * Overridable from chrome.storage so the same build can point at localhost
 * during development and the deployed backend in use, without editing code
 * and reloading the unpacked extension.
 */
const DEFAULT_BACKEND = 'https://app.tryoncam.com';
let BACKEND = DEFAULT_BACKEND;

chrome.storage.local.get('backendUrl', ({ backendUrl }) => {
  if (typeof backendUrl === 'string' && /^https?:\/\//i.test(backendUrl)) {
    BACKEND = backendUrl.replace(/\/+$/, '');
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.backendUrl) return;
  const next = changes.backendUrl.newValue;
  BACKEND = typeof next === 'string' && next ? next.replace(/\/+$/, '') : DEFAULT_BACKEND;
});

/**
 * First install opens the welcome page: the one-minute demo plus a sample
 * shop to try it on. Updates and Chrome restarts do not; only a fresh install.
 * Registered at the top level so the service worker catches the event.
 */
const WELCOME_URL = 'https://tryoncam.com/demo.html?installed=1';
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: WELCOME_URL });
  }
});

/**
 * Google sign-in through chrome.identity.launchWebAuthFlow.
 *
 * Not getAuthToken: that needs the OAuth client ID baked into manifest.json,
 * works only in Google Chrome with a signed-in profile, and returns an access
 * token whose audience the backend cannot check. This flow uses the same Web
 * client as the dashboard — its ID arrives with the on-air settings — and
 * returns an ID token the backend verifies was issued to *us*, bound to a
 * nonce chosen here.
 *
 * Google needs https://<extension-id>.chromiumapp.org/ listed as an
 * authorised redirect URI on that client. The dashboard shows the exact value.
 */
function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signIn() {
  const { settings } = await handlers.SETTINGS();
  const clientId = settings?.auth?.webClientId;
  if (!clientId) throw new Error('Sign-in is not set up yet. Please try again later.');

  const nonce = randomNonce();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  }).toString();

  const redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  const fragment = new URLSearchParams(new URL(redirect).hash.slice(1));
  const idToken = fragment.get('id_token');
  if (!idToken) throw new Error(fragment.get('error_description') ?? fragment.get('error') ?? 'Google returned no sign-in.');

  const result = await backend('/api/auth/extension', {
    method: 'POST',
    body: JSON.stringify({ idToken, nonce }),
    // Never send a stale session along with a fresh sign-in.
    headers: { Authorization: '' },
  });
  await chrome.storage.local.set({ session: result.sessionToken, user: result.user });
  return result.user;
}

async function currentSession() {
  const { session, user } = await chrome.storage.local.get(['session', 'user']);
  return { session: session ?? null, user: user ?? null };
}

async function signOut() {
  // launchWebAuthFlow leaves nothing cached in Chrome; the session token is
  // the whole of our sign-in state.
  await chrome.storage.local.remove(['session', 'user']);
}

/** Hotlink protection tests the Referer against the page, not the image host. */
function refererFor(pageUrl) {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).origin + '/';
  } catch {
    return null;
  }
}

async function fetchBlob(url, pageUrl) {
  const headers = {
    // Ask for widely-decodable formats first. The widget re-encodes to JPEG
    // anyway, but there is no reason to pull an AVIF we then have to transcode.
    Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
  };
  const referer = refererFor(pageUrl);
  if (referer) headers.Referer = referer;

  const response = await fetch(url, { headers, credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`not an image (${blob.type || 'unknown'})`);
  return blob;
}

function toDataUrl(blob, bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/**
 * Picks the sharpest source available for a garment.
 *
 * A CDN may quietly ignore an upgraded width parameter and hand back the
 * original thumbnail, so candidates are *measured* rather than trusted:
 * each is decoded and the widest wins. This is the difference between
 * sending the model a 128px thumbnail and a 2160px product shot.
 *
 * Stops early once a candidate is comfortably large, so the common case
 * costs one request.
 */
async function bestGarmentImage(candidates, pageUrl) {
  const GOOD_ENOUGH = 1200;
  const tried = [];
  let best = null;

  for (const url of candidates.slice(0, 5)) {
    try {
      const blob = await fetchBlob(url, pageUrl);
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close?.();
      tried.push({ url: url.slice(0, 90), width, height });

      if (!best || width > best.width) best = { url, blob, width, height };
      if (width >= GOOD_ENOUGH) break;
    } catch (error) {
      tried.push({ url: url.slice(0, 90), error: String(error.message ?? error) });
    }
  }

  if (!best) throw new Error(`no candidate loaded (${tried.length} tried)`);

  const bytes = new Uint8Array(await best.blob.arrayBuffer());
  return {
    dataUrl: toDataUrl(best.blob, bytes),
    width: best.width,
    height: best.height,
    chosen: best.url,
    tried,
  };
}

async function backend(path, options = {}) {
  // Attach the session so the backend can attribute what we spend.
  let auth = {};
  try {
    const { session } = await chrome.storage.local.get('session');
    if (session) auth = { Authorization: `Bearer ${session}` };
  } catch {
    // Storage unavailable; call unauthenticated.
  }
  const headers = { 'Content-Type': 'application/json', ...auth, ...(options.headers ?? {}) };
  if (!headers.Authorization) delete headers.Authorization;
  const response = await fetch(`${BACKEND}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // An expired or revoked session: forget it, so the UI offers sign-in
    // rather than repeating a request that can only fail.
    if (response.status === 401 && data?.reason === 'unauthenticated') await signOut();
    const error = new Error(data?.error ?? `Backend HTTP ${response.status}`);
    // The UI branches on these — "sign in" and "buy credits" are different
    // screens, and matching on message text broke the first time copy changed.
    error.status = response.status;
    error.reason = data?.reason ?? null;
    throw error;
  }
  return data;
}

/**
 * Settings are remembered in storage, not just in memory: Chrome stops this
 * service worker after ~30 seconds idle, which wiped an in-memory cache, so
 * nearly every page load in every tab went back to the server. That steady
 * trickle of /api/settings calls was most of the backend's CPU.
 */
const SETTINGS_TTL_MS = 10 * 60_000;
let settingsCache = null;
// One request shared by every tab that asks while it is in flight.
let settingsInFlight = null;

async function rememberCredits(credits) {
  const { user } = await chrome.storage.local.get('user');
  if (user) await chrome.storage.local.set({ user: { ...user, credits } });
}

const handlers = {
  async FETCH_IMAGE({ candidates, url, pageUrl }) {
    const list = Array.isArray(candidates) && candidates.length ? candidates : [url];
    const result = await bestGarmentImage(list, pageUrl);
    console.log(
      `[try-on] garment ${result.width}x${result.height} from ${result.chosen.slice(0, 80)}`,
      result.tried,
    );
    return result;
  },

  async CREATE_SESSION({ garmentUrl, seconds }) {
    const result = await backend('/api/session', {
      method: 'POST',
      body: JSON.stringify({ garmentUrl, seconds, prompt: '' }),
    });
    if (typeof result?.creditsLeft === 'number') await rememberCredits(result.creditsLeft);
    return result;
  },

  async MARK_STARTED({ sessionId }) {
    return backend(`/api/session/${sessionId}/started`, { method: 'POST' });
  },

  async END_SESSION({ sessionId, timeToFirstFrameMs, note }) {
    return backend(`/api/session/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ timeToFirstFrameMs, note }),
    });
  },

  /** Operator-editable copy and the tutorial video, cached briefly. */
  /**
   * Operator-editable copy, the tutorial video and the sign-in client ID.
   *
   * The last good copy is kept in storage and used when the backend cannot be
   * reached, so a flaky connection does not make the extension forget that
   * sign-in exists. `offline` tells the UI to say so rather than pretend.
   */
  async SETTINGS() {
    const now = Date.now();
    if (!settingsCache) {
      const { lastSettings, lastSettingsAt, lastSettingsBackend } = await chrome.storage.local.get([
        'lastSettings', 'lastSettingsAt', 'lastSettingsBackend',
      ]);
      if (lastSettings && lastSettingsBackend === BACKEND) settingsCache = { value: lastSettings, at: lastSettingsAt ?? 0 };
    }
    if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return { settings: settingsCache.value };

    settingsInFlight ??= (async () => {
      try {
        // The same for everyone, so sent without the session: the server and
        // Vercel's CDN can then answer it from cache.
        const value = await backend('/api/settings', { headers: { Authorization: '' } });
        settingsCache = { value, at: Date.now() };
        await chrome.storage.local.set({ lastSettings: value, lastSettingsAt: settingsCache.at, lastSettingsBackend: BACKEND });
        return { settings: value };
      } catch (error) {
        const { lastSettings } = await chrome.storage.local.get('lastSettings');
        if (lastSettings) return { settings: lastSettings, offline: true };
        throw error;
      } finally {
        settingsInFlight = null;
      }
    })();
    return settingsInFlight;
  },

  /** Reachability only. Spend is operator information and stays in the dashboard. */
  async HEALTH() {
    return backend('/api/health');
  },

  /** Signed-in user with a fresh credit balance. */
  async ACCOUNT() {
    const { session } = await currentSession();
    if (!session) return { user: null };
    const me = await backend('/api/billing/me');
    await chrome.storage.local.set({ user: me.user });
    return { user: me.user, requireCredits: me.requireCredits, hasPurchases: me.hasPurchases };
  },

  async PLANS() {
    return backend('/api/billing/plans');
  },

  /** Stripe Checkout opens in its own tab; the panel waits for the return. */
  async CHECKOUT({ planId }) {
    const { url } = await backend('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ planId }) });
    await chrome.tabs.create({ url });
    return {};
  },

  /**
   * Opens the account page already signed in. The session rides in the URL
   * fragment, which the browser never sends to a server; the page trades it
   * for a cookie and strips it from the address bar.
   */
  async OPEN_ACCOUNT({ section } = {}) {
    const { session } = await currentSession();
    const query = typeof section === 'string' && /^[a-z]+$/.test(section) ? `?section=${section}` : '';
    const url = `${BACKEND}/account/${query}${session ? `#handoff=${encodeURIComponent(session)}` : ''}`;
    await chrome.tabs.create({ url });
    return {};
  },

  async BILLING_PORTAL() {
    const { url } = await backend('/api/billing/portal', { method: 'POST' });
    await chrome.tabs.create({ url });
    return {};
  },

  async GET_BACKEND() {
    const { backendUrl } = await chrome.storage.local.get('backendUrl');
    return { backendUrl: backendUrl ?? '', effective: BACKEND, default: DEFAULT_BACKEND };
  },

  async SET_BACKEND({ url }) {
    const clean = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (clean && !/^https?:\/\//i.test(clean)) throw new Error('Must be an absolute http(s) URL.');
    if (clean) await chrome.storage.local.set({ backendUrl: clean });
    else await chrome.storage.local.remove('backendUrl');
    BACKEND = clean || DEFAULT_BACKEND;
    settingsCache = null; // copy and video may differ on another backend
    await chrome.storage.local.remove('lastSettingsAt');
    return { effective: BACKEND };
  },

  async AUTH_STATE() {
    const [{ user }, { settings, offline }] = await Promise.all([
      currentSession(),
      handlers.SETTINGS().catch(() => ({ settings: null, offline: true })),
    ]);
    return {
      offline: Boolean(offline),
      configured: Boolean(settings?.auth?.webClientId),
      requireCredits: settings?.billing?.requireCredits !== false,
      user,
    };
  },

  async SIGN_IN() {
    return { user: await signIn() };
  },

  async SIGN_OUT() {
    await signOut();
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String(error?.message ?? error),
        status: error?.status ?? null,
        reason: error?.reason ?? null,
      }),
    );
  return true; // Keep the channel open for the async reply.
});
