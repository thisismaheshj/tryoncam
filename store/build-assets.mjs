/**
 * Chrome Web Store listing images, rendered with headless Chrome.
 *
 *   node store/build-assets.mjs
 *
 * Every scene reuses the extension's own stylesheet and the landing page's
 * photos, so the listing shows the real interface. Prices on the pricing shot
 * come from the live backend at build time — re-run after any price change.
 *
 * Output (store/out/):
 *   icon-128.png                 store icon: 96px artwork, 16px transparent margin
 *   screenshot-1..5-*.png        1280x800, what the store shows in its carousel
 *   promo-small-440x280.png      small promotional tile
 *   promo-marquee-1400x560.png   marquee tile (used if Google features the listing)
 *
 * Screenshot 2 puts a studio photo where the live camera frame goes. Replace it
 * with a frame from a real session before submitting: store policy requires
 * screenshots to show what the extension actually produces.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(here, 'src');
const out = path.join(here, 'out');
mkdirSync(src, { recursive: true });
mkdirSync(out, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = (p) => `file://${path.join(root, p)}`;
const img = (name) => url(`site/assets/img/${name}`);
const LOGO = url('brand/camface/camface.svg');
const FONTS =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Geist:wght@400..700&display=swap">';

const pricing = await fetch('https://app.tryoncam.com/api/public/pricing')
  .then((r) => r.json())
  .catch(() => ({ plans: [], copy: {}, freeCredits: 3 }));

const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A pill exactly as the extension draws it. */
const PILL = `<button class="tryon-pill" data-tryon-ui style="top:10px;left:10px">
  <svg class="tryon-spark" aria-hidden="true" preserveAspectRatio="none">
    <rect class="trail" pathLength="100" x="1" y="1" rx="15" ry="15"/>
    <rect class="head" pathLength="100" x="1" y="1" rx="15" ry="15"/>
  </svg><span class="tryon-pill-label">Try On</span></button>`;

const COIN = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v6.4M10 6.2c0-.8-.9-1.3-2-1.3s-2 .5-2 1.3c0 1.9 4 1 4 2.9 0 .8-.9 1.4-2 1.4s-2-.6-2-1.4"/></svg>`;

const BASE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; font-family: Geist, ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(1200px 700px at 85% 10%, #e7ebff 0%, #f5f6fa 55%, #f5f6fa 100%); color: #0e0f12; }
  .frame { display: grid; grid-template-columns: 430px 1fr; height: 100%; padding: 64px 56px 64px 64px; gap: 40px; align-items: center; }
  .copy .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 19px; margin-bottom: 34px; }
  .copy .brand img { width: 34px; height: 34px; }
  .copy h1 { font-family: "Bricolage Grotesque", Geist, sans-serif; font-size: 50px; line-height: 1.04; letter-spacing: -.03em; margin: 0 0 20px; }
  .copy h1 em { font-style: normal; color: #3d5bf5; }
  .copy p { font-size: 19px; line-height: 1.5; color: #4a515c; margin: 0; max-width: 380px; }
  .window { position: relative; height: 640px; border-radius: 18px; background: #fff; overflow: hidden;
    box-shadow: 0 30px 70px -20px rgba(20, 24, 60, .35), 0 0 0 1px rgba(14, 15, 18, .06); }
  .bar { height: 40px; display: flex; align-items: center; gap: 7px; padding: 0 16px; background: #f1f2f5; border-bottom: 1px solid #e5e7eb; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #d7d9de; }
  .bar span { margin-left: 16px; flex: 1; height: 24px; border-radius: 8px; background: #fff; font-size: 12px; color: #6b7280; display: flex; align-items: center; padding: 0 12px; }
`;

function scene(title, body, extraCss = '', links = '') {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}
  <link rel="stylesheet" href="${url('extension/content.css')}">${links}
  <style>${BASE}${extraCss}</style><title>${title}</title></head><body>${body}</body></html>`;
}

const copy = (h1, p) => `<div class="copy"><div class="brand"><img src="${LOGO}" alt="">tryoncam</div><h1>${h1}</h1><p>${p}</p></div>`;

const STORE_CSS = `
  .shop { padding: 20px 26px; }
  .shop h2 { font: 700 13px Geist, sans-serif; letter-spacing: .14em; text-transform: uppercase; margin: 4px 0 16px; color: #111; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .card .ph { position: relative; aspect-ratio: 3 / 4; border-radius: 6px; overflow: hidden; background: #eee; }
  .card .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card p { margin: 10px 0 2px; font-size: 13.5px; color: #111; }
  .card b { font-size: 13.5px; }
  .tryon-spark rect { animation: none !important; }
  .tryon-spark .head { stroke-dashoffset: -30; }
`;

const shopGrid = (items) => `<div class="shop"><h2>New in</h2><div class="grid">${items
  .map(([file, name, price, pill = true]) => `<div class="card"><div class="ph"><img src="${img(file)}" alt="">${pill ? PILL : ''}</div><p>${name}</p><b>${price}</b></div>`)
  .join('')}</div></div>`;

const scenes = {};

// 1 — pills on a store
scenes['screenshot-1-try-on-any-store'] = scene(
  'Try on from any store',
  `<div class="frame">${copy('Try on clothes from <em>any store</em>', 'A Try On button appears on product photos as you shop. One click opens your trial room.')}
   <div class="window"><div class="bar"><i></i><i></i><i></i><span>yourfavouritestore.com/new-in</span></div>
   ${shopGrid([['f-heritage.jpg', 'Heritage Print Shirt', '$58'], ['f-coral.jpg', 'Coral Flame Sweater', '$74'], ['f-shorts.jpg', 'Washed Print Shorts', '$52'],
               ['f-pinstripe3.jpg', 'Pinstripe Wide Trousers', '$79'], ['f-love.jpg', 'True Love Shirt', '$54'], ['d-coral.jpg', 'Flame Knit Sweater', '$74']])}
   </div></div>`,
  STORE_CSS,
);

// 2 — the live trial room (studio photo stands in for a live frame: replace before submitting)
scenes['screenshot-2-live-trial-room-REPLACE-PHOTO'] = scene(
  'Live trial room',
  `<div class="frame">${copy('See it on you, <em>live</em>', 'Your camera and the garment meet in real time. Move, turn, swap to another product — no photos, no uploads.')}
   <div class="window"><div class="bar"><i></i><i></i><i></i><span>yourfavouritestore.com/new-in</span></div>
   <div style="opacity:.55">${shopGrid([['f-coral.jpg', 'Coral Flame Sweater', '$74'], ['f-heritage.jpg', 'Heritage Print Shirt', '$58', false], ['f-shorts.jpg', 'Washed Print Shorts', '$52', false]])}</div>
   <div class="tryon-panel" data-tryon-ui style="position:absolute;right:22px;left:auto;top:58px;bottom:auto;width:360px">
     <div class="tryon-head"><img class="tryon-logo" src="${url('extension/icons/logo.svg')}" alt="" width="24" height="24">
       <span class="tryon-brand">tryoncam</span><span class="tryon-live"></span>
       <span class="tryon-credits">${COIN}<b>9 sessions</b></span>
       <span class="tryon-status">Live</span><button class="tryon-close" type="button">&times;</button></div>
     <div class="tryon-body" style="height:500px"><img src="${img('m-coral.jpg')}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">
       <div style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,.62);color:#fff;padding:5px 12px;border-radius:999px;font:700 17px Geist,sans-serif">12</div></div>
   </div></div></div>`,
  STORE_CSS + `.tryon-live::after { animation: none !important; transform: scale(1.4); opacity: .5; }`,
);

// 3 — sign in, free sessions
scenes['screenshot-3-sign-in-free'] = scene(
  'Start free',
  `<div class="frame">${copy(`Start with <em>${pricing.freeCredits ?? 3} free</em> try-ons`, 'Sign in with Google from the toolbar. No password, no card — just try things on.')}
   <div class="window" style="background:linear-gradient(180deg,#fff,#f6f7fb)"><div class="bar"><i></i><i></i><i></i><span>yourfavouritestore.com</span></div>
     <div class="toolbar"><img src="${url('extension/icons/logo.svg')}" alt=""></div>
     <iframe class="popup" src="popup-mock.html"></iframe>
     <div style="position:absolute;left:0;right:0;top:40px;opacity:.35">${shopGrid([['f-heritage.jpg', 'Heritage Print Shirt', '$58'], ['f-coral.jpg', 'Coral Flame Sweater', '$74'], ['f-shorts.jpg', 'Washed Print Shorts', '$52']])}</div>
   </div></div>`,
  `.toolbar { position: absolute; z-index: 2; top: 48px; right: 22px; width: 34px; height: 34px; border-radius: 9px; background: #fff; box-shadow: 0 0 0 2px #3d5bf5; display: grid; place-items: center; }
   .toolbar img { width: 24px; height: 24px; }
   .popup { position: absolute; top: 92px; right: 18px; width: 316px; height: 196px; z-index: 2; border: 0; border-radius: 14px; box-shadow: 0 24px 50px -10px rgba(0,0,0,.45); }` + STORE_CSS,
);

// popup mock: the real popup stylesheet, signed out
writeFileSync(path.join(src, 'popup-mock.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${url('extension/popup.css')}"><style>.mark{background-image:url(${url('extension/icons/logo.svg')})}</style></head><body>
<header><span class="mark"></span><div><strong>tryoncam</strong><span class="sub">Ready</span></div></header>
<button class="item primary"><span class="ico"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 15.5 4 12 5.5 8.5 4 4 6l1.5 4H8v9h8v-9h2.5L20 6Z"/></svg></span>
<span class="txt"><b>Open the trial room</b><small>Hover any product and click Try On</small></span></button>
<div class="account"><button class="google-btn" type="button"><svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true">
<path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6Z"/>
<path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2a5.4 5.4 0 0 1-8.1-2.8H1v2.3A9 9 0 0 0 9 18Z"/>
<path fill="#FBBC05" d="M3.96 10.7a5.4 5.4 0 0 1 0-3.4V5H1a9 9 0 0 0 0 8l3-2.3Z"/>
<path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.3A9 9 0 0 0 1 5l3 2.3A5.4 5.4 0 0 1 9 3.6Z"/></svg>Sign in with Google</button></div>
</body></html>`);

// 4 — pricing, from the live plans
const plans = (pricing.plans ?? []).filter((p) => p.credits > 0);
const base = plans.length ? Math.max(...plans.map((p) => p.amountCents / p.credits)) : 0;
const hot = plans.findIndex((p) => p.badge);
const cards = plans
  .map((p, i) => {
    const recurring = p.mode === 'recurring';
    const per = p.amountCents / p.credits;
    const save = base ? Math.round((1 - per / base) * 100) : 0;
    return `<article class="pc ${i === hot ? 'hot' : ''}">${p.badge ? `<span class="tag">${esc(p.badge)}</span>` : ''}
      <h3>${esc(p.name)}</h3><div class="amt">${money(p.amountCents, p.currency)}<small>${recurring ? `/${esc(p.interval)}` : 'once'}</small></div>
      <div class="cr"><i>${p.credits}</i>${p.credits} credits${recurring ? ` every ${esc(p.interval)}` : ''}</div>
      <div class="per">${money(Math.round(per), p.currency)} per try-on${save >= 5 ? ` · save ${save}%` : ''}</div>
      <ul>${[p.description, ...(p.features ?? [])].filter(Boolean).slice(0, 3).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <span class="btn">${recurring ? 'Subscribe' : `Get ${p.credits} credits`}</span></article>`;
  })
  .join('');
scenes['screenshot-4-credits'] = scene(
  'Credits',
  `<div class="frame">${copy('Credits when you <em>need them</em>', 'One credit is one live session, with as many garment swaps as you like. Top up from your account any time.')}
   <div class="window" style="padding:40px 30px;background:#f6f7f9"><div class="cards">${cards || '<p>Credit packs</p>'}</div></div></div>`,
  `.cards { display: grid; grid-template-columns: repeat(${Math.max(plans.length, 1)}, 1fr); gap: 16px; margin-top: 60px; }
   .pc { position: relative; background: #fff; border: 1px solid #e4e7ec; border-radius: 20px; padding: 22px; display: flex; flex-direction: column; gap: 8px; }
   .pc.hot { background: #111827; color: #fff; border-color: #111827; box-shadow: 0 16px 36px rgba(61,91,245,.28); }
   .pc .tag { position: absolute; top: -11px; right: 16px; padding: 3px 10px; border-radius: 999px; background: #3d5bf5; color: #fff; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
   .pc h3 { margin: 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8a94a3; }
   .pc.hot h3 { color: #a5b4fc; }
   .amt { font: 800 38px "Bricolage Grotesque", sans-serif; letter-spacing: -.03em; }
   .amt small { font: 500 14px Geist, sans-serif; color: #8a94a3; margin-left: 4px; }
   .cr { display: flex; gap: 8px; align-items: center; font-weight: 600; font-size: 14px; }
   .cr i { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 6px; background: #eef1ff; color: #3d5bf5; }
   .pc.hot .cr i { background: rgba(165,180,252,.18); color: #c7d2fe; }
   .per { font: 12px ui-monospace, Menlo, monospace; color: #8a94a3; }
   .pc ul { margin: 8px 0 14px; padding-left: 18px; color: #475467; font-size: 13px; display: grid; gap: 6px; }
   .pc.hot ul { color: #d1d5db; }
   .btn { margin-top: auto; text-align: center; padding: 12px; border-radius: 12px; background: #111827; color: #fff; font-weight: 700; font-size: 14px; }
   .pc.hot .btn { background: #3d5bf5; }`,
);

// 5 — privacy
const tick = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
scenes['screenshot-5-private'] = scene(
  'Private by default',
  `<div class="frame">${copy('Private <em>by default</em>', 'Your camera turns on only when you start a try-on, and off when it ends.')}
   <div class="window" style="padding:56px 48px;display:grid;gap:16px;align-content:center;background:#fff">
     ${[
       ['Camera only during a session', 'It switches on when you press Try On and off the moment the session ends.'],
       ['No video saved', 'Frames are processed in real time and never recorded or stored by us.'],
       ['No microphone, ever', 'tryoncam never asks for or uses your microphone.'],
       ['Sign in with Google', 'No password to create. We keep your Google name, email and photo, your credits and purchases, and a record of each try-on. Never your video.'],
     ]
       .map(([t, d]) => `<div class="row"><span class="ok">${tick}</span><div><b>${t}</b><p>${d}</p></div></div>`)
       .join('')}
   </div></div>`,
  `.row { display: flex; gap: 16px; align-items: flex-start; padding: 18px 20px; border: 1px solid #e8eaef; border-radius: 16px; }
   .row .ok { width: 34px; height: 34px; border-radius: 10px; background: #ecfdf3; display: grid; place-items: center; flex: none; }
   .row .ok svg { width: 18px; height: 18px; fill: none; stroke: #067647; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
   .row b { font-size: 17px; } .row p { margin: 4px 0 0; color: #5b6472; font-size: 14.5px; line-height: 1.5; }`,
);

// promo tiles
scenes['promo-small-440x280'] = `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
  html,body{margin:0} body{width:440px;height:280px;overflow:hidden;font-family:Geist,sans-serif;color:#fff;
  background:radial-gradient(420px 260px at 90% 0%,#6d7dff 0%,#3d5bf5 45%,#1e2a8a 100%);display:grid;place-content:center;justify-items:center;gap:10px;text-align:center}
  img{width:74px;height:74px;filter:drop-shadow(0 10px 18px rgba(0,0,0,.25))}
  h1{margin:4px 0 0;font:800 36px "Bricolage Grotesque",sans-serif;letter-spacing:-.03em}
  p{margin:0;font-size:16px;color:#dfe4ff}</style></head><body>
  <img src="${LOGO}" alt=""><h1>tryoncam</h1><p>Try clothes on before you buy</p></body></html>`;

scenes['promo-marquee-1400x560'] = `<!doctype html><html><head><meta charset="utf-8">${FONTS}
  <link rel="stylesheet" href="${url('extension/content.css')}"><style>
  html,body{margin:0} body{width:1400px;height:560px;overflow:hidden;font-family:Geist,sans-serif;color:#fff;
  background:radial-gradient(900px 500px at 80% 0%,#6d7dff 0%,#3d5bf5 40%,#18206e 100%);display:grid;grid-template-columns:1fr 640px;align-items:center;padding:0 80px;box-sizing:border-box}
  .l .b{display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px;margin-bottom:26px} .l .b img{width:42px;height:42px}
  h1{margin:0 0 18px;font:800 64px/1.02 "Bricolage Grotesque",sans-serif;letter-spacing:-.035em} p{margin:0;font-size:21px;color:#dfe4ff;max-width:520px;line-height:1.45}
  .r{display:flex;gap:26px;align-items:center;justify-content:flex-end}
  .ph{position:relative;width:250px;height:340px;border-radius:18px;overflow:hidden;box-shadow:0 30px 60px -18px rgba(0,0,0,.55)}
  .ph img{width:100%;height:100%;object-fit:cover;display:block} .arrow{font-size:40px;color:#c7d2fe}
  .tryon-spark rect{animation:none!important}</style></head><body>
  <div class="l"><div class="b"><img src="${LOGO}" alt="">tryoncam</div><h1>See it on you<br>before you buy it</h1><p>Live virtual try-on on the clothing stores you already shop.</p></div>
  <div class="r"><div class="ph"><img src="${img('f-coral.jpg')}" alt="">${PILL}</div><span class="arrow">→</span><div class="ph"><img src="${img('m-coral.jpg')}" alt=""></div></div></body></html>`;

scenes['icon-128'] = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
  body{width:128px;height:128px;display:grid;place-items:center}img{width:96px;height:96px}</style></head>
  <body><img src="${LOGO}" alt=""></body></html>`;

const SIZES = {
  'promo-small-440x280': [440, 280],
  'promo-marquee-1400x560': [1400, 560],
  'icon-128': [128, 128],
};

for (const [name, html] of Object.entries(scenes)) {
  const file = path.join(src, `${name}.html`);
  writeFileSync(file, html);
  const [w, h] = SIZES[name] ?? [1280, 800];
  const target = path.join(out, `${name}.png`);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, '--virtual-time-budget=6000', '--force-device-scale-factor=1',
    ...(name === 'icon-128' ? ['--default-background-color=00000000'] : []),
    `--screenshot=${target}`, `file://${file}`,
  ], { stdio: 'ignore' });
  console.log('rendered', path.relative(root, target));
}
