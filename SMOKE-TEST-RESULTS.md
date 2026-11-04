# Smoke Test Results

Real measurements only. Anything not measured is marked as such.

## Spend to date

| | |
|---|---|
| Sessions billed | 2 |
| Seconds billed | 24s |
| **Spent** | **$0.48** |
| Budget remaining | 276s of 300s ($5.52 of $6.00) |
| Decart balance | ~952 of ~1,000 credits |

Six other sessions cost **$0.00** — token mints and failed starts are not billed, because Decart bills per streamed second.

## Run 1 — 2026-09-22, Decart `lucy-vton-latest`

| Measure | Result |
|---|---|
| **Time to first transformed frame** | **4,124 ms** |
| Billed | 14s ($0.28) |
| Garment fidelity | ❌ **Wrong garment** — rendered a black t-shirt from a white-tee reference |
| Connection | ✅ Connected, camera published, output rendered |
| Cap enforcement | ✅ Stopped by operator inside the 15s cap |

### Time to first frame: 4.1 seconds

The brief's UX target was **1–2 seconds**. Measured is **4.1s**, from `realtime.connect()` to the SDK reporting `generating`.

This is one sample on one network and includes connection setup, so treat it as an upper bound rather than steady-state latency. It is not fast enough for the "click and instantly see yourself" feel the brief describes, but it is not disqualifying either — a spinner covers 4 seconds. **Needs 3–5 more samples before drawing a conclusion.**

Frame rate and resolution: not yet measured.

### Fidelity: the garment came from the text, not the image

The output was a **black t-shirt** when the reference image was a **white tee**.

**Cause was the prompt, not the model.** The prompt read *"Substitute the current top with the garment in the reference image"* — an abstract pointer the model cannot ground on, so it invented a generic top.

Decart's own virtual try-on reference app (`DecartAI/tryon-examples`, `digital-mirror`) sends **no reference image at all**:

```js
initialState: { prompt: { text: prompt, enhance: false } }
```

Its garments are specified entirely by description:

> "Substitute the current top with a navy blue hoodie with a white cross logo on the chest and a kangaroo pocket"

The product images in that app exist for the storefront UI only.

**Three separate faults, found by reading `DecartAI/tryon-examples` properly:**

1. **Wrong API.** The garment went via `initialState.image` at connect. The documented path is `setImage(blob, { prompt, enhance })` *after* connect — used by every one of their seven examples.
2. **Wrong kind of reference image.** The Unsplash sample was *a person wearing a white tee*. Their guidance asks for the garment alone on a white background; a worn-garment photo is the case they warn against.
3. **Vague prompt.** No colour, material or fit for the model to hold on to.

My earlier claim that "Decart sends no reference image at all" came from reading only `digital-mirror` (their kiosk demo, which uses pre-written prompts). The repo README is explicit that the ideal setup is a clean garment image **paired with** a descriptive prompt.

**The fidelity question remains open** — run 1 measured three bugs of mine, not the model's ability.

## Run 2 — 10s cap, $0.20

| Measure | Result |
|---|---|
| **Time to first transformed frame** | **2,806 ms** |
| Billed | 10s ($0.20) |
| Ended by | Session cap (client timer fired at 0) |

**Average across both runs: 3,465 ms.** Run 1 was 4,124 ms, run 2 was 2,806 ms — a 1.3s spread on two samples, so the number is still soft. Both are well above the brief's 1–2s target and well below anything disqualifying.

## The prompt was never needed — settled by reading the shipped product

Decart's own Chrome extension, **Anywear v2.7**, was downloaded from the Chrome Web Store CDN and unpacked. It sends **an empty prompt**:

```js
function EU() { return null != YN ? YN : "" }      // YN is null unless a SERVER config sets it
await $U.setImage(n, { prompt: EU(), timeout: 3e4 });
```

`content.js`, `widget-core.js` and `background.js` contain zero prompt references; no "substitute the current…" string exists anywhere in the package; and the `DECART_AUTO_START` message that carries the garment has no prompt field.

**The image is the instruction.** The descriptive prompts in `tryon-examples` exist because those demos ship hand-written product catalogues. Anywear runs on arbitrary retailer pages, has no catalogue, and works from pixels alone.

Full teardown: [`docs/ANYWEAR-ARCHITECTURE.md`](docs/ANYWEAR-ARCHITECTURE.md).

## Implication for the extension (Phase 3)

This is the significant architectural finding so far.

**Superseded.** No description is needed. Anywear proves "grab the product image and stream it" is the whole mechanism.

What Phase 3 actually needs, from the Anywear teardown:

1. **A fashion-site gate** — allowlist, denylist, then platform signatures (Shopify/Demandware/WooCommerce/Magento) and commerce markers. Nothing injects elsewhere.
2. **Image candidates at ≥120×120** rendered size, via `querySelectorAll("img")` plus a `MutationObserver` for lazy-loaded and SPA content; URL from `currentSrc || src`.
3. **Hover-swap defence** — listing pages swap to a back view on hover, so the dragged element is often the wrong image.
4. **A background-worker image fetch** — `<all_urls>` host permission bypasses page CORS and returns a `data:` URL, which also avoids tainting the canvas. **No backend is needed for images at all.**
5. **An in-page iframe** with `allow="camera; microphone"`, not a detached window.

## Extension — first real runs

| Site | Result |
|---|---|
| **Pinterest** | ✅ Worked — the in-page `<img>` read plus service-worker fetch removes the hotlink/JS-shell problem entirely |
| **H&M** | ❌ `WebSocket closed: 1000` — garment payload was ~384KB of base64 (2333×3500 AVIF). Fixed by applying the 1024px/JPEG preprocessing the harness already used. |

Pinterest working is the meaningful result: it was the case that failed every time through the paste-a-URL harness, and it needed no site-specific handling once the extension read the image the browser had already loaded.

## Resolution — the cause of blurry, inaccurate garments

The extension was sending the model a **264×396 thumbnail**. `currentSrc` gives the browser's *display* choice, which on a listing grid is tiny; the pipeline then upscaled it to 1024.

| | Sent to model | On the wire |
|---|---|---|
| Before | 264×396 | 18 KB |
| After | **854×1280** (from a 2160×3238 source) | 84 KB |

Per-site, after adding ImageKit support and master-URL preference:

| Site | Was sending | Now sending |
|---|---|---|
| H&M | 264×396 | **2160×3238** source |
| Nykaa Fashion | 720×960 | **1500×2000** master |

Fixed by rewriting CDN resize parameters, reading zoom attributes and the widest `srcset` entry, and having the service worker decode each candidate to pick the genuinely largest. Quality also raised (cap 1280, JPEG 0.92).

**Still to confirm:** whether the garment is now accurate as well as sharp. Resolution was a necessary fix, not provably a sufficient one.

## Open questions

- Does a descriptive prompt actually fix fidelity? **Next run answers this.**
- Does attaching the reference image on top of a good description help, hurt, or do nothing? Worth one A/B.
- Is 4.1s representative, and how much is connection setup vs. model warm-up?
- Frame rate, resolution, and behaviour as the subject moves.
- How the four garment classes differ: solid tee vs. patterned dress vs. jacket vs. logo/text.

## Per-garment notes

| Garment | Description used | Result | Cost |
|---|---|---|---|
| White crew tee (Unsplash, **worn by a person**) | *"…the garment in the reference image"* (vague) | Black t-shirt, wrong — wrong API, wrong image type, vague prompt | $0.28 |
