/**
 * Toolbar menu. Everything here delegates to the content script or the worker;
 * the popup itself closes the moment it is clicked, so it holds no state.
 */
/**
 * Every reply is checked for runtime.lastError. Reading it is what marks it
 * handled; left unread, a worker that never answered (an old worker after an
 * update, a message type it does not know) lands on chrome://extensions as an
 * "Unchecked runtime.lastError".
 */
const send = (message) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (reply) => {
      const failure = chrome.runtime.lastError;
      resolve(failure ? { ok: false, error: failure.message } : reply ?? { ok: false, error: 'No reply from the extension.' });
    }),
  );

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function note(text) {
  const el = document.getElementById('note');
  el.hidden = !text;
  el.textContent = text ?? '';
}

/** The content script is absent on pages the gate rejected, and on chrome://. */
async function tellPage(message) {
  const tab = await activeTab();
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    window.close();
    return true;
  } catch {
    note('Not available on this page — open a shopping site and try again.');
    return false;
  }
}

document.querySelector('[data-action="open"]').addEventListener('click', () => tellPage({ type: 'OPEN_PANEL' }));
document.querySelector('[data-action="tutorial"]').addEventListener('click', () => tellPage({ type: 'OPEN_TUTORIAL' }));

const GOOGLE_G = `<svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true">
  <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6Z"/>
  <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2a5.4 5.4 0 0 1-8.1-2.8H1v2.3A9 9 0 0 0 9 18Z"/>
  <path fill="#FBBC05" d="M3.96 10.7a5.4 5.4 0 0 1 0-3.4V5H1a9 9 0 0 0 0 8l3-2.3Z"/>
  <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.3A9 9 0 0 0 1 5l3 2.3A5.4 5.4 0 0 1 9 3.6Z"/>
</svg>`;

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderSignedOut(host) {
  host.innerHTML = `<button class="google-btn" type="button">${GOOGLE_G}Sign in with Google</button>`;
  const button = host.querySelector('button');
  button.addEventListener('click', async () => {
    button.disabled = true;
    note(null);
    const result = await send({ type: 'SIGN_IN' });
    if (result?.ok) location.reload();
    else {
      button.disabled = false;
      note(result?.error ?? 'Sign-in failed.');
    }
  });
}

/**
 * Opens the account page already signed in, straight from here rather than
 * through the service worker. Chrome re-reads this menu from disk every time,
 * but keeps running an old worker until the extension is reloaded — so a
 * worker message could meet a worker that has never heard of it.
 * The session rides in the URL fragment, which is never sent to a server.
 */
async function openAccount() {
  const { session, backendUrl } = await chrome.storage.local.get(['session', 'backendUrl']);
  const base = typeof backendUrl === 'string' && /^https?:\/\//i.test(backendUrl)
    ? backendUrl.replace(/\/+$/, '')
    : 'https://app.tryoncam.com';
  await chrome.tabs.create({ url: `${base}/account/${session ? `#handoff=${encodeURIComponent(session)}` : ''}` });
}

function renderSignedIn(host, user, requireCredits) {
  const credits =
    requireCredits && typeof user.credits === 'number'
      ? `${user.credits} ${user.credits === 1 ? 'session' : 'sessions'} left`
      : user.admin ? 'Operator · try-ons are free' : 'Try-ons are free right now';
  // Sign-in is replaced, not joined: once signed in, the one button is the
  // way to the account page, where credits and purchases live.
  host.innerHTML = `
    <button class="google-btn account-btn" type="button" data-role="account">
      ${user.picture ? `<img src="${escapeHtml(user.picture)}" alt="" referrerpolicy="no-referrer">` : ''}
      Go to your account
    </button>
    <div class="acct-meta"><span>${escapeHtml(user.name)} · ${credits}</span>
      <button class="link-btn" type="button" data-role="out">Sign out</button></div>`;

  host.querySelector('[data-role="account"]').addEventListener('click', async () => {
    try {
      await openAccount();
      window.close();
    } catch (error) {
      note(`Could not open your account: ${error.message ?? error}`);
    }
  });
  host.querySelector('[data-role="out"]').addEventListener('click', async () => {
    await send({ type: 'SIGN_OUT' });
    location.reload();
  });
}

/**
 * The menu's wording is edited in the dashboard; the tutorial entry appears
 * only once a video is set, so a customer never meets an empty player.
 */
async function applySettings() {
  const result = await send({ type: 'SETTINGS' });
  const settings = result?.settings;
  if (!settings) return;
  for (const el of document.querySelectorAll('[data-copy]')) {
    const text = settings.texts?.[el.dataset.copy];
    if (text) el.textContent = text;
  }
  document.querySelector('[data-action="tutorial"]').hidden = !String(settings.tutorial?.videoId ?? '').trim();
  showAnnouncement(settings.extension?.announcement);
}

/** A note from the dashboard at the top of the menu. Text only; the link must be https. */
function showAnnouncement(announcement) {
  const box = document.getElementById('announce');
  const text = String(announcement?.text ?? '').trim();
  box.hidden = !text;
  if (!text) return;
  box.querySelector('[data-role="text"]').textContent = text;
  const link = box.querySelector('[data-role="link"]');
  let url = null;
  try {
    url = new URL(String(announcement.url ?? ''));
  } catch {
    /* no link */
  }
  link.hidden = !url || url.protocol !== 'https:';
  if (link.hidden) return;
  link.href = url.href;
  link.textContent = `${String(announcement.linkLabel ?? '').trim() || 'Learn more'} →`;
}

(async () => {
  applySettings();
  // Deliberately no budget or spend here. This menu is what a customer sees;
  // what the try-on costs us is operator information and belongs in the
  // dashboard, behind sign-in.
  const reachable = await send({ type: 'HEALTH' }).catch(() => null);
  document.getElementById('status').textContent = reachable?.ok ? 'Ready' : 'Offline — try again shortly';
  if (!reachable?.ok) {
    // Say what is wrong. Hiding the sign-in button without a word made a
    // blocked connection look like sign-in had been switched off.
    note("Can't reach tryoncam. Check your internet connection, VPN or firewall, then reopen this menu.");
  }

  const host = document.getElementById('account');
  const auth = await send({ type: 'AUTH_STATE' }).catch(() => null);
  if (!auth?.ok || !auth.configured) {
    host.textContent = auth?.offline ? '' : 'Sign-in is not available yet';
    return;
  }
  if (!auth.user) {
    renderSignedOut(host);
    return;
  }
  // Show what we have at once, then refresh the balance from the backend.
  renderSignedIn(host, auth.user, auth.requireCredits);
  const fresh = await send({ type: 'ACCOUNT' });
  if (fresh?.ok && fresh.user) renderSignedIn(host, fresh.user, fresh.requireCredits);
  else if (fresh?.reason === 'unauthenticated') renderSignedOut(host);
})();
