# Architectural Decisions

Running log of architectural choices and why, per the project brief. Newest phase at the bottom.

---

## Phase 0 — Recon (2026-09-22)

### D1. Use `editing_type: "virtual_tryon"` on `POST /live/s_editing/realtime`

Virtual try-on is a **first-class mode** of S2-Editing, not something coaxed out of style transfer. One documented endpoint, one field.

*Alternative rejected:* `style_transfer` with a clothing reference — strictly worse, and unnecessary.

### D2. Pin `aliyun-rtc-sdk@7.1.9`, bundled from npm

MV3 forbids remote scripts, and the reference demo loads AliRTC from `g.alicdn.com` — unusable as-is. Static analysis of the npm tarball shows the package is pure JS: **no `.wasm` files, no `importScripts`, no `eval`**. It bundles cleanly.

**7.1.9, not 7.3.6 (latest).** 7.1.9 is the version the working demo and reference docs describe, including specifics like the absence of `setDefaultPublishLocalAudioStream`. The 7.3.x API is unverified against those notes. Do not float this dependency.

### D3. Publish **video only** — never request the microphone

The SDK's only two MV3 CSP hazards — a `new Function` call and a remote fetch of `@ali/aliyun-audio-3a` — sit **exclusively on the audio 3A path**, both inside `try/catch`. Virtual try-on has no use for audio.

Publishing video-only avoids both, so the extension needs **no** `wasm-unsafe-eval`, **no** `web_accessible_resources` for the SDK, and no remote code. It also drops the microphone permission from the manifest entirely — fewer permissions to justify in Phase 3.

### D4. The hard cap is **server-authoritative** — supersedes Constraint 5

The brief specifies a hard *client-side* cap. Research showed the server can do this strictly better:

- Billing starts at an instant **the backend observes**: `conn_init_ack.success = true` on the WebSocket it owns.
- Billing stops via WS `type: 5` hangup — and **there is no REST endpoint to end a session**, so only the WS holder can stop the meter.

Therefore: a server timer armed at `conn_init_ack` and firing hangup at the cap is the real guardrail. The client countdown stays, but as **UX, not enforcement**.

**Consequence:** if the extension window is closed, crashes, or loses focus mid-stream, the backend still holds the socket and still hangs up. The brief's "a leaked session bills until timeout" risk is **structurally eliminated** rather than mitigated.

### D5. The backend owns the upstream WebSocket; `client_secret` never leaves the server

Vidu offers a browser path (`client_secret` in the WS query string, because browsers cannot set WS headers). We do not use it.

Proxying the control channel server-side keeps both the API key **and** the session credential off the client, and is what makes D4 possible. This matches the reference proxy's design.

### D6. Build Phase 1 on the `node-quickstart` proxy rather than from scratch

`lideang821/vidu-s1-api` (MIT) ships a 369-line proxy that already implements session creation, the upstream WS lifecycle, bounded `conn_init` waiting, `switch_prompt` relay, and hangup-on-client-disconnect — all against the real API.

Phase 1 becomes *"add a budget ledger, a concurrency counter, and a cap timer to proven code."* Lower risk than a fresh build, and it keeps the brief's "boring, readable code" requirement.

### D7. Default `VIDU_HOST=api.vidu.com`

Region undecided at Phase 0 — no key yet. Defaulting to the global host matches the brief's $0.005/credit math. Keys are region-specific and a mismatch returns `401`, so this is config, never hardcoded.

### D8. Do not set `rtmp_urls`

Optional RTMP relay is irrelevant here, and **if the relay fails to start, the session ends immediately**. Pure downside risk. Leave unset.

### D9. Treat the "5 free concurrent" figure as unverified; enforce low and server-side

Neither the 5-session allowance nor the ~$2,080/month figure appears in any reachable doc. Only `429 = concurrency limit` is confirmed.

`MAX_CONCURRENT` stays configurable and low (1–2 for a single-user smoke test), enforced by a backend counter, never by trusting the client. The brief's instinct was right even though its numbers are unconfirmed.

### D10. Exploit free `switch_prompt` in the test plan

Garment swaps are mid-session, need no reconnect, and are **not billed separately**. One 15-second session can therefore evaluate several garments.

This reshapes Phase 5's quality matrix (solid tee / patterned dress / jacket / logo tee) from four sessions into potentially one, materially increasing data per dollar against the ~50-minute budget.

### Open — to settle before Phase 1

- **Auth header prefix.** Docs contradict each other (`Token vda_xxx` vs bare `vda_xxx`). Default to `Token`; settle via `docs/AUTH-PROBE.md` at $0.00.
- **Region, key, credits.** None obtained yet.

---

## Phase 1 — Provider abstraction, backend, admin panel (2026-09-22)

Scope change: the brief said not to add a second provider unless asked. You asked, because you hold ~1,000 Decart credits. Decart leads; Vidu stays behind the same interface.

### D11. Decart first, and it preserves the Vidu budget

Lucy VTON 3.5 realtime is $0.02/sec — 4× Vidu's $0.005/sec. 1,000 credits ≈ $10 ≈ **500 seconds ≈ 33 sessions at 15s**.

That is more than enough to answer the only two questions that matter (time-to-first-frame, garment fidelity), and running them on Decart leaves the **entire $15 Vidu budget intact**. If real-time try-on turns out to look bad, we learn that without spending Vidu money.

### D12. `constraints.realtime.maxSessionDuration` is the primary guardrail

Decart mints client tokens carrying a **provider-enforced** maximum session duration. A leaked token, a closed window, or a dead backend cannot produce a session longer than the cap.

This is stronger than D4's server-authoritative timer, which depends on our backend staying alive. Both are used: Decart enforces the ceiling, our timer drives the countdown UI and the ledger.

### D13. Tokens are minted narrow

Every token is scoped to one model (`allowedModels`), one origin (`allowedOrigins`, when the request carries one), one duration, and a 45-second connect window (`expiresIn`). A stolen token is worth almost nothing.

### D14. Reservation accounting, not just post-hoc totals

At mint time the session's **worst case** is held against the budget, and reconciled to the real figure on release. Without this, simultaneous requests each see an empty budget and all pass. Covered by a test that would fail under naive accounting.

### D15. An abandoned live session is charged the full grant

A swept lease that had gone live is billed its entire grant, flagged `estimated`. We cannot prove it stopped early, and a budget guard that guesses low is worse than none. A session that never connected is charged zero, because Decart bills only while streaming.

### D16. Vidu is implemented but gated off

`ViduProvider.createSession` is written against the Phase 0 shapes, but `status().implemented` is `false` and the server refuses to select it.

Vidu has **no REST endpoint to end a session** — hangup is WebSocket signal type 5, sent by whoever holds the socket. Until the backend owns that socket, creating a Vidu session means creating one we cannot stop. Session creation is free (billing starts at `conn_init_ack`), so gating costs nothing and prevents the exact runaway the guardrails exist to stop.

### D17. The Decart SDK is bundled with esbuild, not served from node_modules

The published dist is unbundled ESM with bare specifiers (`zod`, `mitt`, `p-retry`, `livekit-client`) that no browser resolves. `npm run build:sdk` bundles it to `public/admin/vendor/decart-sdk.js` and copies `frame-metadata-worker.js` beside it — the worker is loaded by relative URL, so esbuild does not emit it automatically.

This serves both mounts and pre-validates MV3, where remote scripts are forbidden.

**The bundle scans clean for MV3**: zero `eval`, zero `new Function`, zero `WebAssembly`, zero `.wasm`, zero remote script loading. Its one `new Worker` resolves relative to `import.meta.url`, and the SDK's own same-origin check passes non-http schemes, so `chrome-extension://` is fine. **This is a materially cleaner MV3 story than AliRTC**, which needs the audio path avoided to dodge its `new Function` and CDN fetch.

### D18. Shared UI, two mounts

`api.js`, `tryon.js` and `panel.js` carry no same-origin assumption. The localhost panel leaves the backend base empty; the extension sets `window.VTON_BACKEND` to an absolute URL. `tryon.js` returns a uniform handle so the UI never branches on provider.

### D19. Garment images are proxied through the backend

`GET /api/garment?url=` fetches server-side. Retailers routinely block cross-origin reads and hotlinking, so this is what will make "click Try On on any site" work in Phase 3. It also keeps the browser from making requests to arbitrary shop domains.

### Open

- **Decart credit→USD rate unconfirmed.** Public pricing quotes USD/sec directly. If 1 credit = $0.02 rather than $0.01, the balance is ~250s, not ~500s.
- **Concurrency limits on Decart realtime** are undocumented. `MAX_CONCURRENT=2` is ours, not theirs.
- **No real API call has been made yet.** Every figure here is from documentation and static analysis.

---

## Phase 2 — First run attempt (2026-09-22)

### D20. Two provider limits found for $0.00

Minting a client token is not billed (billing starts per streamed second), which made it free to discover both of these against the live API:

- **Decart rejects `maxSessionDuration` below 10 seconds** (`Too small: expected number to be >=10`). The requested duration is now raised to the provider's floor **before** the budget reservation, because reserving 5s for a session the provider will run for 10s under-accounts by half.
- The same probe confirmed the key and the `X-API-KEY` header, because a 400 validation error proves auth succeeded.

`TryOnProvider` gained `minSessionSeconds` so this is expressed per provider rather than special-cased.

### D21. Camera constraints are passed through, never re-wrapped

The first real run failed with no permission prompt and two black tiles.

Cause: a Decart model's `width`/`height`/`fps` are **already MediaTrackConstraints** — `fps` is `{ ideal: 30, max: 30 }`, not a number. Wrapping it again produced `{ ideal: { ideal: 30, max: 30 } }`, which Chrome rejects as a non-finite double, throwing a `TypeError` **before** it prompts. The symptom is indistinguishable from "the camera did nothing".

Constraint building now lives in `public/admin/camera.js`, free of SDK imports so it can be unit tested outside a browser, with regression tests asserting nothing is double-wrapped.

### D22. A failed start releases its reservation immediately

The mint succeeded, then the camera threw, and nothing told the backend. The lease and its reserved seconds sat held until the sweeper reclaimed them 75 seconds later — and two failed attempts would exhaust `MAX_CONCURRENT`.

`start()` now calls `/end` for any session it minted before failing. Verified: after a failed start, active leases return to 0 and the budget to 300s.

### D23. Input hygiene and a sample button

A URL copied out of chat commonly arrives wrapped in backticks or quotes, which failed validation silently-ish and produced the same "nothing happened" symptom. The field now strips that punctuation and shows what was accepted, errors name the actual problem, and a **Load sample garment** button removes the paste step entirely.

### D24. API request logging

There was no access log, so the first failure could not be diagnosed from the server side at all — I wrongly inferred from silence that no request had arrived. API routes now log method, path, status and duration.

### D25. Garments are specified by description, not by image — SUPERSEDED BY D27

The first successful run put the subject in a **black** t-shirt from a **white** tee reference.

Decart's own try-on reference app (`digital-mirror` in `DecartAI/tryon-examples`) sends **no image** — only `initialState.prompt.text` — and specifies garments through detailed descriptions ("navy blue hoodie with a white cross logo on the chest and a kangaroo pocket"). Its product images are storefront UI only.

Our prompt pointed at "the garment in the reference image", which the model cannot ground on, so it invented a generic top.

The panel now treats the **garment description** as the primary input, ships a matching description with the sample, and refuses to start on a description under 15 characters or one that merely points at "the reference image" — that refusal costs nothing, while a bad run costs $0.20+.

**Consequence for Phase 3:** the content script must extract product **text** (title, `og:title`, spec tables), not just an image URL. That is a real change to its scope, and cheap — the text is already on the page.

### D26. The garment proxy impersonates a browser

Pinterest illustrates two distinct failures: a pin **page** URL returns `text/html` (not an image at all), and its CDN `i.pinimg.com` returns **403** to server-side fetches.

The proxy now sends a full browser User-Agent, `Accept`, `Accept-Language` and a same-origin `Referer`, which is what most hotlink protection checks. Errors now name the actual problem — a 403 says the host blocks hotlinking, and an HTML response says to copy the image address instead of the page URL.

---

## Phase 2 — After studying `DecartAI/tryon-examples` (2026-09-22)

**D25 was drawn from one of seven examples and was wrong in an important way.** The repo has seven apps; `digital-mirror` is the in-store kiosk, which ships pre-written prompts and no image. The repo README is explicit: *"The ideal setup is a **clean garment image** paired with a **descriptive prompt**."* Corrections follow.

### D27. Use `setImage()`, after connect — not `initialState.image`

The documented reference-image entry point is a dedicated method, called once the session is connected:

```js
const rt = await client.realtime.connect(stream, { model, onRemoteStream });
const blob = await resizeImageBlob(await urlToImageBlob(product.image));
rt.setImage(blob, { prompt: product.prompt, enhance: false });
```

We were passing the garment through `initialState.image` at connect time. `setImage` exists in the installed SDK (0.2.1) and is what every example uses. Calling it again swaps the garment with no reconnect.

**This was the primary cause of the black t-shirt**, alongside D28 and the vague prompt.

### D28. The reference image must be the garment alone, on white

Decart's guidance, now followed:

- Clean garment images work best — **just the clothing item, no person wearing it**
- White or clean backgrounds; at least 512×512
- If the source shows a person wearing it, extract the garment first

The Unsplash sample used in run 1 was **a person wearing a white tee** — precisely the case their docs warn against. The panel now ships five of Decart's own reference garments (flat-lay, white, 1024px) with their verbatim prompts.

### D29. Garment images are flattened onto white before sending

Ported from their `lib/image-utils.ts`: draw onto a white canvas, export JPEG, cap the longest edge at 1024px.

The white fill is not cosmetic — product PNGs are routinely transparent, and transparency reaching the model reads as black. The canvas must also be untainted, which is a second reason every external garment goes through our same-origin proxy.

### D30. Prompt structure is specified, not folklore

Their stated pattern: **substitute** (replacing a garment) or **add** (something not worn), 20–30 words, naming colour, material, texture, pattern and fit, using generic references like "the current top".

`enhance: true` is the documented fallback that lets the model expand a short prompt. It is now a toggle, and ticking it relaxes our vague-prompt guard, since expansion is precisely its purpose.

### D31. Phase 3 needs a garment-description strategy — and their examples show three

Product pages almost always show a **model wearing** the garment, which is the weak case. Decart's examples solve it three ways:

1. **`standalone`** — a vision LLM generates the prompt from the garment image; optionally sent a camera frame of the person too, so it can say "substitute the grey sweater" instead of "the current top".
2. **`full-featured`** — an image-editing model strips person and background to leave a clean garment, run only when a person is detected in the upload.
3. **`enhance: true`** — free, no extra service, lowest quality ceiling.

Cheapest first cut for the extension: page text (`og:title`, product title) as the prompt, `enhance: true` as backstop, and reach for vision only if that proves insufficient. Worth testing before building any of it.

---

## Phase 2 — Anywear teardown (2026-09-22)

Decart's shipped extension (**Anywear v2.7**) was downloaded from the Chrome Web Store CDN and unpacked, read only. It ships unminified internal engineering docs. Full teardown in `docs/ANYWEAR-ARCHITECTURE.md`.

### D32. No prompt. The image is the instruction. — supersedes D25 and D30

Anywear calls `setImage(image, { prompt: "" })`. The prompt variable is null unless a **server-delivered session config** sets it, which is a remote tuning knob, not a per-garment description.

D25 and D30 were both wrong, in opposite directions: first that images are unused, then that a 20–30 word description is required. Neither is true of the actual product. The demo catalogues in `tryon-examples` have prompts because they *have* a catalogue; a general-purpose extension has none.

The panel now treats the description field as an optional override and ships an empty prompt by default.

### D33. Pin `lucy-vton-3.5`

Anywear pins the canonical version, not the `lucy-vton-latest` alias, and allows a server override. Changed to match.

### D34. In-page iframe, not a detached window — supersedes the Phase 0 reading of Constraint 4

`widget.html` is a `web_accessible_resource` injected as an iframe carrying `allow="camera; microphone"`.

This solves both problems the brief raised at once: it is not a browser-action popup so focus loss cannot kill it, and at `chrome-extension://` origin it holds its own camera grant, delegated by the `allow` attribute. A detached-window path survives as a fallback for pages whose permissions policy forbids camera in iframes (`blocked-by-embedder`).

### D35. The extension needs no backend for garment images

`DECART_FETCH_IMAGE` in the background service worker uses `<all_urls>` host permissions to bypass page CORS and return a non-tainting `data:` URL. Our `/api/garment` proxy stays for the localhost harness, but Phase 3 should use the worker — fewer moving parts and no server round trip.

### D36. Garment selection, as shipped

- `querySelectorAll("img")` + `MutationObserver` on `document.body` for lazy/SPA content
- Floor of **120×120** rendered size; URL from `currentSrc || src`
- Hover button at the image's top-left **+8px** — matching the brief's UX target
- Front/back **composite** when confidently paired: exactly two images ≥80px in a listing card, or a same-rendered-size (±2px) sibling on a product page; stitched front-left/back-right at ≤1024px height
- Every failure degrades to the front image alone

---

## Phase 3 — The extension (2026-09-22)

Built after the Anywear teardown, following its architecture rather than inventing one.

### D37. The extension needs no URL pasting, which removes the Pinterest problem

The content script reads the `<img>` the browser has **already loaded and decoded** on the page in front of the user. There is no "fetch this URL from outside" step, so hotlink protection, login walls and JS-only pages stop mattering for discovery.

The garment bytes are then fetched by the **service worker** (`FETCH_IMAGE`), where `host_permissions: <all_urls>` bypasses page CORS and the resulting `data:` URL does not taint a canvas.

The localhost harness keeps `/api/garment`, now with two fixes worth keeping:
- **Referer is the page, not the image host.** Hotlink checks compare against the embedding page; sending the image's own origin is exactly the request they reject.
- **A page URL is followed to its `og:image`.** Pasting a product page now works (verified on Uniqlo). Pinterest still refuses server-side — it serves a JS shell with no metadata to non-browser clients.

### D38. Detector heuristics, verified on live sites

Ported from Anywear: `querySelectorAll("img")` + `MutationObserver`, floor of 120×120 rendered, aspect ratio between 0.25 and 3, URL from `currentSrc || src`.

| Site | Images | Candidates | Note |
|---|---|---|---|
| Uniqlo (PDP) | 580 | 67 | all correct product shots at 355×473 |
| H&M (PLP) | 36 | 30 | 6 lazy placeholders rejected |
| Gymshark | — | — | bot-blocked in this browser; untested |

### D39. Rendered size is not enough — intrinsic size catches lazy placeholders

H&M leaves a **1×1 transparent GIF** in `currentSrc` while the element is already laid out at 337×505. Every layout-based check passes it, and the model would have received a blank pixel.

The detector now treats a `data:` URL under 512 bytes as a placeholder and falls through to `data-src` / `data-original` / `data-lazy-src` / `data-srcset`, and rejects an image whose intrinsic width is below the floor when no better URL exists. Verified: zero placeholders survive on H&M.

### D40. Budget guardrails stay, even though Anywear has no equivalent

Anywear mints tokens from Decart's own backend. Ours does the same through `localhost:8787`, so the API key, the ledger, the concurrency counter and the kill switch all still apply. The extension gains the Anywear UX without giving up the cost controls the brief made a hard requirement.

### D41. The extension must preprocess garments too — it is not optional

First real extension run: Pinterest worked, **H&M failed with `WebSocket closed: 1000`** (a *normal* close — Decart hanging up, not erroring).

Cause: the widget passed the service worker's raw `data:` URL straight to `setImage`. H&M serves **2333×3500 at ~1MB**, which is **~384KB of base64** on the signaling socket. Pinterest's thumbnails are small enough to slip through, which is why it looked like a site-specific bug rather than a payload one.

The harness already ran Decart's `urlToImageBlob` + `resizeImageBlob(1024)`; the extension did not. Now it does — measured on that exact H&M image: **384KB → 63KB, 6.1× smaller, 683×1024**.

The same change fixed a second latent bug: the raw fetch was returning **AVIF**, whose support in the model is unverified. Re-encoding to JPEG removes the question, and the worker no longer requests AVIF.

**Rule:** every garment is flattened onto white, capped at 1024px and re-encoded as JPEG before it reaches `setImage` — on every entry point, in both mounts. Retailer originals are print-resolution and must never go on the wire untouched.

---

## Phase 4 — Feedback from the first working extension runs (2026-09-22)

### D42. Mirror in CSS, never in the SDK

A webcam feed shown unflipped reads as wrong: raise your right hand and the figure raises its left.

`mirror: 'auto'` in `realtime.connect` makes the SDK flip **every inbound frame through a canvas before publishing** — a per-frame cost sitting directly on the latency path. Decart's own e-commerce example instead renders the output with `transform: scaleX(-1)`, and `scaleX(-1)` appears seven times in Anywear's `widget.html`.

Now `mirror: false` plus a CSS transform on both videos. This fixes the mirroring complaint and removes a per-frame cost at the same time.

### D43. Camera at 1088×624, no frameRate constraint

Anywear monkey-patches `navigator.mediaDevices.getUserMedia` to force `{width:{ideal:1088}, height:{ideal:624}, facingMode:'user'}, audio:false` — landscape, and **no frameRate clamp at all**.

We were requesting the model's 1280×720, which is ~35% more pixels to encode and ship every frame for no visible benefit at panel size. Matched to Anywear's numbers.

Together with D42 these are the two latency levers available client-side. The remainder is model inference and network, which we do not control.

### D44. Hover detection by hit-testing, not per-image listeners

Reported failure: on a product page with **stacked images**, our button would not attach, while Anywear's did.

Cause: per-image `mouseenter` listeners. Product pages commonly stack two `<img>` elements and cross-fade on hover, so the lower one never receives an event; any transparent overlay (quick-view target, link wrapper, swatch strip) swallows it outright. Anywear's own docs devote a whole section to this layout (Pattern A — CSS two-img stack).

Replaced with a throttled document-level `pointermove` that calls `document.elementsFromPoint()` and takes the first candidate in the returned stack — which is by definition the image the user can actually see. One hit test per animation frame.

### D45. The panel floats and remembers where it was put

It was pinned to the bottom-right. It is a tool the user positions once, not a toast, so it now drags by its header, clamps so a sliver always stays on screen, and persists its position in `chrome.storage`.

### D46. Session length is a runtime control, not an env edit

`runtime.sessionSeconds` is the live default for new sessions and is adjustable from the admin panel; the extension sends no duration, so it simply inherits it.

`MAX_SESSION_SECONDS` (now 60) remains the hard ceiling the control cannot be talked above, and the provider's own floor is the lower bound — the endpoint clamps both ends rather than trusting the client. The slider shows cost per run and how many runs remain in budget at that length.

### D47. `currentSrc` is the display thumbnail, not the product image

Reported: the garment came out blurry and inaccurate. The cause was upstream of everything else.

On an H&M listing page the `<img>` we were reading resolved to `...jpg?imwidth=264` — a **264×396** file, browser-upscaled to fill a 337×505 box. We sent that to the model, and `prepareGarment` then "resized" it to 1024, inventing pixels. The model reproduces what it is given, so it was reproducing a smudge.

`currentSrc` is whatever the browser picked for *display*, which on a listing grid is deliberately small.

The fix has three parts:

1. **`upgradeResolution()`** rewrites CDN resize parameters to ask for the full render — `imwidth`/`width`/`w`/`sw`/`wid` query params, Cloudinary-style `/w_600/` path segments, Shopify `_600x.jpg` suffixes. Measured on H&M: `imwidth=264` → `imwidth=2160`, decoded **264×396 → 2160×3238**. That beat even the widest `srcset` descriptor, which was only 1536.
2. **`sourceCandidates()`** returns every URL worth trying, best first: explicit zoom attributes (`data-zoom-image`, `data-large_image`, `data-old-hires`), the widest `srcset` entry, then the displayed source — each in upgraded and raw form.
3. **The worker measures rather than trusts.** A CDN may ignore an upgraded parameter and return the original, so each candidate is decoded with `createImageBitmap` and the widest wins, stopping early once one clears 1200px. Guessing is not enough.

Preprocessing also raised: cap 1024 → **1280**, JPEG quality 0.8 → **0.92**, with `imageSmoothingQuality: 'high'`, and it still never upscales.

End to end on that H&M garment: **264×396 → 854×1280**, 84KB on the wire — comfortably under the ~384KB that closed the socket in D41.

**Rule:** never send the browser's display source. Resolve the largest the CDN will serve, verify it by decoding, and downscale to the cap — never up.

### D48. Prefer the master image, not the biggest request

Nykaa exposed a flaw in D47's "widest wins" rule. Their ImageKit CDN **upscales on demand**: `?tr=w-3000` returns 3000×4000 from a 1500×2000 master. Widest-wins would have picked invented pixels over the real thing.

`stripResizeParams()` now removes the resize instruction entirely — query keys (`tr`, `imwidth`, `width`, `w`, `sw`, `wid`, `dpr`, …) and path-segment forms — and that master-URL candidate is tried **first**. The upgraded-parameter variants remain as fallbacks for CDNs that require an explicit size.

Also added: **ImageKit syntax** (`?tr=w-720`, `,h-960`), which D47 did not cover, and **density `srcset` descriptors** (`2x`), which the width-only parser scored as zero and therefore ignored — exactly Nykaa's markup.

Measured on Nykaa: **720×960 → 1500×2000**.

### D49. Resolve hover-swap cards to the front view

Reported: a collarless kurta came back with a collar.

Listing cards cross-fade to the **back view on hover** — which is exactly when the user reaches for the Try-On button, so the image under the cursor is the wrong one. A back view can differ enough to change what the model produces.

`frontOf()` walks up to the card container and, **only when it holds exactly two candidates**, takes the first in document order. Three or more is a colourway strip or angle carousel where siblings may be a different garment, so it is left alone — Anywear's own rule, and for the same reason.

Verified on Nykaa: the card is detected as a two-image pair and resolves to `_1.jpg`.

### D50. The panel matched the wrong aspect ratio

Reported: video looks zoomed in, hands and midriff cropped.

The stream is **1088×624 landscape** (D43), but the panel body was `aspect-ratio: 3/4` **portrait** with `object-fit: cover` — which discards whatever does not fit. A landscape frame in a portrait box loses most of its width, which is precisely where hands are.

Now: body at `aspect-ratio: 1088/624`, default width 340 → **480px**, `object-fit: contain` so a mismatched device letterboxes instead of silently cropping, and a corner resize handle whose width persists alongside the drag position.

---

## Phase 4 — Second round of extension feedback (2026-09-22)

### D51. Don't offer Try-On on what a torso model cannot render

Reported: a bracelet on Amazon was rendered **as sunglasses across the eyes** when no hand was in frame.

The model does not decline an impossible request. Handed a bracelet it finds the nearest thing it can dress and puts the object there.

Anywear's answer is not to prompt the object into place — it is to withhold the button. Their own docs:

> *"revolve.js asks the shopper's question: can this garment be tried on? Dresses and tops yes; jeans, shoes, bags no."*
> *"UGG is a shoe company and the torso try-on cannot render a boot, so the entire core catalogue is blocked."*

`categoryOf()` classifies an image from nearest-first signals — its own `alt`/`title`, its card's link and text, then the page's `h1`, `og:title`, title and URL path. `isWearable()` allows `top`, `dress`, `outerwear`, `activewear`, `swimwear`, `lingerie` and hides the button for `jewelry`, `shoes`, `bag`, `eyewear`, `accessory`, `bottom`.

**Unknown means allowed.** Anywear fails *closed* only inside a per-retailer filter where the catalogue is known; globally they show the button on any product image. Refusing everything unclassifiable would make the extension silently dead across most of the web.

Verified on one site, both directions: Amazon bracelets **0/8** buttons, Amazon hoodies **8/8**.

### D52. Fill the window and let the user size it — D50 overcorrected

D50 locked the panel to the stream's 1088×624 and switched to `object-fit: contain`. Reported back as looking worse: letterboxing wastes the window, and the fix wanted was a bigger window, not a differently-shaped one.

Reverted to `cover`, with the body given an explicit height (default 460px) and the corner handle now resizing **both** axes, persisting width and height. The crop is whatever shape the user chooses, and making the window taller is what brings head and hands back into frame.

### D53. White, not black, and a room worth walking into

The idle iframe rendered as a black rectangle, which reads as broken rather than ready. The widget is now white throughout — body, overlay and output backdrop — and the panel chrome is a light theme to match.

Titled **"Welcome to the Trial Room"**, with the empty state carrying a hanger glyph and the two ways in: drag and drop anything you'd like to try, or hover any product image and click Try On.

### D54. Teardown was re-entrant, and the SDK's normal exit looks like an error

Reported from `chrome://extensions` on a Shopify store: `[DecartSDK] livekit: room disconnected` and `[DecartSDK] signaling: websocket closed`.

**Two separate things, one benign and one not.**

*Benign:* both lines come from the SDK's own `createConsoleLogger`, whose default `minLevel` is `"warn"`. They are what a clean shutdown logs. Chrome's extension Errors page lists warnings alongside errors, so an ordinary session end reads as a fault. The client is now constructed with `logger: createConsoleLogger('error')` — real errors still surface, expected end-of-session chatter does not.

*A real bug:* `end()` called `realtime.disconnect()`, which emits `connectionChange('disconnected')` **synchronously**, landing straight back in the `connectionChange` handler, which called `end()` again. The second pass released a session the backend had already closed (a 404 it ignored) and overwrote the real reason with "Provider disconnected."

Guarded with an `ending` flag, plus a `stopping` flag so a disconnect we asked for is not reported as a fault — only an unexpected one now says "Connection lost."

Both flags reset in `begin()`, so a new session starts clean.

### D55. The bundle entry must export everything the widget imports

`scripts/sdk-entry.js` re-exported only `createDecartClient` and `models`. Importing `createConsoleLogger` from it would have thrown at module load and taken the entire widget down — a worse failure than the warnings being fixed. The entry now also exports `createConsoleLogger` and `noopLogger`, verified against the built bundle's export list.

---

## Phase 5 — Trial-room polish (2026-09-22)

### D56. A click must land visibly before any await

Reported: clicking Try-On appeared to do nothing for a second or two — the session was starting, but only a small line of header text changed.

`showStarting()` now fills the white card with a spinner and "Starting your session" **synchronously on click, before the first await**, then narrates: garment resolved (with its resolution), room opening, camera starting. Failures replace it with a readable message and a Try again button rather than leaving a blank card.

### D57. Dark shell, white card

Fully white read as flat. The panel is now a near-black rounded shell with 10px of padding, holding a white card at a 13px radius — the frame reads as the room, the white panel as what you are looking at inside it.

### D58. The Try-On button earns attention

Larger (9×17 padding, 13.5px), with a pop-in on appear and a white spark travelling its rim: a conic gradient on a pseudo-element **behind** the button's opaque background, so only the 2px it overhangs is visible.

A first attempt added a wide blurred halo as a second layer. It rendered as a white blob stuck to one side rather than light moving around the edge — removed, with a tight `drop-shadow` on the same ring instead. Both animations respect `prefers-reduced-motion`.

---

## Phase 6 — Dashboard (2026-09-22)

### D59. Four metrics, four charts — never one chart with two scales

Sessions (a count), credits (a provider unit) and dollars are different scales. Putting two of them on one plot needs a second y-axis, which is the single most misleading thing a chart can do — any relationship between the lines becomes an artefact of where each axis was zeroed.

They are four separate single-series charts on a shared day axis. A single series needs no legend; the title names it.

### D60. The palette was computed, not chosen

Run through the dataviz skill's validator against both real surfaces rather than eyeballed. The first attempt (blue / aqua / orange / **green**) **FAILED** CVD separation at ΔE 3.2 for protanopia — green and orange are the classic confusion pair, and would have been indistinguishable to a red-blind reader.

Final: **blue `#2a78d6` · orange `#eb6834` · violet `#4a3aa7` · aqua `#1baf7a`** (with dark-mode steps), passing lightness band, chroma floor, CVD separation and normal-vision floor in both modes.

Aqua carries a sub-3:1 contrast WARN on white. That is not dismissable, so it takes the least critical series (future revenue) and every chart ships a direct end-of-line value label plus a full table view of the same numbers.

### D61. A viewBox in real pixels, because `preserveAspectRatio="none"` stretches text too

The first render used a 100-unit viewBox scaled to the container with `preserveAspectRatio="none"`. The line fitted perfectly; every axis label and marker was stretched horizontally with it.

Charts now render at the host's measured pixel width with uniform scaling, and re-render on resize. Verified: viewBox width 599 against a rendered width of 599.

### D62. Aggregation lives on the server

`/api/analytics?days=N` derives every figure from the ledger — a continuous day axis with zero-filled gaps, totals, per-provider budget state and the session list. The browser formats; it does not compute. A chart and the table below it cannot disagree.

### D63. Tabs wrap properly — `flex: 1` beats `width: 100%`

The narrow-width rule set `width: 100%` on the tab strip to push it onto its own row, but `flex: 1` had already set `flex-basis: 0%`, which wins. The tabs stayed inline and overflowed. Fixed with `flex: 0 0 100%`.

---

## Phase 7 — Google sign-in (2026-09-22)

### D64. Auth is off until a client ID exists

Shipping auth in the on position would have locked the operator out of their own dashboard the moment they pulled the change — before they had created anything in Google Cloud.

`authConfigured()` is false while both client IDs are blank, and every guard passes through. Setting either one turns enforcement on for the dashboard, the admin routes and session minting together.

### D65. The extension key is pinned, because an OAuth client is bound to one extension ID

An unpacked extension's ID is derived from its public key, so without a pinned `key` it differs per machine and profile — and a Chrome-Extension OAuth client is issued against exactly one ID.

A keypair is generated into `.secrets/` (gitignored), the public half goes in the manifest, and the ID is computed the way Chrome computes it: first 16 bytes of `SHA-256(spki)`, each nibble mapped `0-f → a-p`. **ID: `aadnmnhilcphhjnchilngaeandeldngc`.**

### D66. Two sign-in paths, because MV3 forbids the first one

The dashboard uses Google Identity Services and receives an **ID token**, verified in-process against Google's JWKS — signature, issuer, audience and expiry, all four. Checking fewer turns "signed by Google" into "signed by Google for somebody else's app".

The extension cannot load the GIS script at all (MV3 bans remote code), so it uses `chrome.identity.getAuthToken`, which yields an **access token**. The backend exchanges that for a profile at Google's userinfo endpoint and mints its own session token. The extension never handles an ID token, and the backend stays the only thing that decides who is signed in.

No JWT library: Node verifies RS256 against a JWK directly. One less dependency on the path that decides who gets in.

### D67. Stateless signed sessions

An HMAC over the payload with the server secret — not a session store. There is nothing to invalidate in a single-operator install, and a store is one more thing to get wrong. With `SESSION_SECRET` unset a random one is generated per boot, so an unconfigured install never signs with a predictable constant (everyone is signed out on restart, which is the right default for that state).

Signature comparison is `timingSafeEqual` with a length check first.

### D68. Sessions are attributed to whoever started them

`user: { email, name }` rides the lease and lands on the ledger line, so spend can be broken down per person once the extension has more than one. Entries written before sign-in existed carry `null`, which the dashboard renders as blank rather than guessing.

### D69. A 401 in the trial room is a button, not an error

The extension turns an unauthenticated refusal into a "Continue with Google" card that runs `chrome.identity` and then **resumes the try-on the user was attempting**, rather than making them find the garment again.

---

## Phase 8 — Polish round three (2026-09-22)

### D70. The spark follows the border path, not an angle from the centre

A rotating conic gradient sweeps by **angle**. On a pill — wide, not square — equal angles cover very unequal distances, so the highlight races across the flat sides and crawls around the caps. It reads as light emanating from the middle.

`offset-path: border-box` moves a real dot along the border geometry at constant speed, which is what "around the pill" means. Two dots half a lap apart, so the far side is never dead. Verified across three button widths; `CSS.supports` confirms the path resolves rather than silently parking the dot at the origin.

### D71. No dashed borders in the panel

Replaced with a flat white card; the drop state is now an inset ring instead of a dashed outline.

### D72. The dashboard is light, and does not follow the OS

Removed the `prefers-color-scheme: dark` block. A dashboard that flips theme depending on who opens it is one whose chart colours were validated against a surface it may not be rendering on. Dark remains available by stamping `data-theme="dark"`, using the steps validated against the dark surface.

### D73. Toolbar click opens a menu, and tutorial mode

`action.default_popup` replaces the click handler: open the trial room, watch the tutorial, plus live budget and the sign-in chip.

The tutorial is a 78vw × 78vh overlay, closable by button, backdrop click or Escape. The YouTube player sits inside an **extension-origin iframe** rather than being embedded directly into the host page, because a retailer's own CSP `frame-src` would often refuse `youtube.com` while a `web_accessible_resources` page is allowed. The video id goes in `extension/config.js`; unset, the window explains how to set it instead of showing a broken player.

### D74. Drag and drop was handing the model an HTML page

Product images are nearly always wrapped in a link, so Chrome drags the **anchor** — and `event.target.closest('img')` never matched. Our `dragstart` handler bailed, leaving Chrome's own pre-filled `text/uri-list`: the **product page URL**. The drop then fetched a web page and failed.

Reproduced exactly, then fixed three ways:

1. `draggedImage()` resolves the image from an anchor, figure, picture or card wrapper — not only from a direct `<img>` target.
2. The handler runs in the **capture** phase, so a site's own `dragstart` cannot stop it first, and writes a private `application/x-tryon-garment` type that the drop trusts ahead of anything Chrome pre-filled.
3. The **whole panel** is the drop target, not just the empty-state zone — which had disappeared behind the video once a session was running. A drop on a live panel now swaps the garment in place, free and without reconnecting.

Also handles a multi-line `uri-list`, dropped HTML, and an image file dropped from the desktop.

---

## Phase 9 — Polish round four (2026-09-22)

### D75. The spark is a streak, not a dot

`offset-rotate` defaults to `auto`, which turns the element to follow the path's direction — so a short bar rides the border tangentially and reads as a line. The first version set `offset-rotate: 0deg`, which kept the element axis-aligned and therefore only ever a dot.

Now one 34px gradient bar (transparent tail → bright head, `offset-anchor: 100% 50%` so the head leads) plus a longer, fainter wash behind it. One light with depth, rather than two objects orbiting.

### D76. The toolbar menu is customer-facing

Removed the dashboard link **and** the budget readout. What a try-on costs us is operator information; a customer opening the extension should see the trial room, the tutorial and a sign-in button — nothing about spend. The header now reports reachability ("Ready" / "Offline") rather than seconds and dollars.

Operator figures live in the dashboard, behind sign-in, which is where they belong.

### D77. Fixed grid minimums forced the page wider than the viewport

Reported as numbers overflowing their cards. Two earlier scans found nothing because they constrained `body` width rather than the actual viewport — which does not reflow a grid the way a real narrow window does. Reproducing at a genuine 430px width showed the whole page scrolling sideways, with `$5.86 / $6.00` and `0 runs left in budget` cut off at the edge.

Cause: `repeat(auto-fit, minmax(300px, 1fr))` cannot shrink a track below 300px, so the grid — and the page — stayed 300px+ wide regardless. `repeat(5, 1fr)` on the sample thumbnails did the same.

Fixed with `minmax(min(300px, 100%), 1fr)` throughout, `flex-wrap` on every label-and-figure row, `min-width: 0` on grid and flex children, `overflow-wrap: anywhere` on the long figures, and `overflow-x: hidden` on the document as a backstop.

Verified at 430px on both surfaces: no horizontal scroll, nothing clipped, on every tab.

**Lesson worth keeping:** to test reflow, change the viewport, not an element's width.

---

## Phase 10 — Settings, and the control panel retired (2026-09-22)

### D78. The chart gutter is measured, and the block that broke had resisted two patches

Reported again as numbers overflowing. My first scan checked only the **right** edge and reported clean; the labels were escaping **left** — `$10.00` by 27px, clean past the card border.

Cause: `PAD.left` was a fixed 42px, narrower than the widest formatted label, and the SVG is `overflow: visible`, so a negative x renders outside the card rather than being clipped.

Worse, when I first fixed it the numbers got *larger*. The grid block still contained `PAD.left / 6` — arithmetic left over from the original 100-unit viewBox — because two earlier patches had silently failed to match it. With `PAD.left` now undefined that evaluated to `NaN`, every label fell back to x=0, and the whole gutter vanished.

The gutter is now measured per chart with `canvas.measureText` in the axis font, so each gets exactly what its own labels need (18 / 32 / 38 / 33px). The end-of-line value label is also clamped so it cannot escape the top when the last point is the maximum.

**Two lessons:** check every edge, not the one you expect; and when a string replace is meant to change behaviour, verify it matched.

### D79. The control panel is gone

Its provider switch, kill switch and session length moved into the dashboard's Settings tab. Its try-on harness — the paste-a-URL rig from before the extension existed — was superseded by the extension itself and is no longer a thing worth maintaining. `/admin` redirects to `/dashboard/#settings`.

One screen fewer to keep consistent, and nothing operator-facing lives outside sign-in any more.

### D80. Settings are data, not deploys

`data/settings.json` holds the tutorial video, all customer-facing copy, and the Google client IDs and allowlist. The dashboard writes it; the extension reads `/api/settings` on open and caches for a minute.

Changing the trial-room title or the tutorial video is now an edit in a form, not a rebuild and a reload of the unpacked extension. The defaults are compiled into the extension too, so an unreachable backend degrades to the shipped copy rather than blank strings.

Three details worth keeping:

- **`.env` wins over the file for client IDs.** An operator who configured them the documented way is not silently overridden by stale stored state.
- **Allowlists are additive.** `.env` and the dashboard both grant; neither can lock the other out.
- **A YouTube *link* is accepted, not just an id.** `watch?v=`, `youtu.be`, `/embed/`, `/shorts/` and `/live/` are all parsed, on the server and again in the browser so the preview updates as you paste.

### D81. The extension ID sits beside the field that needs it

A Chrome-Extension OAuth client is bound to one extension ID, so the Settings tab reads it from `.secrets/extension-id.txt` and prints it next to the client-ID input rather than sending the operator to find a file.

---

## Phase 11 — The extension stopped loading (2026-09-22)

### D82. A `const` called before its declaration killed the whole content script

Reported as: no Try-On pills anywhere, and the toolbar menu saying "Not available on this page".

That message comes from `chrome.tabs.sendMessage` throwing, which means no content script is listening. The cause was a regression from D80: the settings fetch was inserted near the top of the IIFE, above `const send = …`.

`const` is not hoisted. Calling it earlier throws `ReferenceError: Cannot access 'send' before initialization` **at load**, so the script died before `chrome.runtime.onMessage.addListener` ran — and every page reported itself unavailable, on every site, including the ones that had worked minutes earlier.

The fetch now lives in a named `loadSettings()` called after the definitions, so the ordering requirement is explicit rather than positional.

### D83. No site gate — discovery runs everywhere

`isFashionPage()` was a hard early return. Two problems: it decided a per-image question at page level, and sitting above the listener registration it also broke the toolbar menu on any page it rejected.

Removed. Whether an image gets a button is already answered per image — 120px floor, aspect-ratio bounds, and the garment-category check from D51. A page-level veto added nothing those do not already do, and cost the menu everywhere.

The function stays in `detector.js`, unused: it encodes real research into how Anywear gates, and is worth keeping if per-site behaviour is ever wanted again.

### D84. `node --check` cannot catch this, so the suite now can

A temporal-dead-zone error is **valid syntax**. `node --check` passed the broken file, the extension loaded with no visible error, and the only symptom was a misleading message in a menu.

Two new tests:

1. **Use-before-declaration** across `content.js`, `detector.js`, `background.js`, `popup.js`. Scoped to the outer IIFE by indentation — a first attempt flagged function-local `overlay` and `push` as violations, because name-matching without scope is noise, not signal.
2. **The message listener must be registered unconditionally** — no early `if (!x()) return;` may sit above it.

Both were verified by reintroducing the exact regression and watching them fail (`"send" is called on line 15 but declared on line 38`), then pass once reverted.

Also confirmed by loading the real `detector.js` and `content.js` into a page with a stubbed `chrome`: no errors, listener registered, hover button injected, and the pill appearing at the image's top-left + 8px — on a page that is explicitly not a shopping site.

---

## Phase 12 — Pills, gated and preloaded (2026-09-22)

### D85. The site gate is back — over the feature, not the file

Removing it in D83 made pills appear on any large image anywhere, which is not the product. It is restored, but positioned differently: the message listener now registers **first and unconditionally**, and the gate wraps only `startDiscovery()`.

That distinction is the entire lesson from D82. An early return at the top of the file took the toolbar menu down with it on every page it rejected; a conditional call at the bottom cannot. The call is also wrapped in `try/catch`, so a throw inside discovery can never again cost the menu.

### D86. Pills are preloaded, one per garment

A single shared button that chased the cursor meant nothing was visible until you hovered the right image. Every candidate now gets its own pill at load, and as new ones arrive through the `MutationObserver` — the mode Anywear ships as "always-show try-on buttons".

Each pill is absolutely positioned **inside the image's own container**, not fixed to the viewport, so it scrolls with the image for free rather than needing a scroll handler to keep hundreds in sync. A container is relativized only when it closely wraps the image (within 2.5× its width); doing it to a page-level wrapper can shift a whole layout.

Positions are re-seated on scroll, resize and image load (throttled to one animation frame), because lazy loading swaps in taller assets after the pill is placed.

### D87. The spark is a stroked path, not a moving element

`offset-path` moves a *straight* bar along a curve, so at the pill's rounded caps the ends lifted off the border — the tail hanging outside it.

It is now two `<rect>` strokes with `stroke-dasharray`, animated by `stroke-dashoffset`. A dash travels the rect's own perimeter, so it is geometrically incapable of leaving the border. `pathLength="100"` normalises the path so the dash reads as percentages and one rule fits every pill width, and `rx: 999px` is clamped by the renderer to half the height for an exact pill.

A long faint trail (30%) carries a short bright head (10%) offset 20 units along it, both animating a full 100-unit lap so the loop is seamless. The first attempt animated the head from −20 to −100 — only 80 units, which would have stuttered once per cycle.

### D88. The control panel's files are gone, and its one real test moved

D79 removed the route; the 6.8MB of files stayed. Removed now, after resolving two genuine dependencies rather than deleting through them:

- **The build wrote the SDK bundle into `public/admin/vendor` and copied it to the extension.** It now builds straight into `extension/vendor`.
- **`camera.test.ts` imported `public/admin/camera.js`** — a module the extension had stopped using, so the regression it guarded (double-wrapped `getUserMedia` constraints) was no longer covered on live code. Rewritten to assert against `extension/widget.js` itself: no nested constraint objects, explicit numeric dimensions, no microphone, front camera.

A test guarding code nothing runs is worse than no test, because it reads as coverage.

### D89. The spark traced the wrong outline — SVG clamps rx and ry independently

The dash followed the border but not the *pill*, because `rx: 999px` in CSS does not produce a pill.

Per spec, `rx` is clamped against **width/2** and `ry` against **height/2**, separately. On a 75×29 pill that yields rx=37.5, ry=14.5 — an ellipse-cornered rectangle. The stroke was faithfully tracing a shape the button does not have.

Both radii must equal half the height. Getting there took three corrections worth recording:

1. **`element.style.rx` silently does nothing** — `rx` is not a supported CSSOM property. Written as a presentation attribute instead.
2. **A CSS rule for `rx` beats that attribute**, so the `rx: 0` placeholder had to go entirely rather than be overridden.
3. **`requestAnimationFrame` never fires in a backgrounded tab**, so deferring the measurement left pills square until the user returned to the page. It is applied synchronously — `offsetHeight` forces the needed layout anyway.

It is also idempotent and re-applied from `reseatPills()`: a pill first measured before its stylesheet applied would otherwise keep a wrong radius for the page's life. The radius is additionally clamped to half the *width*, so a very short pill stays round rather than lens-shaped.

Verified: rx = ry = 13.5 on a 29px pill, on both the trail and head rects.

---

## Phase 13 — Product context, and whether an AI model belongs here (2026-09-22)

### D90. "Unknown means allowed" is what put a pill on a photo of a shop

Reported: the pill appears on store images. The cause was D51's fail-open rule — `category === null` was treated as permission. A storefront photo, a campaign shot and a payment-methods strip contain no garment words, so all three were classified `null` and admitted.

Absence of disqualifying words is not evidence. `isWearable` now requires **positive product context** for an unclassified image:

- an ancestor link whose href looks like a product page (`/product/`, `/products/`, `/dp/`, `/item/`, Shopify's `collections/x/products/`), **or**
- a price in the image's own card, **or**
- the page is a PDP by schema.org JSON-LD and the image is large

Separately, `isPageFurniture` rejects anything inside `header`, `nav`, `footer`, `aside` or an ARIA banner/navigation/contentinfo region, and anything named like site furniture (logo, banner, hero, payment, badge, storefront, map, social…).

Verified on a page mixing all six cases: logo, storefront, unlinked campaign shot and payment strip all blocked; a linked product and a priced card both keep their pill.

### D91. Jev cannot do this job — it is text-only

Evaluated TypeSafe's Jev for classifying whether an image is a product. From their documentation, verbatim:

> "Jev accepts text only. State must be a string, JSON object, or array of text values. Images, audio, and video are not supported (yet)."

So it cannot look at the pixels. It could only judge the **text around** an image — the same alt text, link href and card copy the heuristic already reads, interpreted with better judgment. That is a real improvement for ambiguous cases, but it is not "classify the image".

Deliberately not adopted yet, for three reasons:

1. **The reported failure was a rule bug, not a perception problem.** Fixing fail-open removed the storefront case entirely, at zero latency and zero cost.
2. **Cost and latency scale with images.** A category page carries 60+ candidates. Any per-image model call is a network round trip before a verdict, which fights the preloaded-pill requirement.
3. **Anywear does not do this either.** Their answer to the same problem is per-retailer filters plus structural heuristics — the approach now implemented here.

**If perception is genuinely needed**, the tool is a *vision* model, not Jev — and Decart's own `full-featured` example already shows the shape: GPT-4o-mini to detect whether an upload contains a person, before running extraction.

The architecture that would preserve instant pills: heuristics decide immediately, and a **batched background classification removes** pills that turn out wrong, cached by image URL. Removal is safe to be slow; showing is not.

Worth measuring how often the heuristic is still wrong before paying per image to find out.

### D92. `bottom` was blocked, which silenced an entire store

Reported: no pills on `blu.cash/products/noir-cathedral-shorts`.

Diagnosed against the live page rather than guessed. The page was detected correctly — PDP by JSON-LD, **19 valid candidates** — but every image classified as `bottom`, from "Noir Cathedral **Shorts**" in the `h1`, and `bottom` was absent from the allowed set.

That exclusion came from D51, generalising Anywear's Revolve filter: *"dresses and tops yes; jeans, shoes, bags no."* But that is **one retailer's policy about its own catalogue**, not a statement that the model cannot render trousers. Applied globally it blocked a store whose products are shorts.

`bottom` is now allowed. Shoes, bags, eyewear, jewellery and accessories stay out for the reason that still holds: they are nowhere near a torso, and the model puts them somewhere it can (D51's bracelet rendered as sunglasses).

Re-measured on the same page: **0 pills → 10**, with 9 correctly blocked as furniture.

### D93. The category policy is per catalogue, so it belongs in settings

Hard-coding this set was the mistake twice over — first by excluding bottoms, then by there being no way to correct it without a rebuild.

`discovery.wearableCategories` is now part of the settings file, editable from the dashboard as a row of chips, and read by the extension on open. A store that sells only dresses can narrow it; one selling shorts does not have to wait for a release.

Because settings arrive *after* the first scan, a change to the policy triggers `rescanPills()` — removing pills a stricter set no longer admits and adding images a looser one now does, rather than leaving a stale mix of both.

### D94. Commerce evidence does not exist on a curation feed

Reported: pills stopped appearing on Pinterest t-shirt pins. Caused by D90's product-context requirement.

Inspected the live DOM rather than guessing. A Pinterest pin offers:

| Signal | Value |
|---|---|
| `alt` | `"Pin"` — no garment word |
| Ancestor link | **none** |
| Price nearby | none |
| schema.org Product | no |

So `categoryOf` returned `null`, and an unclassified image needs product evidence — of which there is none, by design. Pinterest is not a shop.

**Two compounding causes, two fixes:**

1. **The search query was invisible.** `categoryOf` read `location.pathname` only, so `/search/pins/?q=oversized t-shirt` said "t-shirt" nowhere it looked. It now reads `pathname + search`, which is the clearest statement of intent on any search page.

2. **Curation feeds are exempt from product context.** On Pinterest, Instagram and similar, the image *is* the content; there is nothing to corroborate it with. `isCurationFeed()` grants context on those hosts.

The distinction is deliberate and narrow: curation hosts are **explicitly allowlisted**, while a commerce site detected by platform signature still has to show a product link, a price or a PDP. Verified both directions — Pinterest **0 → 3 pills**, and on a commerce host a storefront photo and an unlinked campaign shot remain blocked while a linked product keeps its pill.

**The pattern worth noting:** each of the last three fixes tightened or loosened one rule and broke a case the other served. Precision rules need testing against both the case they target and the cases they must not touch, on real pages — a synthetic fixture would have shown none of these.

---

## Phase 14 — Making the backend deployable (2026-09-23)

### D95. The guardrails could not survive serverless, and would have failed silently

Asked to deploy the dashboard. Two things made that unsafe rather than merely imperfect, and both were verified before writing any code:

1. **`authConfigured()` was false**, so every guard passed through — `POST /api/session`, which spends real Decart credits, would have been a public unauthenticated endpoint.
2. **All the state lived in one process.** The ledger and settings were files on disk; the concurrency counter and budget reservations were a `new Map()`. Vercel functions share neither. The ledger would evaporate and the overspend protection would **report success while doing nothing** — the worst possible failure for a guardrail.

### D96. A store interface, with the atomic decision inside it

`Store` owns everything that must outlive a request. Two implementations: `FileStore` (disk + memory, correct for one long-lived process) and `RedisStore` (Upstash over its REST API — no SDK, because a serverless function cannot hold a TCP connection).

The important part is that **`reserve()` is one call, not a read then a write**. Split across two round trips, two instances handling simultaneous requests would both see room and both admit a session — precisely the overspend the budget exists to prevent. In Redis it is a Lua script, so the check and the record cannot interleave; on one process the event loop gives the same guarantee for free.

`assertDurableIfServerless()` refuses to boot a serverless deployment that has no Redis, rather than letting it fall back to files and quietly lose its guarantees.

### D97. Settings are cached synchronously on purpose

The auth layer reads settings from `readSessionToken`, which is on a synchronous path; making it async would ripple through every request guard for a value that changes rarely.

So `readSettings()` stays synchronous over a cache, and `refreshSettings(ttl)` runs as middleware — once at boot for a long-lived process, and at most every 30s per invocation on serverless, where a cold start would otherwise serve defaults and a warm one stale values.

### D98. A password gate now, Google sign-in layered on later

`DASHBOARD_PASSWORD` gates everything except `/api/settings` and `/api/health`, which the extension must reach. A valid Google session bypasses it, so the two can overlap while sign-in is being configured rather than requiring a switchover.

Blank means no gate — correct for localhost, and the reason the deployment instructions set it before the first deploy rather than after.

### D99. One bug this refactor introduced, caught by reading the output

`analytics.ts` called `ledger.recent(200)` without awaiting it, and `JSON.stringify` turns a Promise into `{}`. The dashboard's Sessions tab would have silently shown nothing. Visible only because the verification printed the payload rather than asserting on a status code.

Converting a synchronous API to async makes every un-awaited call a silent empty value rather than a type error at the call site — worth grepping for on the next such change.

## Phase 15 — the deployed dashboard was unusable

### D100. `fetch` does not raise the browser's password dialog

The gate was HTTP Basic. That works from `curl`, and it is why every verification passed. In a browser it does not: a `fetch()` that comes back 401 with `WWW-Authenticate` does **not** open Chrome's credential dialog the way a top-level navigation does. The deployed dashboard therefore rendered its shell, fired four requests, got four 401s, and sat there with empty cards and no way to type anything.

The fix is a password screen the page owns: `POST /api/auth/password` compares with `timingSafeEqual` and sets `vton_gate`, an HttpOnly cookie. `/api/auth/me` now reports `gate: { required, satisfied }` so the page knows to draw the screen before it makes any call that would only be refused.

The cookie holds an HMAC over a **fingerprint** of the password, not the password. Changing `DASHBOARD_PASSWORD` invalidates every cookie minted under the old one without any server-side list to clear.

Basic auth still works, because that is what the verification scripts use.

### D101. Only `/api/` is gated

Express was gating the dashboard's own HTML, so locally there was no way to reach the screen that asks for the password. On Vercel the CDN serves those files and never reaches the middleware at all — so the two environments disagreed about what the gate even covered.

Now the gate covers `/api/` and nothing else, which makes local and deployed identical. The page holds no figures; every number on it arrives through a call that is gated.

**The dashboard HTML is still world-readable at `/dashboard/`.** That is a deliberate consequence, not an oversight — closing it means Vercel Deployment Protection or serving the HTML through the function, and both are decisions with costs.

### D102. A 401 body is not a settings object

`initSettings` did `(await fetch('/api/admin/settings')).json().catch(() => null)`. A refused request still returns valid JSON — `{ error: "Password required." }` — so the catch never fired, and `fill()` died on `settings.auth.webClientId`. That exception propagated out of the module's top-level `await` and took the rest of the page down with it.

Status decides now, not parseability. The general shape: `.catch()` on `.json()` only covers a body that is not JSON, which is the rarer failure.

## Phase 16 — accounts, credits and payments

### D103. Supabase for accounts, Redis kept for the hot path

Users, credits, plans and payments are relational and must be auditable, so they live in Supabase Postgres (project `tryoncam`, `rrlfdcwzrmftmqqmanpb`, us-east-1 beside the Vercel functions). The budget reservation stays in Redis: it is on every session start and has been proven under a race. Moving it would have meant re-proving it.

Every balance change is a SQL function — `hold_credit`, `refund_credit`, `grant_credits`, `upsert_user` — so a check and its write are one statement. Verified against the live database inside a rolled-back transaction: a fourth hold on three credits is refused, refunds and payment grants apply exactly once, and the balance equals the ledger sum.

RLS is on for every table with no policies, and anon/authenticated have no grants: only the backend's secret key reaches any of it. Probed with the public key: all seven calls the backend makes come back "permission denied", which also proves every function and parameter name resolves.

### D104. A credit is spent when the video starts

The Terms say so. A credit is held when a session is minted and refunded if the session ends without having started — through a hook on `SessionGuard` that fires for every ending, including timeouts, so no path can forget it. Operators never pay; a switch in the dashboard makes it free for everyone.

### D105. Every reservation sweeps first

Both stores dropped expired leases inside their own `reserve`, silently: no ledger line, no refund. The interval sweep usually got there first on a long-lived process. On serverless nothing runs between requests, so a session whose tab vanished mid-stream was **never charged against the budget**. The guard now sweeps before reserving, and a test proves the vanished session is charged its grant.

### D106. Three access levels, not one gate

Public, customer, operator. The old gate let any signed-in Google user through, which was harmless while the only person signing in was the operator. With customers able to sign in it would have handed every one of them the analytics and admin API. Admins are `ADMIN_EMAILS` plus the dashboard's list; an empty list now admits nobody, the reverse of the old rule. Tested for each level.

`/extend` is operator-only: open to customers it was free seconds on request.

### D107. Session and gate tokens carry a type

Both are HMAC-signed with the same key in the same shape. A gate cookie presented as a bearer token parsed as a user with no email. Each now carries `t`, checked on read. Tested.

### D108. The extension signs in with launchWebAuthFlow and an ID token

`getAuthToken` needs the client ID in the manifest, works only in Google Chrome with a signed-in profile, and returns an access token — the old backend exchanged it at `userinfo`, which proves only that Google issued it to *some* app. A token captured on any other site could have signed someone in here. Now one Web client serves dashboard and extension, its ID arrives with the on-air settings, and the backend verifies audience and a nonce the extension chose.

### D109. Checkout re-checks the price at the moment of sale

The dashboard can check every plan's price ID against Stripe on demand. Checkout checks the one plan being bought again and refuses on any difference in amount, currency, one-off vs recurring, or interval — a price can be archived or edited in Stripe after the operator last looked. Credits bought are snapshotted into the Checkout metadata, so editing a plan never changes a past purchase. Subscriptions are paid out on `invoice.paid` only, including the first, so `checkout.session.completed` cannot pay twice.

### D110. Run controls persist in the store

Provider, kill switch and session length were process memory. On serverless each instance has its own, so a kill switch flipped from the dashboard was off on every other instance. They are stored now, applied on every settings refresh, and read fresh at session creation. A settings save cannot overwrite them.

### D111. A rejected promise at import killed cold starts

`api/index.ts` started the settings read at import and awaited it only inside the handler. A Redis timeout on a cold start rejected before anything awaited it — an unhandled rejection, which ends the process. Pre-existing; surfaced by the first request after deploy. Caught at creation now.

## Phase 17 — production configuration from the dashboard

### D112. Keys and limits are overridable at runtime, not redeployed

The Environment tab overrides a chosen set of Vercel variables: the Stripe secret key and webhook secret, the Decart key, the Supabase secret key, the Decart budget and price, the session-length ceiling and the concurrency limit. A saved value beats Vercel's; clearing it returns to Vercel's. Overrides ride the settings refresh, so they reach every instance within 30 seconds.

Every key is proven before it is saved, with a zero-cost call using the candidate — Stripe lists one price, Supabase reads the plans table, Decart mints a client token that is never streamed on. A typo is refused rather than taking production down. Verified in the browser: a fake Stripe key came back "Not saved — Stripe refused it".

The four modules that captured a key or price at construction now read live or reset their client on change (Stripe client, Supabase client, Decart price and model).

### D113. Secrets are write-only, sealed, and changeable only under a name

Overrides live in their own store key, not in settings, because the settings record is served to the dashboard whole. Secrets are AES-256-GCM sealed under `CONFIG_ENCRYPTION_KEY` with the variable's name as associated data, so ciphertext cannot be moved from one variable to another (tested). The browser only ever gets a masked hint — prefix and last four.

Viewing is for any operator; changing needs an admin's Google session. The shared password is one secret many people may hold, and a swapped Stripe key sends the takings to someone else's account. Every change is logged with the admin's email.

Redis, the session secret, the dashboard password and the encryption key stay Vercel-only, and the tab says why: the first is where overrides are stored, the rest are how you get back in if an override goes wrong.

### D114. SESSION_SECRET was pushed to Vercel empty

The deploy script generated a secret only when `.env` had no `SESSION_SECRET` line — and `.env` had one, empty, copied from the example. The empty value went to Vercel, the config fell back to a random secret per instance, and I reported it as set without checking. The Environment tab's Vercel-only list is what showed it as missing. Replaced with a real secret; 30 parallel requests on one login now all succeed.

The general lesson: "the line exists" is not "the value is set". Check length, never presence.

## Phase 18 — pills everywhere, accounts, live pricing

### D115. No site gate; every image answers for itself

`isFashionPage()` ran once at `document_idle`. Stores that build their page afterwards — Myntra, and most modern shops — failed it and got nothing, silently. It is gone. An image gets a pill if it names a product or sits beside commerce evidence (a product link or a price); that per-image rule is what keeps pills off logos and shop photographs.

The observer also re-examines: rejected images are retried every 1.5s, attribute changes (lazy `src` swaps) and every image `load` trigger a batched scan. Product links now include `…/29993984/buy` and `-p-12345` shapes. An image whose own alt text names a product ("Men Brand Logo Printed T-shirt") is never treated as a logo. Verified against Myntra's live listing: 33 of 33 product tiles.

### D116. Pills live in their own layer

Inside the shop's card, a pill inherited the card's hover fade (the "transparent pill"), was clipped by `overflow: hidden`, and was never placed when no close wrapper could be made its positioning parent. Pills now sit in one layer at the document origin, top-right of the image (top-left is where shops put badges), restyled from `all: initial` with `!important`. A pill whose spot is covered — a sticky header scrolled over it — hides; the check uses `elementsFromPoint` and skips our own nodes, because the pill forces itself visible and was finding itself. Verified on a mock page with a fading card, a badge, a sticky header and a hostile `button { opacity: .3 }` rule.

### D117. Clothing by default, again

Jewellery was switched on at the operator's request and came back wrong — earrings rendered as a necklace. Lucy VTON dresses a torso; this is the model, not the detection. Default is clothing plus any unrecognised product with commerce evidence; "every product image" remains a dashboard option.

### D118. Customer accounts reuse the extension's session

"Go to your account" opens `/account/#handoff=<session token>`. A fragment never reaches a server or a log; the page trades it for a cookie and strips it at once. The token is the same one the extension already holds, checked with the same type tag, so a gate token cannot be handed off (tested). The account page can also sign in directly with Google as a customer.

### D119. tryoncam.com reads its pricing from the backend

Plans come from the database and the words from settings, through a public, CORS-limited endpoint. The hand-written HTML stays as the fallback if the request fails. The pricing heading lost its SplitText line reveal: a split heading re-splits its *original* words on resize, which would revert an edited heading.

## Phase 19 — stream latency and mid-session drops

### D120. The latency floor is geography

Decart's realtime server (`api3.decart.ai`) is in Israel (Nebius, `46.243.146.44`). From the operator's Mac in India on a phone hotspot, a TCP connect to it takes 220–310 ms against 29 ms to Vercel's edge. Every frame makes that round trip. The host is fixed inside the SDK; only Decart can offer a nearer region. First frame arrived in 4.3–4.7 s in every session on record, on both networks — consistent enough to be Decart-side more than ours. Garment preparation now overlaps the camera and connection instead of following them.

### D121. The countdown runs on Decart's clock

The local countdown started after `setImage` resolved; Decart's cap started earlier. On a slow uplink the gap was seconds, Decart's cap cut the stream while our countdown showed time left, and the SDK — which treats only `moderation_violation` and `insufficient_credits` as deliberate ends — read the closed socket as a network drop, tried to reconnect, and surfaced "Connection lost". The countdown now follows `generationTick`; `MARK_STARTED` fires on the first generated frame; a `generationEnded` with a time, credit or moderation reason ends the session at once, so the SDK never reconnects into a second billed session; `reconnecting` is shown as such. The dashboard log records Decart's own reason and second count.

Not verified with a live session: each costs Decart credit, and the account had roughly 170 of ~1,000 left.

### D122. Background-image photos, and Pinterest judged by exclusion

Myntra's product pages draw their gallery as CSS backgrounds (`div.image-grid-image`), and the extension had only ever looked at `<img>`, so product pages got no pills at all. Elements with an inline `background-image` are now candidates when photo-sized (≥200px, ratio 0.4–2.5) and holding no real image of their own. Verified on a live Myntra product page: the three gallery photos are accepted as the product, the nav banner is not.

Pinterest: D-series change requiring every pin to name a garment left most clothing pins bare — pin descriptions rarely name the garment. Reverted to exclusion: a pin loses its pill only when its own words name something unwearable (a book, a mug, jewellery in clothing mode).

## Phase 20 — launch readiness

### D123. Store package

Version 1.0.0. Permissions reduced to `storage` and `identity` (plus host access): `tabs` was never needed — creating a tab, querying the active tab's id and messaging it all work without it — and it added an install warning about reading browsing history. `npm run package:ext` builds the upload with the manifest `key` removed and the private key included as `key.pem`, which keeps the ID `aadnmnhilcphhjnchilngaeandeldngc` that Google sign-in and the install link are bound to. Verified the key derives that ID. `dist/` is git- and vercel-ignored because the first-upload zip carries the key.

Fixed on the way: the tutorial page's script was inline, which MV3 blocks, so it had never run; the toolbar menu now reads its wording from settings (the dashboard fields had no effect) and hides the tutorial until a video is set; a failure message rendered as markup (an image host's content type could inject into the shop page) now renders as text; dead `action.onClicked` code removed. The bundled SDK has no eval, dynamic code or remote script.

### D124. Listing assets are built, not drawn

`store/build-assets.mjs` renders the icon, five 1280×800 screenshots and both promo tiles with headless Chrome from the extension's own stylesheet, and pulls live prices for the pricing shot. The live-trial-room screenshot and the marquee use a studio photo where the try-on output appears; they are marked for replacement with a real session frame, because store policy treats screenshots that do not show real output as misleading. A drug-reference graphic tee was kept out of the listing images. `tryoncam.com/demo.html` gives reviewers a shop that always shows pills, wherever they are.

## D125 — Website prices are never cached and never flash stale
`/api/public/pricing` now sends `Cache-Control: no-store` (was `max-age=60`), and `site/assets/pricing.js` fetches with `cache: 'no-store'`. The pricing cards stay invisible until the live prices arrive, or for up to 3.5s if the request fails, after which the built-in cards show. The built-in cards now carry the current $9/$24/$49 prices, so even the fallback is right.

## D126 — .vercelignore rules for top-level folders are anchored
An unanchored `store/` (meant for the Chrome Web Store assets) also matched `src/store/`, so the database layer was left out of the deploy and every API call crashed with ERR_MODULE_NOT_FOUND. Top-level-only rules are now written `/store/` and `/dist/`. After any backend deploy, check that `/api/health` returns 200.

## D127 — The demo video ships everywhere, from one hosted file
The one-minute launch video (brag-output-2026-09-24-174059) is published as `site/assets/demo.mp4`: 720p H.264, CRF 26, AAC 96k, faststart, 4.2 MB (the 1080p master is 20 MB), cached for a day by `site/vercel.json`.
- Landing page: the demo player plays it; the section's copy no longer claims "no stand-in model" (the live shots are staged photos).
- Extension: the tutorial setting now accepts an https link to a video file as well as a YouTube id, and defaults to the landing page's file, so "Just watch the tutorial" appears. `tutorial.cleared` records a deliberate empty value, so an operator can still hide it.
- Account page: "How it works" is now "Watch the 1-minute demo", linking to tryoncam.com/#demo.
- The Chrome Web Store's promo video field only takes a YouTube link, so that one needs a YouTube upload.

## D128 — The extension's tutorial plays the YouTube upload, hosted on tryoncam.com
The tutorial default is now the YouTube upload `ikWsa3Cd8UE`; a stored copy of the earlier default (the demo.mp4 link) is swapped for it, while anything an operator chose is kept. YouTube refuses to play inside a chrome-extension:// page (player error 153, no website as the embedder), so the extension frames `tryoncam.com/watch.html?v=<id>`, which hosts the player. The landing page keeps playing `assets/demo.mp4` directly.

## D129 — Install opens the welcome page
`background.js` opens `https://tryoncam.com/demo.html?installed=1` on `onInstalled` with reason `install` only (not updates or browser restarts); `tabs.create` needs no extra permission. The demo shop is now the welcome page: with `?installed=1` it greets ("You're all set"), shows three setup steps (pin, hover + Try On, sign in for 3 free), the one-minute demo (`assets/demo.mp4`, poster `assets/img/demo-poster.jpg`, nothing downloads until Play), and the sample shop, which now includes the tees from the video. Without the parameter it stays the plain "Try it here" demo shop the store reviewers use.

## D130 — Support email is a dashboard setting; legal address filled in
`settings.contact.supportEmail` (default support@tryoncam.com, validated as a plain address, empty = default) is edited in Admin → Settings → Support email. The account page reads it from `/api/account`; tryoncam.com's home, privacy, terms and refunds pages fetch `/api/public/site` (CORS for the site origins, no-store) and swap every mailto link and every visible occurrence of the default, keeping the written-in address if the request fails. The Chrome Web Store listing's support field is outside the platform and must be changed by hand.
Legal pages now name One Man Holdings LLC, 30 North Gould Street, Sheridan, Wyoming 82801, United States, and Wyoming law governs the Terms.

## D131 — Pricing cards no longer show a per-try-on price
At the owner's request, the "$x per try-on · save y%" line is gone from every pricing table: the landing page's live cards (`pricing.js`), its built-in fallback cards, and the account page's cards. Price, credit count, description and features stay. The fallback cards now carry the live Stripe prices ($19 / 10, $49.99 / 30, $119.99 / 99).

## D132 — Session length shown to customers follows the run controls
The pricing note's copy uses `{seconds}`, filled server-side with `runtime.sessionSeconds` in `/api/public/pricing` (landing page and account page); a stored copy of the old fixed "up to 15 seconds" note is migrated to the token. The landing page's other mentions (hero widget, speed row, FAQ) are `data-session-seconds` spans filled from `/api/public/site`. The session-length save now re-reads the Longest-session ceiling before clamping (a just-raised ceiling on another instance used to clamp silently back to 15), and the dashboard's toast says when a value was capped.

## D133 — Link preview is picked in the dashboard; six thumbnail designs
`store/og/thumb.html` holds six designs (A see it on you, B click Try On, C fitting room, D brand, E swap outfits, F try anything), laid out in units of the frame height so one design renders at any size. `store/og/build.sh` writes 1200x630 link previews to `site/assets/og/og-<v>.jpg` and 1280x720 YouTube thumbnails to `store/og/out/yt-<v>.jpg`.
Every tryoncam.com page's og:image / twitter:image is `https://app.tryoncam.com/api/public/share-image.jpg`, which serves the bytes (not a redirect: not every preview crawler follows one) of `settings.share.image`: a design id, or any https image link. Admin → Settings → Link preview picks it. Apps cache previews they have fetched; the Facebook Sharing Debugger and LinkedIn Post Inspector force a refresh.

## D134 — Vidu S2-Editing tested live: not good enough, Decart stays
Tested on 2026-09-28 in a standalone local demo (`../vidu-demo`, outside this app) against the real API on api.vidu.com. There were two one-minute sessions with an uploaded garment. The first try-on frame arrived 3.4 s and 7.5 s after going live. Vidu billed 60 s and 58 s, $0.59 in total, within a second of our own timing, so the billing window in `docs/VIDU-API-NOTES.md` §7 holds. The owner judged the quality and garment accuracy low and the latency high. Vidu stays gated off (D16), and Decart remains the only provider.
Found in passing, contradicting `docs/AUTH-PROBE.md`: a made-up key gets 403 (not 401), and a valid key's lookup of a missing session gets 500 (not 404/400). A probe must compare against a made-up key rather than read status codes alone. The in-house engine's first test (`../tryoncam-engine/DECISIONS.md` D7–D9) also fell well short of Decart.
