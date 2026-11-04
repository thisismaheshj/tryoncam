/* tryoncam · motion and interaction
   GSAP + ScrollTrigger + SplitText. Shared by the landing page and the legal pages:
   every block checks its elements exist, so a page only pays for what it has. */
(function () {
  'use strict';

  /* ---------- config: the one place to change the install link ---------- */
  const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/aadnmnhilcphhjnchilngaeandeldngc';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- works without GSAP ---------- */
  $$('[data-install]').forEach((a) => { a.href = CHROME_STORE_URL; a.target = '_blank'; a.rel = 'noopener'; });
  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  const header = $('#header');
  const menuBtn = $('#menuBtn');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const open = header.classList.toggle('menu-open');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    $$('.mobile-nav a').forEach((a) => a.addEventListener('click', () => { header.classList.remove('menu-open'); menuBtn.setAttribute('aria-expanded', 'false'); }));
  }

  /* support address: set in the dashboard, so it can change without a redeploy.
     The address written into the page stays if the request fails. */
  const DEFAULT_SUPPORT = 'support@tryoncam.com';
  // The landing page's content.js has already asked for this; other pages ask here.
  (window.tryoncamSiteData || fetch('https://app.tryoncam.com/api/public/site', { credentials: 'omit', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status))))
    .then((answer) => {
      if (!answer) return;
      const { supportEmail, sessionSeconds } = answer;
      // The session length is set in the dashboard's run controls.
      if (Number.isInteger(sessionSeconds) && sessionSeconds > 0) {
        $$('[data-session-seconds]').forEach((el) => { el.textContent = String(sessionSeconds); });
      }
      if (!supportEmail || supportEmail === DEFAULT_SUPPORT || !/^[^\s@<>"]+@[^\s@<>"]+$/.test(supportEmail)) return;
      $$('a[href^="mailto:' + DEFAULT_SUPPORT + '"]').forEach((a) => {
        a.href = a.getAttribute('href').replace(DEFAULT_SUPPORT, supportEmail);
      });
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(DEFAULT_SUPPORT)) hits.push(walker.currentNode);
      hits.forEach((node) => { node.nodeValue = node.nodeValue.split(DEFAULT_SUPPORT).join(supportEmail); });
    })
    .catch(() => {});

  /* demo video: YouTube id wins, else a local mp4; the poster stays until one plays */
  const video = $('#video');
  const playBtn = $('#playBtn');
  if (video && playBtn) {
    let player = null; // the <video>, once made
    const label = playBtn.querySelector('small');
    const labelText = label ? label.textContent : '';
    playBtn.addEventListener('click', () => {
      // Second and later presses resume the clip already on the page.
      if (player) { player.play().catch(() => {}); return; }
      const yt = (video.dataset.youtube || '').trim();
      const mp4 = (video.dataset.mp4 || '').trim();
      if (yt) {
        const f = document.createElement('iframe');
        f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&rel=0&modestbranding=1`;
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        f.title = 'tryoncam demo';
        video.appendChild(f);
      } else if (mp4) {
        // No native controls: the frame stays clean. Clicking the picture
        // pauses; the play button comes back to resume, and to replay.
        const v = document.createElement('video');
        v.src = mp4; v.autoplay = true; v.playsInline = true; v.controls = false;
        v.addEventListener('play', () => { playBtn.hidden = true; });
        v.addEventListener('pause', () => {
          if (v.ended) return;
          if (label) label.textContent = 'Paused · click to resume';
          playBtn.hidden = false;
        });
        v.addEventListener('ended', () => {
          if (label) label.textContent = 'Watch again';
          playBtn.hidden = false;
        });
        v.addEventListener('click', () => (v.paused ? v.play().catch(() => {}) : v.pause()));
        v.addEventListener('error', () => {
          v.remove();
          player = null;
          playBtn.hidden = false;
          if (label) label.textContent = 'Video coming soon';
        });
        video.appendChild(v);
        player = v;
        if (label) label.textContent = labelText;
      } else return;
      playBtn.hidden = true;
    });
  }

  /* legal pages: highlight the section you are reading */
  const toc = $$('.legal__toc a');
  if (toc.length && 'IntersectionObserver' in window) {
    const byId = new Map(toc.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        toc.forEach((a) => a.classList.remove('on'));
        const a = byId.get(e.target.id); if (a) a.classList.add('on');
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    byId.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  }

  if (!window.gsap) { document.documentElement.classList.remove('js-motion'); return; }
  gsap.registerPlugin(ScrollTrigger, SplitText);
  ScrollTrigger.config({ ignoreMobileResize: true });

  /* ---------- header hides on the way down ---------- */
  ScrollTrigger.create({
    onUpdate(self) { header.classList.toggle('is-hidden', self.direction === 1 && self.scroll() > 160 && !header.classList.contains('menu-open')); }
  });

  /* ---------- sticky bar: after the hero, never over pricing, the final CTA or the footer ---------- */
  const sticky = $('#stickyCta');
  if (sticky) {
    const covers = ['#pricing', '#join', '.site-footer'].map((s) => $(s)).filter(Boolean);
    const update = () => {
      const past = window.scrollY > window.innerHeight * 0.9;
      const clash = covers.some((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight * 0.85 && r.bottom > 0; });
      const on = past && !clash;
      sticky.classList.toggle('is-on', on);
      sticky.setAttribute('aria-hidden', String(!on));
      sticky.querySelector('a').tabIndex = on ? 0 : -1;
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  /* ---------- the ring: layout, spin, drag, tilt, scroll velocity ---------- */
  const ring = $('#ring');
  let scrollOut = 0;
  const state = { angle: 0, velocity: reduced ? 0 : 0.1, base: reduced ? 0 : 0.1, tiltX: -8, tiltY: 0 };
  let slides = [];
  let layoutRing = () => {};
  if (ring) {
    const tilt = $('#ringTilt');
    const stage = $('.ring-stage');
    slides = $$('.slide', ring);
    layoutRing = () => {
      const w = slides[0].offsetWidth;
      const radius = Math.max(260, (w * 1.16 * slides.length) / (2 * Math.PI));
      slides.forEach((s, i) => { s.style.transform = `rotateY(${(360 / slides.length) * i}deg) translateZ(${radius}px)`; });
      ring.dataset.r = radius;
    };
    layoutRing();
    window.addEventListener('resize', layoutRing);

    let dragging = false, lastX = 0, dragV = 0;
    stage.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; dragV = 0; stage.classList.add('is-dragging'); stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => { if (dragging) { dragV = (e.clientX - lastX) * 0.25; state.angle += dragV; lastX = e.clientX; } });
    const endDrag = () => { if (!dragging) return; dragging = false; stage.classList.remove('is-dragging'); state.velocity = gsap.utils.clamp(-6, 6, dragV); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    if (fine && !reduced) {
      window.addEventListener('pointermove', (e) => {
        state.tiltY = (e.clientX / window.innerWidth - 0.5) * 10;
        state.tiltX = -8 + (e.clientY / window.innerHeight - 0.5) * -8;
      });
    }

    // only spend frames on the ring while the hero is on screen
    let heroOn = true;
    ScrollTrigger.create({ trigger: '.hero', start: 'top bottom', end: 'bottom top', onToggle: (self) => { heroOn = self.isActive; } });
    const dim = fine && !reduced;
    const bright = new Array(slides.length).fill(-1);
    gsap.ticker.add(() => {
      if (!heroOn) return;
      if (!dragging) { state.velocity += (state.base - state.velocity) * 0.04; state.angle += state.velocity; }
      const r = Number(ring.dataset.r);
      ring.style.transform = `translateZ(${-r}px) rotateY(${state.angle}deg)`;
      tilt.style.transform = `rotateX(${state.tiltX - scrollOut * 36}deg) rotateZ(${state.tiltY * 0.3}deg) scale(${1 - scrollOut * 0.25})`;
      if (!dim) return;
      const step = 360 / slides.length;
      slides.forEach((s, i) => {
        const a = ((state.angle + step * i) % 360 + 360) % 360;
        const v = Math.round((0.5 + 0.5 * (Math.cos(a * Math.PI / 180) * 0.5 + 0.5)) * 50) / 50;
        if (v === bright[i]) return;
        bright[i] = v; s.firstElementChild.style.filter = `brightness(${v})`;
      });
    });

    if (!reduced) {
      ScrollTrigger.create({
        onUpdate(self) { const v = self.getVelocity(); if (Math.abs(v) > 30) state.velocity = gsap.utils.clamp(-5, 5, state.velocity + v / 4000); }
      });
      ScrollTrigger.create({ trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true, onUpdate(self) { scrollOut = self.progress; } });
      gsap.to('.hero__copy', { yPercent: -16, opacity: 0.15, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    }
  }

  /* ---------- reduced motion: final states, no choreography ---------- */
  if (reduced) {
    $$('[data-reveal]').forEach((el) => { el.style.opacity = 1; el.style.transform = 'none'; });
    return;
  }

  /* ---------- magnetic buttons, tilt + spotlight tiles ---------- */
  if (fine) {
    $$('[data-magnet]').forEach((el) => {
      const xTo = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3' });
      const yTo = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3' });
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.25);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.3);
      });
      el.addEventListener('mouseleave', () => { xTo(0); yTo(0); });
    });
    $$('[data-tilt]').forEach((el) => {
      const rx = gsap.quickTo(el, 'rotateX', { duration: 0.5, ease: 'power3' });
      const ry = gsap.quickTo(el, 'rotateY', { duration: 0.5, ease: 'power3' });
      gsap.set(el, { transformPerspective: 900 });
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        el.style.setProperty('--mx', px * 100 + '%'); el.style.setProperty('--my', py * 100 + '%');
        rx((0.5 - py) * 6); ry((px - 0.5) * 6);
      });
      el.addEventListener('mouseleave', () => { rx(0); ry(0); });
    });
  }

  /* ---------- hero intro: letters flip up, cards fly in, ring spins down ---------- */
  function heroIntro() {
    const title = $('[data-hero-title]');
    if (!title) return;
    const split = SplitText.create(title, { type: 'words,chars', charsClass: 'char' });
    const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
    tl.from(split.chars, { yPercent: 120, rotateX: -80, opacity: 0, transformOrigin: '50% 100%', duration: 1.1, stagger: 0.018 }, 0.15)
      .from('[data-hero-fade]', { opacity: 0, y: 10, duration: 1, stagger: 0.08 }, 0.1)
      .from('.hero__lede, .hero__actions, .hero__note', { opacity: 0, y: 24, duration: 1, stagger: 0.08 }, 0.55)
      .from('.site-header__inner', { y: -40, opacity: 0, duration: 1 }, 0.2);
    if (slides.length) {
      // the inner card, so the outer one keeps its rotateY/translateZ place on the ring
      tl.from(slides.map((s) => s.firstElementChild), { opacity: 0, y: 160, rotateZ: () => gsap.utils.random(-25, 25), duration: 1.4, stagger: { each: 0.05, from: 'random' }, ease: 'expo.out' }, 0.3)
        .from(state, { velocity: 9, duration: 2.2, ease: 'power3.out' }, 0.3);
    }
  }

  /* ---------- statement: words light up as you read ---------- */
  function statement() {
    const el = $('#statement');
    if (!el) return;
    const split = SplitText.create(el, { type: 'words', wordsClass: 'word' });
    gsap.to(split.words, { color: 'var(--ink)', stagger: 0.1, ease: 'none', scrollTrigger: { trigger: el, start: 'top 80%', end: 'bottom 45%', scrub: true } });
  }

  /* ---------- masked line reveals and batch fades ---------- */
  function reveals() {
    $$('[data-split]').forEach((el) => {
      SplitText.create(el, {
        type: 'lines', mask: 'lines', linesClass: 'split-line', autoSplit: true,
        onSplit: (self) => gsap.from(self.lines, { yPercent: 115, duration: 1.1, stagger: 0.09, ease: 'power4.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true } })
      });
    });
    ScrollTrigger.batch('[data-reveal]', {
      start: 'top 92%', once: true,
      onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 1, stagger: 0.08, ease: 'power3.out' })
    });
  }

  /* ---------- demo video frame lifts and flattens as it arrives ---------- */
  function videoFrame() {
    const f = $('#videoFrame');
    if (!f) return;
    gsap.fromTo(f, { rotateX: 18, scale: 0.9, transformPerspective: 1600 }, { rotateX: 0, scale: 1, ease: 'none', scrollTrigger: { trigger: f, start: 'top 95%', end: 'top 35%', scrub: true } });
  }

  /* ---------- how it works: pinned, scrubbed through three states ---------- */
  function how() {
    const section = $('#how');
    if (!section) return;
    const steps = $$('.dstep', section);
    const panes = [$('#pane1'), $('#pane2'), $('#pane3')];
    const url = $('#appUrl');
    const cursor = $('#demoCursor');
    const swatches = $$('.swatch', section);
    const liveImg = $('#liveImg');
    const timerRing = $('#timerRing');
    const timerNum = $('#timerNum');
    const mobile = window.matchMedia('(max-width: 900px)').matches;

    gsap.set(steps.slice(1), { autoAlpha: 0, y: 30 });
    gsap.set(panes.slice(1), { autoAlpha: 0 });
    gsap.set('.widget', { xPercent: 110 });
    gsap.from('#app', { y: 80, rotateX: 12, transformPerspective: 1400, opacity: 0, duration: 1.2, ease: 'power3.out', scrollTrigger: { trigger: section, start: 'top 75%', once: true } });

    const setSwatch = (i) => {
      swatches.forEach((s, k) => {
        s.classList.toggle('on', k === i);
        s.querySelector('small').textContent = k === i ? 'Wearing now' : 'Tap to swap';
      });
      const src = swatches[i].dataset.src;
      if (liveImg.getAttribute('src') !== src) liveImg.setAttribute('src', src);
    };
    let lastSwatch = 0;
    const timer = { t: 15 };

    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    // 1 · cursor finds the pill and clicks it
    tl.fromTo(cursor, { left: '70%', top: '80%' }, { left: '18%', top: '12%', duration: 0.12, ease: 'power2.inOut' }, 0)
      .to(cursor, { scale: 0.75, duration: 0.015 }, 0.13)
      .to(cursor, { scale: 1, duration: 0.015 }, 0.145)
    // 2 · the trial room slides in and loads
      .to(steps[0], { autoAlpha: 0, y: -30, duration: 0.05, ease: 'power2.in' }, 0.17)
      .to(panes[0], { autoAlpha: 0, scale: 0.97, duration: 0.05 }, 0.17)
      .call(() => { url.textContent = 'store.com/products/heritage-shirt'; }, null, 0.18)
      .to(steps[1], { autoAlpha: 1, y: 0, duration: 0.07, ease: 'power2.out' }, 0.22)
      .to(panes[1], { autoAlpha: 1, duration: 0.04 }, 0.2)
      .to('.widget', { xPercent: 0, duration: 0.1, ease: 'power3.out' }, 0.22)
      .fromTo('#scan', { yPercent: -100 }, { yPercent: 330, duration: 0.2, ease: 'none' }, 0.3)
    // 3 · live, timer running, garments swapping
      .to(steps[1], { autoAlpha: 0, y: -30, duration: 0.05, ease: 'power2.in' }, 0.54)
      .to(panes[1], { autoAlpha: 0, scale: 0.97, duration: 0.05 }, 0.54)
      .to(steps[2], { autoAlpha: 1, y: 0, duration: 0.07, ease: 'power2.out' }, 0.59)
      .fromTo(panes[2], { autoAlpha: 0, scale: 1.03 }, { autoAlpha: 1, scale: 1, duration: 0.06 }, 0.57)
      .to(timer, { t: 4, duration: 0.4, onUpdate: () => {
        timerNum.textContent = Math.ceil(timer.t);
        timerRing.style.strokeDashoffset = String(119.4 * (1 - timer.t / 15));
      } }, 0.6);

    ScrollTrigger.create({
      trigger: section, start: 'top top', end: mobile ? '+=200%' : '+=280%',
      pin: true, scrub: 0.7, anticipatePin: 1, animation: tl, invalidateOnRefresh: true,
      snap: { snapTo: [0, 0.4, 0.82], duration: { min: 0.25, max: 0.7 }, delay: 0.15, ease: 'power2.inOut' },
      onUpdate: (self) => {
        const p = self.progress;
        gsap.set('#howBar', { scaleX: p });
        if (p < 0.18) url.textContent = 'store.com/collections/new-in';
        const s = p < 0.72 ? 0 : p < 0.86 ? 1 : 2;
        if (s !== lastSwatch) { lastSwatch = s; setSwatch(s); }
      }
    });
  }

  /* ---------- bento micro-demos ---------- */
  function bento() {
    if ($('.mini-cursor')) {
      gsap.to('.mini-cursor', { keyframes: [{ left: '58%', top: '28%', duration: 1.2 }, { scale: 0.8, duration: 0.12 }, { scale: 1, duration: 0.12 }, { left: '12%', top: '62%', duration: 1.3 }, { left: '30%', top: '50%', duration: 1 }], repeat: -1, ease: 'power2.inOut' });
    }
    const bars = $$('#speed i');
    if (bars.length) {
      gsap.set(bars, { height: (i) => 30 + ((i * 37) % 70) + '%', scaleY: 0 });
      gsap.to(bars, { scaleY: 1, stagger: 0.04, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: '#speed', start: 'top 90%', once: true } });
      gsap.to(bars, { scaleY: () => gsap.utils.random(0.4, 1), duration: 0.5, ease: 'sine.inOut', repeat: -1, yoyo: true, repeatRefresh: true, stagger: { each: 0.06, from: 'center' }, delay: 1.2 });
    }
    const fan = $$('.fan img');
    if (fan.length) {
      const mid = (fan.length - 1) / 2;
      gsap.to(fan, { rotate: (i) => (i - mid) * 12, y: (i) => Math.abs(i - mid) * 8, x: (i) => (i - mid) * 14, duration: 1, ease: 'elastic.out(1, 0.6)', stagger: 0.06, scrollTrigger: { trigger: '.fan', start: 'top 88%', once: true } });
    }
    if ($('.verdicts')) {
      gsap.from('.verdicts .verdict', { x: -30, opacity: 0, stagger: 0.12, duration: 0.7, ease: 'back.out(2)', scrollTrigger: { trigger: '.verdicts', start: 'top 88%', once: true } });
    }
    if ($('.privacy-list')) {
      gsap.from('.privacy-list div', { y: 16, opacity: 0, stagger: 0.1, duration: 0.7, ease: 'power3.out', scrollTrigger: { trigger: '.privacy-list', start: 'top 90%', once: true } });
    }
  }

  /* ---------- gallery: columns drift against each other, counters ---------- */
  function gallery() {
    const cols = $$('.gallery__col');
    if (!cols.length) return;
    const wide = window.matchMedia('(min-width: 861px)').matches;
    const travel = wide ? [70, -50, 110, -30] : [30, -20];
    cols.forEach((col, i) => {
      if (travel[i] === undefined) return;
      gsap.fromTo(col, { y: travel[i] }, { y: -travel[i], ease: 'none', scrollTrigger: { trigger: '#gallery', start: 'top bottom', end: 'bottom top', scrub: true } });
    });
    gsap.fromTo('.gallery__grid', { rotate: -3, scale: 1.08 }, { rotate: 0, scale: 1, ease: 'none', scrollTrigger: { trigger: '.gallery__grid', start: 'top bottom', end: 'center center', scrub: true } });
    $$('.stat [data-to]').forEach((el) => {
      const o = { v: 0 }; const to = Number(el.dataset.to);
      if (!to) return;
      gsap.to(o, { v: to, duration: 1.6, ease: 'power3.out', onUpdate: () => { el.textContent = Math.round(o.v); }, scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
    });
  }

  /* ---------- flow: horizontal scroll on wide screens ---------- */
  function flow() {
    const track = $('#flowTrack');
    if (!track) return;
    ScrollTrigger.matchMedia({
      '(min-width: 861px)': () => {
        const distance = () => Math.max(0, track.scrollWidth - window.innerWidth);
        const tween = gsap.to(track, { x: () => -distance(), ease: 'none' });
        ScrollTrigger.create({ trigger: '#flow', start: 'top top', end: () => '+=' + distance(), pin: true, scrub: 0.8, animation: tween, invalidateOnRefresh: true, anticipatePin: 1 });
        $$('.flow__card').forEach((card) => {
          gsap.from(card, { rotate: 4, y: 60, opacity: 0.3, ease: 'power2.out', scrollTrigger: { trigger: card, containerAnimation: tween, start: 'left 98%', end: 'left 60%', scrub: true } });
          gsap.from(card.querySelectorAll('.flow__art > *'), { scale: 0.5, opacity: 0, stagger: 0.08, ease: 'back.out(2)', scrollTrigger: { trigger: card, containerAnimation: tween, start: 'left 80%', end: 'left 45%', scrub: true } });
        });
      },
      '(max-width: 860px)': () => {
        $$('.flow__card').forEach((card) => gsap.from(card, { y: 50, opacity: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: card, start: 'top 90%', once: true } }));
      }
    });
  }

  /* ---------- pricing: prices count up, cards rise ---------- */
  function pricing() {
    $$('[data-price]').forEach((el) => {
      const to = Number(el.dataset.price);
      if (!to) return;
      const o = { v: 0 };
      gsap.to(o, { v: to, duration: 1.4, ease: 'power3.out', onUpdate: () => { el.textContent = '$' + o.v.toFixed(2); }, scrollTrigger: { trigger: '#plans', start: 'top 80%', once: true } });
    });
  }

  /* ---------- final CTA: panel opens up, ring of garments turns ---------- */
  /* ---------- roadmap: the line fills as you read down it, milestones pop in turn ---------- */
  function roadmap() {
    const track = $('.roadmap__track');
    if (!track) return;
    // Across on a wide screen, down the left edge on a phone (see .roadmap__line).
    const axis = window.matchMedia('(max-width: 760px)').matches ? 'scaleY' : 'scaleX';
    gsap.fromTo('#roadmapFill', { [axis]: 0 }, {
      [axis]: 1, ease: 'none',
      scrollTrigger: { trigger: track, start: 'top 75%', end: 'bottom 55%', scrub: true },
    });
    $$('.rcard__dot', track).forEach((dot) => {
      gsap.from(dot, { scale: 0, duration: 0.6, ease: 'back.out(3)', scrollTrigger: { trigger: dot, start: 'top 80%', once: true } });
    });
    $$('.rcard__ico', track).forEach((ico, i) => {
      gsap.from(ico, { rotate: i % 2 ? 14 : -14, scale: 0.6, duration: 0.9, ease: 'elastic.out(1, 0.55)', scrollTrigger: { trigger: ico, start: 'top 85%', once: true } });
    });
  }

  function closing() {
    const cards = $$('.join__ring i');
    if (!cards.length) return;
    cards.forEach((c, i) => gsap.set(c, { rotate: (360 / cards.length) * i }));
    gsap.to('.join__ring', { rotate: 360, duration: 50, repeat: -1, ease: 'none' });
    gsap.from('#joinPanel', { scale: 0.92, borderRadius: 90, duration: 1.2, ease: 'power3.out', scrollTrigger: { trigger: '#joinPanel', start: 'top 88%', once: true } });
  }

  /* ---------- ribbon marquee, faster (and reversible) with scroll ---------- */
  function ribbon() {
    if (!$('#ribbon')) return;
    const loop = gsap.to('#ribbon', { xPercent: -50, ease: 'none', duration: 30, repeat: -1 });
    if (!fine) return;
    ScrollTrigger.create({
      onUpdate(self) {
        const v = Math.min(Math.abs(self.getVelocity()) / 500, 6);
        gsap.to(loop, { timeScale: (self.direction === -1 ? -1 : 1) * (1 + v), duration: 0.25, overwrite: true, onComplete: () => gsap.to(loop, { timeScale: 1, duration: 1.4, ease: 'power2.out' }) });
      }
    });
  }

  /* ---------- footer word rises ---------- */
  function footer() {
    if (!$('.footer__word')) return;
    gsap.from('.footer__word', { yPercent: 40, opacity: 0, ease: 'none', scrollTrigger: { trigger: '.footer__word', start: 'top bottom', end: 'bottom bottom', scrub: true } });
  }

  /* ---------- legal pages: title in, sections fade ---------- */
  function legal() {
    if (!$('.legal')) return;
    gsap.from('.legal-hero > .wrap > *', { y: 30, opacity: 0, duration: 1, stagger: 0.08, ease: 'power3.out' });
    gsap.from('.prose', { y: 40, opacity: 0, duration: 1.1, ease: 'power3.out', delay: 0.2 });
  }

  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  // Headings are split into letters and lines, and sections pinned, from the
  // words on the page: so the dashboard's words (content.js) go in first.
  const ready = Promise.all([fonts, window.tryoncamContent || null]);
  ready.then(() => {
    layoutRing();
    heroIntro();
    statement();
    videoFrame();
    how();
    bento();
    gallery();
    flow();
    reveals();
    pricing();
    closing();
    roadmap();
    ribbon();
    footer();
    legal();
    requestAnimationFrame(() => ScrollTrigger.refresh());
  });
  window.addEventListener('load', () => ScrollTrigger.refresh());
})();
