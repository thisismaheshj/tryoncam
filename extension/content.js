/**
 * Content script: a Try On button on every garment, and the
 * in-page try-on iframe.
 *
 * The iframe carries allow="camera" and lives at the chrome-extension://
 * origin, which is what makes getUserMedia work without a detached window —
 * the approach Anywear ships (docs/ANYWEAR-ARCHITECTURE.md).
 */
(() => {
  const WIDGET_URL = chrome.runtime.getURL('widget.html');
  const LOGO_URL = chrome.runtime.getURL('icons/logo.svg');

  /**
   * Copy comes from the backend so it can be changed without shipping a new
   * build. The defaults below are what renders before the fetch lands, and
   * what renders if the backend is unreachable.
   */
  let COPY = {
    panelTitle: 'Welcome to the Trial Room',
    dropHeadline: 'Hover any product and click Try On',
    dropSubtext: 'The Try On button appears on product photos as you shop.',
    startingTitle: 'Starting your session',
    startingNote: 'Getting the garment ready…',
    signInTitle: 'Sign in to try things on',
    signInSubtext: 'New accounts get free try-ons to start.',
    pillLabel: 'Try On',
  };
  let TUTORIAL = { videoId: '', title: 'How the trial room works' };

  let panel = null;
  let iframe = null;
  let live = false;
  // Declared up here, not beside startDiscovery: the settings callback reads
  // it, and a `let` read before its line runs is the TDZ error that once
  // killed this whole script.
  let discoveryStarted = false;
  /** True while the dashboard has buttons switched off, or this site is on its blocked list. */
  let pillsPaused = false;
  /** The signed-in customer, with their balance, as last reported. */
  let account = { configured: false, requireCredits: true, user: null };

  // lastError must be read, or a missing reply is logged as an unchecked
  // error on chrome://extensions. A reload of the extension also orphans this
  // script: sendMessage then throws "context invalidated" synchronously.
  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          const failure = chrome.runtime.lastError;
          resolve(failure ? { ok: false, error: failure.message } : reply ?? { ok: false, error: 'No reply from the extension.' });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) });
      }
    });

  /**
   * Pull operator-editable copy and the tutorial video.
   *
   * Must run after `send` is defined — `const` is not hoisted, and calling it
   * earlier threw a ReferenceError that killed the whole content script
   * before it could register its message listener.
   */
  function loadSettings() {
    send({ type: 'SETTINGS' }).then((result) => {
      if (!result?.ok || !result.settings) return;
      COPY = { ...COPY, ...result.settings.texts };
      TUTORIAL = { ...TUTORIAL, ...result.settings.tutorial };
      // Which images get a pill is the operator's call; until now the
      // dashboard's choice never reached the page and the defaults always won.
      const discovery = result.settings.discovery ?? {};
      const modeChanged = TryOnDetect.setDiscoveryMode(discovery.mode);
      const categoriesChanged = TryOnDetect.setWearableCategories(discovery.wearableCategories);

      // Buttons can be switched off everywhere, or on particular sites, from the dashboard.
      const extension = result.settings.extension ?? {};
      const host = location.hostname.replace(/^www\./, '');
      const blocked = (extension.blockedSites ?? []).some((site) => host === site || host.endsWith(`.${site}`));
      const paused = extension.showPills === false || blocked;
      const pauseChanged = paused !== pillsPaused;
      pillsPaused = paused;

      for (const pill of pills.values()) {
        const label = pill.querySelector('.tryon-pill-label');
        if (!label || label.textContent === COPY.pillLabel) continue;
        label.textContent = COPY.pillLabel;
        fitSpark(pill); // a longer or shorter label changes the pill's shape
      }
      if ((modeChanged || categoriesChanged || pauseChanged) && discoveryStarted) rescanPills();
    });
  }
  loadSettings();

  // --- Try-On pills ---------------------------------------------------------

  /**
   * One pill per garment, present from page load.
   *
   * A single shared button that followed the cursor meant nothing was visible
   * until you happened to hover the right image. Pills are now injected for
   * every candidate as it appears, so the page shows what is tryable at a
   * glance — the mode Anywear ships as "always-show try-on buttons".
   *
   * Each pill is absolutely positioned inside the image's own container rather
   * than fixed to the viewport, so it scrolls with the image for free and no
   * scroll handler has to keep hundreds of them in sync.
   */
  /**
   * image → pill. A Map rather than a WeakMap because it has to be walked:
   * sites like Pinterest discard and rebuild image elements as you scroll, and
   * a pill whose image is gone must be found and removed. A WeakMap cannot be
   * iterated, so orphaned pills stayed frozen where their image had been.
   */
  const pills = new Map();

  /**
   * Where a pill lives: inside the product card, at the image's top-left.
   *
   * Inside the card it scrolls, slides and clips with the image — a carousel
   * that hides an image hides its pill, a hover zoom carries it along. A
   * page-level layer did none of that and read as pills floating over the page.
   *
   * The host is the nearest block-level ancestor that can position the pill.
   * One that is already positioned is used as it is, at any size. A static one
   * is made `position: relative` only when it wraps the image closely: doing
   * that to a page-level wrapper would re-anchor the shop's own absolutely
   * positioned content.
   */
  const relativized = new WeakSet();
  function hostFor(img) {
    const imgBox = img.getBoundingClientRect();
    let node = img.parentElement;
    for (let depth = 0; depth < 5 && node && node !== document.body && node !== document.documentElement; depth += 1) {
      const style = getComputedStyle(node);
      if (style.display !== 'inline' && style.display !== 'contents') {
        if (style.position !== 'static') return node;
        const box = node.getBoundingClientRect();
        if (box.width <= imgBox.width * 2.5 && box.height <= imgBox.height * 2.5) {
          node.style.position = 'relative';
          relativized.add(node);
          return node;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * The last resort, for an image with no usable ancestor within reach: a layer
   * of our own at the document origin. Better a pill that sits over the page
   * than no pill at all — which is what such images used to get.
   */
  let layer = null;
  function pillLayer() {
    if (layer?.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = '__tryon-pills';
    layer.setAttribute('data-tryon-ui', '');
    document.documentElement.appendChild(layer);
    return layer;
  }

  /** Top-left of the image, 8px in, measured against whatever holds the pill. */
  function placePill(pill, img) {
    pill.classList.remove('tryon-covered'); // measure at its real size; re-applied after
    const box = img.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    const host = pill.parentElement;
    if (!host || host === layer) {
      pill.style.top = `${Math.round(box.top + scrollY) + 8}px`;
      pill.style.left = `${Math.round(box.left + scrollX) + 8}px`;
      return;
    }
    // Absolute positions are measured from the host's padding box, so its
    // border and any scroll offset come out of the arithmetic.
    const hostBox = host.getBoundingClientRect();
    pill.style.top = `${Math.round(box.top - hostBox.top - host.clientTop + host.scrollTop) + 8}px`;
    pill.style.left = `${Math.round(box.left - hostBox.left - host.clientLeft + host.scrollLeft) + 8}px`;
  }

  /** Puts a pill in its image's card, or on the fallback layer when there is none. */
  function seat(pill, img) {
    (hostFor(img) ?? pillLayer()).appendChild(pill);
  }

  /**
   * Hides a fallback-layer pill whose spot is covered — by a sticky header, a
   * drawer, a modal. Pills inside a card need no such check: the shop's own
   * stacking puts its header above them, as it does the image.
   */
  function occluded(img, pill) {
    if (pill.parentElement !== layer) return false;
    const x = parseFloat(pill.style.left) - scrollX + pill.offsetWidth / 2;
    const y = parseFloat(pill.style.top) - scrollY + pill.offsetHeight / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; // off screen: nothing to hide
    // The first thing under the point that is not ours. (Hiding our layer
    // first does not work: the pill forces itself visible, so it would find
    // itself and hide every pill on the page.)
    const hit = document.elementsFromPoint(x, y).find((el) => !el.closest('[data-tryon-ui]'));
    if (!hit) return false;
    const card = img.closest('a, li, article, [class*="product" i], [class*="card" i]') ?? img.parentElement;
    return !(hit === img || img.contains(hit) || hit.contains(img) || card?.contains(hit));
  }

  function attachPill(img) {
    if (pillsPaused || pills.has(img)) return;
    if (!TryOnDetect.isWearable(TryOnDetect.frontOf(img)).ok) return;

    const pill = document.createElement('button');
    pill.className = 'tryon-pill';
    pill.type = 'button';
    pill.setAttribute('data-tryon-ui', '');
    // The spark is a stroked rect, not a moving element: a dash travels the
    // exact rounded-rect path, so it can never leave the border the way a
    // straight bar on an offset-path does at the caps. pathLength="100"
    // normalises the dash to percentages, so one rule fits every pill width.
    pill.innerHTML = `
      <svg class="tryon-spark" aria-hidden="true" preserveAspectRatio="none">
        <rect class="trail" pathLength="100" x="1" y="1"/>
        <rect class="head"  pathLength="100" x="1" y="1"/>
      </svg>
      <span class="tryon-pill-label"></span>`;
    pill.querySelector('.tryon-pill-label').textContent = COPY.pillLabel;

    seat(pill, img);
    placePill(pill, img);

    pill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = TryOnDetect.frontOf(img);
      if (live && iframe) swapLiveGarment(source);
      else startTryOn(TryOnDetect.imageUrl(source), source);
    });

    pills.set(img, pill);
    fitSpark(pill);
    scheduleReseat(); // settle duplicates and cover checks for the new pill
  }

  /**
   * Matches the spark's corner radius to the pill's own.
   *
   * It cannot be done in CSS: SVG clamps `rx` against width/2 and `ry` against
   * height/2 independently, so any large value yields an ellipse-cornered
   * rectangle rather than a pill. Both radii have to be half the rendered
   * height, which is only knowable once the pill is in the document.
   */
  function fitSpark(pill) {
    // Set synchronously. `offsetHeight` forces the layout we need anyway, and
    // deferring to requestAnimationFrame means nothing happens at all while
    // the tab is backgrounded — the pill would render with square corners
    // until the user returned to it.
    const height = pill.offsetHeight;
    const width = pill.offsetWidth;
    if (!height || !width) return;

    // Half the height, but never more than half the width — that is the
    // largest radius a pill can have, and it keeps a very short pill round
    // rather than lens-shaped.
    const radius = Math.max(Math.min((height - 2) / 2, (width - 2) / 2), 0);
    for (const rect of pill.querySelectorAll('.tryon-spark rect')) {
      // Presentation attributes, not element.style: `rx` is not a supported
      // CSSOM property, so assigning to style.rx silently does nothing.
      if (rect.getAttribute('rx') === String(radius)) continue;
      rect.setAttribute('rx', String(radius));
      rect.setAttribute('ry', String(radius));
    }
  }

  /**
   * Images move: lazy loading swaps in a taller asset, fonts settle, carousels
   * slide. Re-seat every pill rather than trusting the position from creation.
   */
  function reseatPills() {
    if (!pills.size) return;
    prunePills();
    const placed = [];
    for (const [img, pill] of pills) {
      // A site that re-renders its card can drop our pill while keeping the
      // image; put it back rather than lose it until the next page load.
      if (!pill.isConnected) seat(pill, img);
      placePill(pill, img);
      if (!pill.hidden) placed.push([img, pill]);
    }
    // One pill per spot. Feeds often stack two images in the same place (a
    // blurred placeholder under the real one, or the next rendition fading in),
    // and each would otherwise bring its own pill: "Try On Try On". Compared
    // in page coordinates, since pills in different cards measure from
    // different origins.
    const taken = [];
    for (const [img, pill] of placed) {
      const rect = pill.getBoundingClientRect();
      const top = rect.top + scrollY;
      const left = rect.left + scrollX;
      const duplicate = taken.some(([t, l]) => Math.abs(t - top) < 24 && Math.abs(l - left) < 60);
      pill.classList.toggle('tryon-covered', duplicate || occluded(img, pill));
      if (!duplicate) taken.push([top, left]);
    }
    // Re-fit as well: if a pill was first measured before the stylesheet
    // applied, its radius would otherwise stay wrong for the page's life.
    for (const [, pill] of placed) fitSpark(pill);
  }

  /**
   * Re-applies the category policy to every pill already on the page.
   *
   * Settings arrive after the first scan, so a stricter policy must remove
   * pills and a looser one must add the images it now admits.
   */
  function rescanPills() {
    prunePills();
    if (pillsPaused) {
      for (const pill of pills.values()) pill.remove();
      pills.clear();
      return;
    }
    for (const img of document.querySelectorAll('img, [style*="background-image"], [style*="background:"]')) {
      const pill = pills.get(img);
      const allowed = TryOnDetect.isCandidate(img) && TryOnDetect.isWearable(TryOnDetect.frontOf(img)).ok;
      if (pill && !allowed) {
        pill.remove();
        pills.delete(img);
      } else if (!pill && allowed) {
        attachPill(img);
      }
    }
  }

  /**
   * Removes pills whose image has left the page. Kept apart from reseating and
   * run directly, not on an animation frame: Chrome pauses animation frames in
   * background tabs, and one paused frame blocked every later cleanup — so a
   * feed that rebuilt its images out of sight collected pills in dead spots.
   */
  function prunePills() {
    for (const [img, pill] of pills) {
      if (img.isConnected) continue;
      pill.remove();
      pills.delete(img);
    }
  }

  // Reseat on the next frame when the tab is painting; a timer stands in when
  // it is not, so a paused frame can never leave the scheduler stuck.
  let reseatPending = false;
  function scheduleReseat() {
    if (reseatPending) return;
    reseatPending = true;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      reseatPending = false;
      reseatPills();
    };
    requestAnimationFrame(run);
    setTimeout(run, 200);
  }

  // --- Try-on panel -------------------------------------------------------

  function ensurePanel() {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.className = 'tryon-panel';
    panel.setAttribute('data-tryon-ui', '');
    panel.innerHTML = `
      <div class="tryon-head">
        <img class="tryon-logo" src="${LOGO_URL}" alt="" width="24" height="24">
        <span class="tryon-brand">tryoncam</span>
        <span class="tryon-live" title="tryoncam is live on this page" aria-label="Live"></span>
        <span class="tryon-credits" data-role="credits" hidden>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v6.4M10 6.2c0-.8-.9-1.3-2-1.3s-2 .5-2 1.3c0 1.9 4 1 4 2.9 0 .8-.9 1.4-2 1.4s-2-.6-2-1.4"/></svg>
          <b data-role="credits-count"></b>
        </span>
        <span class="tryon-status" data-role="status">Idle</span>
        <button class="tryon-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="tryon-body" data-role="body">
        <div class="tryon-drop" data-role="drop">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 15.5 4 12 5.5 8.5 4 4 6l1.5 4H8v9h8v-9h2.5L20 6Z"/>
          </svg>
          <strong>${COPY.dropHeadline}</strong>
          <span>${COPY.dropSubtext}</span>
        </div>
      </div>
      <div class="tryon-resize" data-role="resize" title="Drag to resize"></div>
    `;
    document.body.appendChild(panel);
    restoreLayout(panel);
    makeDraggable(panel, panel.querySelector('.tryon-head'));
    makeResizable(panel, panel.querySelector('[data-role="resize"]'));

    panel.querySelector('.tryon-close').addEventListener('click', closePanel);

    // Sign-in comes first when it is switched on: a customer who drops a
    // garment only to be asked to sign in has had their first click wasted.
    refreshAccount().then(() => {
      if (account.configured && !account.user && !live) showSignIn(() => resetToDrop());
      else if (!live) status(idleLabel());
    });

    return panel;
  }

  async function refreshAccount() {
    const state = await send({ type: 'AUTH_STATE' });
    if (state?.ok) account = { configured: state.configured, requireCredits: state.requireCredits, user: state.user };
    if (account.user) {
      const fresh = await send({ type: 'ACCOUNT' });
      if (fresh?.ok && fresh.user) {
        account.user = fresh.user;
        account.requireCredits = fresh.requireCredits;
      } else if (fresh?.reason === 'unauthenticated') {
        account.user = null; // the session expired; the worker has cleared it
      }
    }
    paintCredits();
    return account;
  }

  /** The balance lives in the header chip; the status line says what is happening. */
  function idleLabel() {
    paintCredits();
    return 'Ready';
  }

  /** "3 sessions" beside the name: one credit is one session, so say sessions. */
  function paintCredits() {
    const chip = panel?.querySelector('[data-role="credits"]');
    if (!chip) return;
    const user = account.user;
    const show = Boolean(user) && account.requireCredits && typeof user.credits === 'number';
    chip.hidden = !show;
    if (!show) return;
    const count = chip.querySelector('[data-role="credits-count"]');
    const text = `${user.credits} ${user.credits === 1 ? 'session' : 'sessions'}`;
    if (count.textContent !== text) {
      count.textContent = text;
      chip.classList.remove('tryon-credits-bump');
      void chip.offsetWidth; // restart the animation
      chip.classList.add('tryon-credits-bump');
    }
    chip.classList.toggle('tryon-credits-empty', user.credits === 0);
    chip.title = `${text} left — one session is one live try-on`;
  }

  /**
   * Drag by the header. Position is written as explicit left/top and kept in
   * chrome.storage so the panel stays where it was put, across pages and
   * sessions — it is a tool the user positions once, not a toast.
   */
  function makeDraggable(node, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.style.cursor = 'move';
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.tryon-close')) return;
      const box = node.getBoundingClientRect();
      // Switch from bottom/right anchoring to absolute placement on first drag.
      node.style.left = `${box.left}px`;
      node.style.top = `${box.top}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      originLeft = box.left;
      originTop = box.top;
      startX = event.clientX;
      startY = event.clientY;

      const move = (e) => {
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        // Keep at least a sliver on screen so it can never be lost.
        const left = Math.min(Math.max(originLeft + e.clientX - startX, 8 - width + 60), innerWidth - 60);
        const top = Math.min(Math.max(originTop + e.clientY - startY, 0), innerHeight - 40);
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        node.classList.remove('dragging');
        try {
          chrome.storage.local.set({ panelPos: { left: node.style.left, top: node.style.top } });
        } catch {
          // Storage is optional; the panel still works.
        }
      };
      node.classList.add('dragging');
      addEventListener('pointermove', move);
      addEventListener('pointerup', up, { once: true });
      event.preventDefault();
    });
  }

  /**
   * Drag the corner to resize in both directions.
   *
   * The video fills the box (object-fit: cover) rather than letterboxing, so
   * the frame is only as cropped as the shape the user chooses — making the
   * window taller is what recovers the head and hands.
   */
  function makeResizable(node, handle) {
    const body = node.querySelector('[data-role="body"]');
    handle.addEventListener('pointerdown', (event) => {
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = node.offsetWidth;
      const startHeight = body.offsetHeight;

      const move = (e) => {
        const width = Math.min(Math.max(startWidth + (e.clientX - startX), 280), innerWidth - 40);
        const height = Math.min(Math.max(startHeight + (e.clientY - startY), 220), innerHeight - 120);
        node.style.width = `${width}px`;
        body.style.height = `${height}px`;
      };
      const up = () => {
        removeEventListener('pointermove', move);
        node.classList.remove('resizing');
        try {
          chrome.storage.local.set({ panelWidth: node.style.width, panelHeight: body.style.height });
        } catch {
          // Optional.
        }
      };
      node.classList.add('resizing');
      addEventListener('pointermove', move);
      addEventListener('pointerup', up, { once: true });
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function restoreLayout(node) {
    try {
      chrome.storage.local.get(['panelPos', 'panelWidth', 'panelHeight'], ({ panelPos, panelWidth, panelHeight }) => {
        if (panelWidth) node.style.width = panelWidth;
        if (panelHeight) node.querySelector('[data-role="body"]').style.height = panelHeight;
        if (!panelPos?.left) return;
        // Ignore a stored position that is off-screen on this display.
        const left = parseFloat(panelPos.left);
        const top = parseFloat(panelPos.top);
        if (left > innerWidth - 60 || top > innerHeight - 40) return;
        node.style.left = panelPos.left;
        node.style.top = panelPos.top;
        node.style.right = 'auto';
        node.style.bottom = 'auto';
      });
    } catch {
      // Keep the default corner.
    }
  }

  /**
   * Fills the white card with a visible "starting" state.
   *
   * Previously a click only changed a small line of text in the header, so
   * from the user's side nothing appeared to happen for the second or two it
   * takes to fetch the garment and mint a session. The work is the same; the
   * difference is that they can see it.
   */
  function showStarting(message = COPY.startingTitle) {
    const body = panel.querySelector('[data-role="body"]');
    body.innerHTML = `
      <div class="tryon-starting">
        <div class="tryon-spinner" aria-hidden="true"></div>
        <strong data-role="starting-title">${message}</strong>
        <span data-role="starting-note">${COPY.startingNote}</span>
      </div>
    `;
  }

  function startingNote(text) {
    const note = panel?.querySelector('[data-role="starting-note"]');
    if (note) note.textContent = text;
  }

  /**
   * Clicking Try On while a session is live swaps the garment in place — free,
   * no reconnect, no second credit. This used to be reachable only by dragging
   * an image onto the panel; with drag and drop gone, the pill does it.
   */
  async function swapLiveGarment(sourceImg) {
    status('Swapping garment…');
    const candidates = TryOnDetect.isCandidate(sourceImg)
      ? TryOnDetect.sourceCandidates(sourceImg)
      : [TryOnDetect.imageUrl(sourceImg)];
    const image = await send({ type: 'FETCH_IMAGE', candidates, pageUrl: location.href });
    if (!image?.ok) {
      status(`Could not load that image — ${image?.error ?? 'unknown error'}`);
      return;
    }
    iframe.contentWindow.postMessage({ type: 'TRYON_SWAP', imageDataUrl: image.dataUrl }, '*');
    status(`Swapped · ${image.width}×${image.height}`);
  }

  function status(text) {
    panel?.querySelector('[data-role="status"]')?.replaceChildren(document.createTextNode(text));
  }

  /**
   * Sign-in prompt inside the card.
   *
   * chrome.identity opens Google's own window, so there is nothing to embed —
   * the button just asks the worker to run the flow, then resumes whatever the
   * user was trying to do.
   */
  function showSignIn(retry) {
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;
    body.innerHTML = `
      <div class="tryon-starting">
        <strong>${COPY.signInTitle}</strong>
        <span>${COPY.signInSubtext}</span>
        <button class="tryon-google" type="button" data-role="signin">
          <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true">
            <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6Z"/>
            <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2a5.4 5.4 0 0 1-8.1-2.8H1v2.3A9 9 0 0 0 9 18Z"/>
            <path fill="#FBBC05" d="M3.96 10.7a5.4 5.4 0 0 1 0-3.4V5H1a9 9 0 0 0 0 8l3-2.3Z"/>
            <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.3A9 9 0 0 0 1 5l3 2.3A5.4 5.4 0 0 1 9 3.6Z"/>
          </svg>
          Continue with Google
        </button>
        <p class="tryon-signin-error" data-role="signin-error" hidden></p>
      </div>
    `;
    body.querySelector('[data-role="signin"]')?.addEventListener('click', async () => {
      const error = body.querySelector('[data-role="signin-error"]');
      error.hidden = true;
      status('Signing in…');
      const result = await send({ type: 'SIGN_IN' });
      if (result?.ok) {
        account.user = result.user;
        retry?.();
        status(idleLabel());
      } else {
        error.hidden = false;
        error.textContent = result?.error ?? 'Sign-in failed.';
        status('Sign-in failed');
      }
    });
  }

  /**
   * Out of credits: one clear way forward. Upgrade opens the account page on
   * its Buy credits section, already signed in; coming back to this tab
   * re-checks the balance and resumes the garment the customer chose.
   */
  function showBuy(retry) {
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;
    status('Out of sessions');
    paintCredits();
    body.innerHTML = `
      <div class="tryon-starting">
        <strong>You're out of sessions</strong>
        <span>Every session is one live try-on, with as many garment swaps as you like.</span>
        <button class="tryon-upgrade" type="button" data-role="upgrade">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 9.6 6l4.9.2-3.8 3 1.3 4.7L8 11.2l-4 2.7 1.3-4.7-3.8-3L6.4 6z"/></svg>
          Buy more sessions
        </button>
        <p class="tryon-signin-error" data-role="buy-error" hidden></p>
      </div>`;
    body.querySelector('[data-role="upgrade"]').addEventListener('click', async () => {
      const opened = await send({ type: 'OPEN_ACCOUNT', section: 'buy' });
      if (opened?.ok) {
        awaitPayment(retry);
        return;
      }
      const error = body.querySelector('[data-role="buy-error"]');
      error.hidden = false;
      error.textContent = opened?.error ?? 'Could not open your account.';
    });
  }

  /** Shown while the customer pays in the Stripe tab. */
  function awaitPayment(retry) {
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;
    status('Waiting for payment');
    body.innerHTML = `
      <div class="tryon-starting">
        <strong>Finish your upgrade in the new tab</strong>
        <span>Your credits land here as soon as the payment goes through.</span>
        <button class="tryon-retry" type="button" data-role="paid">I've upgraded — try it on</button>
      </div>`;

    const resume = async () => {
      await refreshAccount();
      const credits = account.user?.credits ?? 0;
      if (credits > 0) {
        document.removeEventListener('visibilitychange', onVisible);
        retry?.();
      } else {
        status('Payment not received yet');
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') resume();
    };
    document.addEventListener('visibilitychange', onVisible);
    body.querySelector('[data-role="paid"]').addEventListener('click', resume);
  }

  /** Leaves the failure on screen in the card, rather than only in the header. */
  function startingFailed(detail) {
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;
    body.innerHTML = `
      <div class="tryon-starting tryon-failed">
        <strong>Could not start</strong>
        <span data-role="failed-detail"></span>
        <button class="tryon-retry" type="button" data-role="retry">Try again</button>
      </div>
    `;
    // Error text can carry what a remote server sent (a content type, a
    // status line); as markup it could inject into the shop's page.
    body.querySelector('[data-role="failed-detail"]').textContent = String(detail).slice(0, 180);
    body.querySelector('[data-role="retry"]')?.addEventListener('click', () => {
      body.innerHTML = '';
      resetToDrop();
    });
  }

  function resetToDrop() {
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;
    body.innerHTML = `
      <div class="tryon-drop" data-role="drop">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6 15.5 4 12 5.5 8.5 4 4 6l1.5 4H8v9h8v-9h2.5L20 6Z"/>
        </svg>
        <strong>${COPY.dropHeadline}</strong>
        <span>${COPY.dropSubtext}</span>
      </div>
    `;
    status(idleLabel());
  }

  function closePanel() {
    try {
      iframe?.contentWindow?.postMessage({ type: 'TRYON_STOP', reason: 'Panel closed.' }, '*');
    } catch {
      // Already gone.
    }
    panel?.remove();
    panel = null;
    iframe = null;
    live = false;
  }

  function mountIframe() {
    const body = panel.querySelector('[data-role="body"]');
    body.innerHTML = '';
    iframe = document.createElement('iframe');
    iframe.src = WIDGET_URL;
    // The grant that makes getUserMedia work inside the extension origin.
    iframe.allow = 'camera';
    iframe.setAttribute('data-tryon-ui', '');
    body.appendChild(iframe);
    return new Promise((resolve) => iframe.addEventListener('load', () => resolve(iframe), { once: true }));
  }

  // --- The flow -----------------------------------------------------------

  async function startTryOn(garmentUrl, sourceImg = null) {
    if (!garmentUrl) return;
    ensurePanel();
    // Announce immediately, before any await — the click must land visibly.
    showStarting();
    status('Starting…');

    // Fetch in the worker: no page CORS, no tainted canvas. Hand it every
    // candidate URL so it can pick the sharpest the CDN will serve, rather
    // than the thumbnail the page happened to display.
    // When we know which element it came from we can read its srcset and
    // zoom attributes; a bare URL only gets the parameter upgrade.
    const candidates =
      sourceImg && TryOnDetect.isCandidate(sourceImg)
        ? TryOnDetect.sourceCandidates(sourceImg)
        : [TryOnDetect.upgradeResolution(garmentUrl), garmentUrl];

    const image = await send({ type: 'FETCH_IMAGE', candidates, pageUrl: location.href });
    if (!image?.ok) {
      status('Could not load that image');
      startingFailed(image?.error ?? 'unknown error');
      return;
    }
    startingNote(`Garment ${image.width}×${image.height} · opening the room…`);
    status(`Garment ${image.width}×${image.height}`);

    const minted = await send({ type: 'CREATE_SESSION', garmentUrl });
    if (!minted?.ok) {
      status('Session refused');
      const again = () => startTryOn(garmentUrl, sourceImg);
      // A refusal a customer can fix is a button to offer, not an error to show.
      if (minted?.reason === 'unauthenticated') showSignIn(again);
      else if (minted?.reason === 'no_credits') showBuy(again);
      else startingFailed(minted?.error ?? 'The backend refused the session.');
      return;
    }
    if (account.user && typeof minted.creditsLeft === 'number') {
      account.user.credits = minted.creditsLeft;
      paintCredits();
    }

    startingNote('Starting your camera…');
    status('Session started');
    await mountIframe();
    iframe.contentWindow.postMessage(
      {
        type: 'TRYON_START',
        grant: minted.grant,
        sessionId: minted.sessionId,
        seconds: minted.seconds,
        imageDataUrl: image.dataUrl,
        pageUrl: location.href,
      },
      '*',
    );
  }

  // Messages back from the widget.
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'TRYON_STATUS') {
      status(data.text);
      if (/^Live/.test(String(data.text))) live = true;
    }
    if (data.type === 'TRYON_ENDED') {
      live = false;
      status(data.text ?? 'Session ended.');
    }
  });

  /**
   * Tutorial overlay: a large, closable window over the page.
   *
   * The YouTube player lives inside an extension-origin iframe rather than
   * being embedded directly, because a shop's own CSP frame-src would often
   * refuse youtube.com — while an extension page listed in
   * web_accessible_resources is allowed.
   */
  function openTutorial() {
    if (document.getElementById('__tryon-tutorial')) return;

    const overlay = document.createElement('div');
    overlay.id = '__tryon-tutorial';
    overlay.className = 'tryon-tutorial';
    overlay.setAttribute('data-tryon-ui', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'tryoncam tutorial');
    overlay.innerHTML = `
      <div class="tryon-tutorial-card">
        <div class="tryon-tutorial-head">
          <span>${TUTORIAL.title}</span>
          <button type="button" aria-label="Close tutorial">&times;</button>
        </div>
        <div class="tryon-tutorial-body">
          <iframe src="${chrome.runtime.getURL('tutorial.html')}#${encodeURIComponent(TUTORIAL.videoId)}"
                  allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    overlay.querySelector('button').addEventListener('click', close);
    // Click the backdrop, not the card.
    overlay.addEventListener('click', (event) => event.target === overlay && close());
    document.addEventListener('keydown', onKey, true);
  }

  /**
   * Discovery — the pills — runs only where there is something to
   * try on.
   *
   * The gate is deliberately here and not at the top of the file. An early
   * return above the message listener is what previously left the toolbar menu
   * reporting "not available on this page" everywhere: the script exited
   * before it could register, so the popup had nothing to talk to. The menu
   * works on every page; only the pills are conditional.
   */
  function startDiscovery() {
    discoveryStarted = true;
    TryOnDetect.observe((img) => {
      attachPill(img);
      return pills.has(img);
    });
    // Capture phase, so a carousel or other inner scroller moves pills too.
    addEventListener('scroll', scheduleReseat, { passive: true, capture: true });
    addEventListener('resize', scheduleReseat, { passive: true });
    // Lazy-loaded images resize as their real asset arrives.
    document.addEventListener('load', scheduleReseat, true);
    // Carousels auto-advance and layouts settle with no event at all.
    setInterval(() => {
      prunePills();
      if (document.visibilityState === 'visible') scheduleReseat();
    }, 1000);
    // Feeds replace images as they scroll: drop the departed ones' pills as
    // soon as the page changes, not a second later.
    let pruneQueued = false;
    new MutationObserver(() => {
      if (pruneQueued) return;
      pruneQueued = true;
      setTimeout(() => {
        pruneQueued = false;
        prunePills();
        scheduleReseat();
      }, 100);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Let the page be re-armed from the toolbar icon.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'OPEN_PANEL') {
      ensurePanel();
      respond({ ok: true });
    }
    if (message?.type === 'OPEN_TUTORIAL') {
      openTutorial();
      respond({ ok: true });
    }
    return false;
  });

  // Last, and only now: anything that could throw runs after the listener is
  // safely registered, so a failure here can never make the toolbar menu
  // report the page as unavailable.
  // No site-level gate any more. It ran once at page load, and a store that
  // builds its page afterwards (Myntra and most modern shops) failed it and
  // got nothing. Each image now answers for itself: it needs a product word
  // or commerce evidence — a product link or a price — to get a pill.
  try {
    startDiscovery();
  } catch (error) {
    console.warn('[try-on] discovery failed to start:', error);
  }
})();
