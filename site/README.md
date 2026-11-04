# tryoncam · marketing site

Static site, no build step. Four pages share one stylesheet and one script.

```
index.html      landing page
terms.html      Terms & Conditions
privacy.html    Privacy Policy
refunds.html    Refund Policy (no refunds)
assets/
  styles.css    all styling
  site.js       all motion (GSAP + ScrollTrigger + SplitText from jsDelivr)
  img/          garment photos, resized from the Blucash product shoots
```

Preview locally:

```bash
python3 -m http.server 5180 --directory site
```

## Things to set before going live

| What | Where |
|---|---|
| Chrome Web Store link | `CHROME_STORE_URL` at the top of `assets/site.js`. Every `data-install` button uses it. |
| Demo video | `#video` in `index.html`: set `data-youtube="VIDEO_ID"`, or drop a file at `assets/demo.mp4`. Until then the play button says "Video coming soon". |
| Prices and credit packs | Pricing section of `index.html` (`data-price` drives the count-up). |
| Governing law, business address | Yellow `.todo` placeholders in `terms.html` and `privacy.html`. |
| Support email | `support@tryoncam.com`, used across all four pages. |

The legal pages are a solid starting draft written against what the extension and backend actually do. Have a lawyer review them for your jurisdiction before launch.

## Brand kit

`assets/brand/` holds every marketing and graphic asset, a `manifest.json` the dashboard's
Content → Brand assets page reads, and `tryoncam-brand-kit.zip`. It is generated, never edited by hand:

```bash
node scripts/build-brand-kit.mjs
```

Only files listed in that script are published. Sources: `brand/camface/` (logo), `store/x-header/` (X headers,
logo lockups), `store/og/` (link previews, YouTube thumbnails), `store/out/` (Chrome Web Store), `brag-output/` (launch video).
