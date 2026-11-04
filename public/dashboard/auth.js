/**
 * Dashboard sign-in: an admin's Google account, or the shared password.
 *
 * Google goes through Google Identity Services. That script is the one remote
 * dependency here and it has to be: Google will not verify a credential minted
 * by a copy we host. The extension cannot load it (MV3 forbids remote code), so
 * it signs in with chrome.identity.launchWebAuthFlow against the same client.
 *
 * The password stays available alongside Google, so configuring Google can
 * never lock the operator out of the screen where Google is configured.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(script);
  });
}

function showError(message) {
  const el = $('gateError');
  el.hidden = !message;
  el.textContent = message ?? '';
}

/**
 * @returns {Promise<{configured:boolean, user:object|null}>}
 */
export async function initAuth({ onSignedIn }) {
  const state = await (await fetch('/api/auth/me')).json();

  // Locked when the password gate is up and unmet, or — with no password set —
  // when Google sign-in is required and nobody (or a non-admin) is signed in.
  const locked = state.gate?.required
    ? !state.gate.satisfied
    : state.configured && state.required && !state.user?.admin;

  if (!locked) {
    renderChip(state.user, state);
    return state;
  }

  const user = await lockScreen(state);
  renderChip(user, state);
  onSignedIn?.(user);
  return state;
}

/**
 * Blocks until either way in succeeds.
 *
 * A promise rather than a callback so the caller can simply await it — nothing
 * else on the page should run while the lock screen is up.
 */
function lockScreen(state) {
  const gate = $('gate');
  const passwordForm = $('gatePassword');
  const googleSlot = $('gateGoogle');
  const withPassword = Boolean(state.gate?.required);
  const withGoogle = Boolean(state.configured && state.clientId);

  $('gateTitle').textContent = 'Sign in to the dashboard';
  $('gateBlurb').textContent = withGoogle
    ? 'Use an admin Google account' + (withPassword ? ', or the dashboard password.' : '.')
    : 'This install is behind a shared password until Google sign-in is configured.';
  $('googleButton').hidden = true; // superseded by #gateGoogle
  passwordForm.hidden = !withPassword;
  googleSlot.hidden = !withGoogle;
  $('gateOr').hidden = !(withPassword && withGoogle);
  if (state.user && !state.user.admin) showError(`${state.user.email} is not an admin of this dashboard.`);
  gate.hidden = false;
  if (withPassword) $('gatePasswordInput').focus();

  return new Promise((resolve) => {
    const done = (user) => {
      gate.hidden = true;
      resolve(user);
    };

    if (withPassword) {
      const input = $('gatePasswordInput');
      passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = passwordForm.querySelector('button');
        button.disabled = true;
        showError(null);
        try {
          const response = await fetch('/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: input.value }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            showError(body.error ?? 'That password is not right.');
            input.select();
            return;
          }
          done(null);
        } finally {
          button.disabled = false;
        }
      });
    }

    if (withGoogle) {
      loadGis()
        .then(() => {
          google.accounts.id.initialize({
            client_id: state.clientId,
            callback: async ({ credential }) => {
              showError(null);
              const response = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential }),
              });
              const body = await response.json().catch(() => ({}));
              if (!response.ok) {
                showError(body.error ?? 'Sign-in failed.');
                return;
              }
              done(body.user);
            },
          });
          google.accounts.id.renderButton(googleSlot, {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'pill',
          });
        })
        .catch((error) => showError(error.message));
    }
  });
}

function renderChip(user, state) {
  const host = $('auth');
  if (!host) return;
  if (!user) {
    // Signed in by password, or nothing configured: offer a way to lock again.
    host.innerHTML = state.gate?.required
      ? '<button class="auth-out" type="button">Lock</button>'
      : state.configured
        ? ''
        : '<span class="hint" title="Add a Google client ID in Settings to enable">Sign-in off</span>';
  } else {
    host.innerHTML = `
      ${user.picture ? `<img src="${esc(user.picture)}" alt="">` : ''}
      <span class="auth-name">${esc(user.name)}</span>
      <button class="auth-out" type="button">Sign out</button>`;
  }
  host.querySelector('.auth-out')?.addEventListener('click', async () => {
    await fetch('/api/auth/signout', { method: 'POST' });
    location.reload();
  });
}
