import { prepareGarment } from './image-utils.js';
import { createConsoleLogger, createDecartClient, models } from './vendor/decart-sdk.js';

/**
 * The try-on surface. Runs at the chrome-extension:// origin inside an iframe
 * that carries allow="camera", which is what makes getUserMedia work in-page.
 *
 * The garment arrives as a data: URL already fetched by the service worker, so
 * there is no CORS to negotiate and the SDK reads the base64 straight out of it.
 */

const el = (id) => document.getElementById(id);
const output = el('output');
const local = el('local');
const overlay = el('overlay');
const msg = el('msg');
const meter = el('meter');
const countdown = el('countdown');

let realtime = null;
let stream = null;
let timer = null;
let sessionId = null;
let ttff = null;
/** Set while end() is running, so the SDK's own disconnect cannot re-enter it. */
let ending = false;
/** True once we have asked to stop, so an expected disconnect is not reported as a fault. */
let stopping = false;
/** Why Decart ended the session, when it says. Beats the generic "connection lost". */
let endReason = null;
/** Seconds of generation Decart itself has counted — the clock its cap runs on. */
let decartSeconds = 0;
/** Length of this session, in generation seconds. */
let sessionSeconds = 0;

const toParent = (message) => parent.postMessage(message, '*');

function status(text, { overlayed = true } = {}) {
  msg.textContent = text;
  overlay.hidden = !overlayed;
  toParent({ type: 'TRYON_STATUS', text });
}

// lastError is read so a missing reply never surfaces as an unchecked error.
const send = (message) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (reply) => {
      const failure = chrome.runtime.lastError;
      resolve(failure ? { ok: false, error: failure.message } : reply ?? { ok: false, error: 'No reply from the extension.' });
    }),
  );

async function begin({ grant, sessionId: id, seconds, imageDataUrl }) {
  sessionId = id;
  ending = false;
  stopping = false;
  ttff = null;
  endReason = null;
  decartSeconds = 0;
  sessionSeconds = seconds;
  const model = models.realtime(grant.model);

  // Re-encoding the garment takes a moment; do it while the camera and the
  // connection come up, not after, so it is ready the instant Decart is.
  const garmentReady = prepareGarment(imageDataUrl);
  garmentReady.catch(() => {}); // awaited below; this only silences an early rejection

  try {
    status('Requesting camera…');
    // Anywear overrides getUserMedia to 1088x624 landscape with no frameRate
    // constraint. Fewer pixels per frame is the single biggest latency lever
    // available to us: the model's own 1280x720 is ~35% more to encode and
    // send every frame, for no visible benefit at this panel size.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1088 }, height: { ideal: 624 }, facingMode: 'user' },
    });
    local.srcObject = stream;

    status('Connecting…');
    const client = createDecartClient({
      apiKey: grant.clientToken,
      // The SDK logs at "warn" by default, and its normal teardown emits
      // "room disconnected" / "websocket closed" at that level — which Chrome
      // files under Errors for the whole extension. Keep real errors, drop
      // the expected end-of-session chatter.
      logger: createConsoleLogger('error'),
    });
    const startedAt = performance.now();

    realtime = await client.realtime.connect(stream, {
      model,
      // `mirror` makes the SDK flip every inbound frame through a canvas
      // before it is published — a per-frame cost on the latency path. The
      // display is flipped with a CSS transform instead, which is free and is
      // what Decart's own e-commerce example does.
      mirror: false,
      onRemoteStream: (remote) => {
        output.srcObject = remote;
      },
    });

    realtime.on('connectionChange', (state) => {
      if (state === 'generating') {
        overlay.hidden = true;
        if (ttff === null) {
          ttff = Math.round(performance.now() - startedAt);
          toParent({ type: 'TRYON_STATUS', text: `Live — first frame in ${ttff} ms` });
          // The session is live from the first generated frame: that is when
          // the credit counts and when the countdown starts.
          send({ type: 'MARK_STARTED', sessionId });
          startMeter();
        } else {
          toParent({ type: 'TRYON_STATUS', text: 'Live' });
        }
      }
      // The SDK retries a dropped connection on its own. Say so, instead of
      // leaving a frozen frame that looks like the app hung.
      if (state === 'reconnecting' && !stopping) status('Connection dropped — reconnecting…');
      // A disconnect we asked for is not a fault; reporting it would also
      // overwrite the real reason the session ended.
      if (state === 'disconnected' && !stopping) {
        end(describeEnd(endReason) ?? 'Connection lost — check your internet connection and try again.', {
          note: endReason ? `Ended by Decart: ${endReason}` : 'Connection lost.',
        });
      }
    });
    // Decart's own generation clock and its reasons for ending a session.
    realtime.on('generationTick', ({ seconds: counted }) => {
      decartSeconds = Math.max(decartSeconds, Number(counted) || 0);
      paintMeter(decartSeconds);
    });
    realtime.on('generationEnded', ({ seconds: counted, reason }) => {
      decartSeconds = Math.max(decartSeconds, Number(counted) || 0);
      endReason = reason ?? endReason;
      // Time, credit or moderation: end now. Left alone, the SDK reads the
      // closed socket as a network drop and reconnects — which would start,
      // and bill, a session nobody asked for.
      const told = describeEnd(reason);
      if (told && !stopping) end(told, { note: `Ended by Decart: ${reason}` });
    });
    realtime.on('sessionEnded', ({ reason }) => {
      endReason = reason ?? endReason;
    });

    // Retailers serve enormous originals — H&M ships 2333x3500 at 1MB, which
    // becomes ~1.3MB of base64 on the signaling socket and gets the connection
    // closed. Decart's own pipeline flattens onto white and caps the longest
    // edge at 1024px; skipping that is what produced "WebSocket closed: 1000".
    const garment = await garmentReady;
    // Anywear sends an empty prompt: the garment image is the instruction.
    await realtime.setImage(garment, { prompt: '', enhance: false });

  } catch (error) {
    status(explain(error));
    await end(`Start failed: ${error.message}`, { silent: true });
  }
}

function explain(error) {
  const text = String(error?.message ?? error);
  if (/WebSocket closed/i.test(text)) {
    return `Decart closed the connection (${text}). Usually the garment image was too large or the token expired — retry.`;
  }
  if (error?.name === 'NotAllowedError') return 'Camera blocked. Allow camera for this site and try again.';
  if (error?.name === 'NotReadableError') return 'Camera is in use by another app.';
  if (error?.name === 'NotFoundError') return 'No camera found.';
  return String(error?.message ?? error);
}

/**
 * Seconds left, and nothing else. The session's cost is operator information:
 * a customer sees how long they have, never what it costs us.
 *
 * The count follows Decart's own generation clock. The local timer used to
 * start only after the garment upload finished; on a slow connection that was
 * seconds after Decart's clock had started, so Decart's cap cut the stream
 * while the countdown still showed time left — and it read as "connection
 * lost". Local ticks now only fill the gaps between Decart's.
 */
function startMeter() {
  if (timer) return;
  meter.hidden = false;
  let elapsed = decartSeconds;
  paintMeter(elapsed);
  timer = setInterval(() => {
    elapsed = Math.max(elapsed + 1, decartSeconds);
    paintMeter(elapsed);
    if (elapsed >= sessionSeconds) end(TIME_UP);
  }, 1000);
}

function paintMeter(elapsed) {
  const remaining = Math.max(0, sessionSeconds - elapsed);
  countdown.textContent = String(remaining);
  countdown.className = remaining <= 3 ? 'critical' : remaining <= 6 ? 'low' : '';
}

const TIME_UP = "Time's up — start another session to keep trying things on.";

/** Decart's end reasons, in words a shopper can act on. The raw reason goes to the log. */
function describeEnd(reason) {
  const text = String(reason ?? '');
  if (/credit|balance|quota|payment/i.test(text)) return 'Try-on is briefly unavailable. Please try again in a little while.';
  if (/moderat|policy|violation|nsfw|safety/i.test(text)) return 'This session was stopped by our content filter.';
  if (/duration|time|limit|max|expire/i.test(text)) return TIME_UP;
  return null;
}

/** Swaps the garment without reconnecting. Free, and needs no new session. */
async function swap(imageDataUrl) {
  if (!realtime) return;
  const garment = await prepareGarment(imageDataUrl);
  await realtime.setImage(garment, { prompt: '', enhance: false });
  toParent({ type: 'TRYON_STATUS', text: 'Garment swapped.' });
}

/** `note` is what the dashboard log records; `reason` is what the shopper reads. */
async function end(reason, { silent = false, note = reason } = {}) {
  // disconnect() emits connectionChange synchronously, which lands straight
  // back here. Without this guard the session is released twice and the
  // second release 404s against a session the backend already closed.
  if (ending) return;
  ending = true;
  stopping = true;

  clearInterval(timer);
  timer = null;
  meter.hidden = true;

  try {
    realtime?.disconnect();
  } catch {
    // Already gone.
  }
  realtime = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  output.srcObject = null;
  local.srcObject = null;

  if (sessionId) {
    const counted = decartSeconds ? ` (Decart counted ${decartSeconds}s)` : '';
    await send({ type: 'END_SESSION', sessionId, timeToFirstFrameMs: ttff, note: `${note}${counted}` });
    sessionId = null;
  }
  if (!silent) status(reason ?? 'Stopped.');
  toParent({ type: 'TRYON_ENDED', text: reason ?? 'Stopped.' });
  ending = false;
}

addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'TRYON_START') begin(data);
  if (data.type === 'TRYON_SWAP' && data.imageDataUrl) swap(data.imageDataUrl);
  if (data.type === 'TRYON_STOP') end(data.reason ?? 'Stopped.');
});

// A closed tab or navigation must still stop the meter.
addEventListener('pagehide', () => {
  if (sessionId) end('Widget closed.', { silent: true });
});

status('Ready.');
