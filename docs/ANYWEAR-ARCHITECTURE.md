# How Anywear by Decart Actually Works

Read from the shipped extension itself — **Anywear: Live Virtual Try-On v2.7**, extension id `hijnklblgecbdlhjiofhlhjpndpifejh`, downloaded from Google's Chrome Web Store CDN and unpacked. Not from marketing pages.

The package ships **unminified internal engineering docs** in `docs/`, which state the design directly.

> Note on the name: the product is **Anywear** (wear), not "Anywhere".

## The finding that matters most

**Anywear sends the garment image with an empty prompt. There is no text description anywhere in the product.**

From `widget.bundle.js`:

```js
var wU = "lucy-vton-3.5",  XN = null,  YN = null;   // model, modelName, prompt

function rU(e) {                                     // applies SERVER session config
  typeof e.modelName === "string" && e.modelName && (XN = e.modelName),
  typeof e.prompt    === "string" && (YN = e.prompt),
  ...
}

function EU() { return null != YN ? YN : "" }        // → "" unless the server sets one

await $U.setImage(n, { prompt: EU(), timeout: 3e4 });
```

Corroborating evidence:

| Check | Result |
|---|---|
| `"prompt"` in `content.js`, `widget-core.js`, `background.js` | **0 occurrences** |
| `"prompt"` in `widget-init.js` | 7 — all `__decart_show_atc_prompt` (add-to-cart nudge) or `prompt-dismissed` (camera permission state) |
| `"substitute the current" / "replace the current top"` anywhere | **none** |
| `DECART_AUTO_START` message fields | `productImageUrl`, `pageUrl`, `tryonId`, `imageSource`, `suggestedFacingMode` — **no prompt** |

`YN` is only ever assigned from a **server-delivered session config**, so Decart can push a prompt remotely without shipping a new version. By default it is `""`.

**The image is the instruction.** The descriptive prompts in `DecartAI/tryon-examples` exist because those demos have hand-written product catalogues. The real product has no catalogue — it runs on arbitrary retailer pages — so it relies on the image alone.

They also pin the model to the canonical **`lucy-vton-3.5`**, not the `lucy-vton-latest` alias, with a server-side override.

## Architecture

```
content script (all_urls, document_idle)
  ├─ determineIfFashionWebsite()   gate — do nothing on non-fashion pages
  ├─ isProductPage()               JSON-LD schema.org Product/ProductGroup
  ├─ detectGarmentMeta()           category + gender  (filtering/analytics, NOT a prompt)
  └─ DecartWidget.init(...)        widget-core.js owns image resolution + UI

        │ picks garment pixels, postMessage
        ▼
  <iframe src="widget.html" allow="camera; microphone">    ← in-page, NOT a popup window
        │ DECART_AUTO_START { productImageUrl, pageUrl, tryonId, imageSource }
        ▼
  widget-init.js + widget.bundle.js (bundled Decart SDK)
        └─ setImage(image, { prompt: "" })  →  lucy-vton-3.5 over WebRTC/LiveKit

background.js (service worker)
  └─ DECART_FETCH_IMAGE   host_permissions bypass page CORS → returns data: URL
```

Manifest permissions are deliberately thin: `activeTab`, `storage`, `identity`, plus `host_permissions: <all_urls>`.

### The try-on UI is an in-page iframe, not a detached window

`widget.html` is listed in `web_accessible_resources` and injected as an iframe carrying `allow="camera; microphone"`. From `content.js`:

```js
const c = document.createElement("iframe");
c.src = WIDGET_URL;                    // chrome-extension://<id>/widget.html
c.allow = "camera; microphone";
c.addEventListener("load", () => {
  c.contentWindow.postMessage({ type: "DECART_AUTO_START", productImageUrl, pageUrl }, "*");
});
```

This **contradicts the Phase 0 recommendation in this repo** (Constraint 4: use `chrome.windows.create` or `sidePanel`). An iframe at the extension origin solves both problems at once: it is not a browser-action popup so it never dies on focus loss, and being at `chrome-extension://` origin it carries its own camera permission grant — the `allow` attribute is what delegates it.

A detached-window path still exists (`DECART_OPEN_WINDOW`, gated on `cameraGranted`) as a fallback, and `blocked-by-embedder` messaging covers pages whose permissions policy forbids camera in iframes.

## Choosing which pixels to send

From `docs/drag-flip-on-hover.md` — their own document, titled *"Choosing the garment reference image… Everything that decides which pixels we hand the model."*

### Candidate images

```js
if (t < 120 || n < 120) return false;   // offsetWidth / offsetHeight floor
```

`document.querySelectorAll("img")` plus a `MutationObserver` on `document.body` (`childList`, `subtree`) so lazy-loaded and SPA-routed images are picked up. URL comes from `currentSrc || src`, which resolves `srcset` correctly. Hover button is positioned at the image's top-left **+8px**.

### The hover-swap problem

Listing pages routinely swap to a back view on hover. Two failures follow: the dragged element is the *back* image, and Chrome's `:hover` freeze during drag leaves it stuck.

They handle two site patterns:

| Pattern | Sites | Mechanism |
|---|---|---|
| **A** — CSS two-`img` stack | Revolve, ASOS, most grids | Both images in DOM, opacity/visibility swap |
| **B** — JS `src` swap | ZARA, Net-a-Porter, Farfetch | One `<img>`, `.src` rewritten on hover (plus `<picture>` variants) |

There are dedicated per-site modules shipped for the awkward ones: `revolve.js`, `ugg.js`, and a `per_website_garment_filter.js` with its own documentation.

### Sending both views as one image

When a card yields a clean front/back pair they **stitch them into a single reference** — front left, back right, common height capped at **1024px** — and send that instead of the front alone.

The gating is deliberately strict:

- **Listing page:** only when the card holds **exactly two** images ≥80px. Three or more is usually a colourway strip, and compositing a different colourway *"would actively poison the reference."*
- **Product page:** the discriminator is **rendered size** — another image whose box matches the hero within **2px per side** is another view of the same garment. Rendered size, not visible area, because visible area changes as the page scrolls.

Every failure path — CORS refusal, decode error, tainted canvas — *"degrades to the front image alone. There is no path where compositing makes a try-on worse."*

### Getting the bytes across CORS

A cross-origin retailer image can be drawn to a canvas but not read back — `toBlob()` throws `SecurityError` on a tainted canvas. Their solution:

| Context | Mechanism |
|---|---|
| Extension | `DECART_FETCH_IMAGE` → background worker; `<all_urls>` host permission bypasses page CORS and returns a non-tainting `data:` URL |
| Plain web install | in-page `fetch`, works only when the CDN sends `Access-Control-Allow-Origin` |

The composite is emitted as `toDataURL('image/jpeg')` and passed through the same `DECART_AUTO_START` field. The SDK's `imageToBase64` checks for a `data:` URL first, so *"the pixels never leave the browser — no upload, no bucket, no cross-origin POST."*

`set_image` always carries base64 on the wire regardless; a URL is just one of the things the SDK knows how to turn into base64.

## Where it runs at all

`determineIfFashionWebsite()` gates everything, in order:

1. **Allowlist** — Zara, Zalando, Instagram, Amazon, Vinted, Poshmark, Musinsa, Aerie, About You, the whole Inditex family…
2. **Denylist** — search, news, tech, sports, social, travel, home goods, health, IMDb. Nothing injects there.
3. **Platform signatures** — `cdn.shopify.com`, `myshopify.com`, `demandware.net`, `woocommerce`, `Magento_Ui`, `cdn.bigcommerce.com`
4. **Commerce markers** — `add to bag/basket`, size guide/chart, colour swatch, wishlist
5. **Text signals** — apparel words in title/meta, or **two or more** of *dresses, jeans, jackets, sweaters, hoodies, skirts, blouses, trousers, sneakers, sandals, knitwear, swimwear* in body text

`detectGarmentMeta()` then extracts **category** (top/bottom/dress/outerwear/shoes/bag/eyewear/jewelry/lingerie/swimwear/activewear/accessory) and **gender** from JSON-LD, breadcrumbs, URL path and titles. This feeds filtering and analytics — it is **not** turned into a prompt.

## What this changes for us

| Our current build | Anywear | Action |
|---|---|---|
| Requires a hand-written 20–30 word description | **Empty prompt, image only** | Drop the description requirement |
| `lucy-vton-latest` | `lucy-vton-3.5` pinned, server-overridable | Pin the canonical version |
| Backend proxy fetches garments | Background worker + `<all_urls>` → `data:` URL | Keep the proxy for the localhost harness; the extension needs no backend for images |
| Phase 0 recommended a detached window | In-page iframe with `allow="camera; microphone"` | Change the Phase 4 plan |
| Single image | Front+back composite when confidently paired | Later refinement, clearly worth it |
| Any page | Fashion-site gate first | Adopt — it is also what keeps the extension quiet |

The single most consequential line: **the garment description was never needed.** Our first run produced a black t-shirt because of the wrong API (`initialState.image` rather than `setImage`), the wrong kind of reference (a person wearing a tee), and a vague prompt — not because a description was missing.

## Sources

Everything above is from the shipped package: `manifest.json`, `content.js`, `widget-core.js`, `widget-init.js`, `widget.bundle.js`, `background.js`, and the bundled `docs/drag-flip-on-hover.md`, `docs/per-website-garment-filters.md`, `docs/moderation-reset-attempt.md`. Read only — nothing was executed.
