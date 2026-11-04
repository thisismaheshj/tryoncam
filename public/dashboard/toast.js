/**
 * Toasts: confirmation that appears where the operator is looking.
 *
 * Each tab used to write its message into a bar at the top of the tab, which
 * is off-screen by the time you press a Save button at the bottom — so a
 * successful save looked exactly like nothing happening.
 */

const FAILURE = /^(could not|not saved|nothing|paste|enter)/i;

let stack = null;
function host() {
  if (stack?.isConnected) return stack;
  stack = document.createElement('div');
  stack.className = 'toasts';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}

/** `ok` defaults from the wording, so existing callers need no change. */
export function toast(message, ok = !FAILURE.test(String(message))) {
  const el = document.createElement('div');
  el.className = `toast ${ok ? 'ok' : 'bad'}`;
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${ok ? '✓' : '!'}</span><span class="toast-text"></span>
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  el.querySelector('.toast-text').textContent = message;
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  host().appendChild(el);
  setTimeout(close, ok ? 4000 : 8000);
}
