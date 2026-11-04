# tryoncam — Chrome Web Store submission

Everything the developer dashboard asks for, in the order it asks. Images are in `store/out/`; rebuild them with `node store/build-assets.mjs`. The upload is `dist/tryoncam-1.0.0-first-upload.zip`; rebuild with `npm run package:ext`.

---

## Package

**Upload:** `dist/tryoncam-1.0.0-first-upload.zip` (version 1.0.0)

It contains `key.pem`, which tells the store to keep the extension ID `aadnmnhilcphhjnchilngaeandeldngc`. Use it for the **first upload only**. For later versions run `npm run package:ext -- update` (no key file).

After the item is created, check the ID shown in the dashboard. If it is anything other than `aadnmnhilcphhjnchilngaeandeldngc`, three things must be updated before launch: the Google OAuth redirect URI, `EXTENSION_ID` on Vercel, and the install link in `site/assets/site.js`.

---

## Store listing tab

**Name** (from the manifest, 36 chars)
tryoncam: Virtual Try-On for Clothes

**Summary** (from the manifest, 114 of 132 chars)
See clothes on you before you buy. Click Try On on a product photo and watch it on you, live, through your camera.

**Description**

See clothes on you before you buy them.

tryoncam adds a Try On button to product photos on online clothing stores. Click it, and a trial room opens beside the page with the garment on you — live, through your camera. Move, turn, and see how it sits. Click Try On on another product to swap garments without starting over.

HOW IT WORKS
• Browse any online clothing store as you normally would
• A Try On button appears on product photos
• Click it and allow your camera
• Watch the garment on you, live, and swap to other products in the same session

WHAT YOU GET
• 3 free try-ons when you sign in with Google — no card needed
• Works across the clothing stores you already shop
• Unlimited garment swaps within a session
• Credits never expire; top up from your account when you need more

PRIVATE BY DEFAULT
• Your camera turns on only when you start a try-on, and off when it ends
• Video is processed in real time and never recorded or stored by us
• tryoncam never uses your microphone
• Sign in with Google — no password to create

Works best with tops, dresses, jackets and trousers. Jewellery, shoes and bags are not supported yet.

Questions? support@tryoncam.com

**Category:** Shopping
**Language:** English

**Graphic assets**
| Field | File |
|---|---|
| Store icon (128×128) | `store/out/icon-128.png` |
| Screenshot 1 | `store/out/screenshot-1-try-on-any-store.png` |
| Screenshot 2 | `store/out/screenshot-2-live-trial-room-REPLACE-PHOTO.png` — **replace the photo first, see below** |
| Screenshot 3 | `store/out/screenshot-3-sign-in-free.png` |
| Screenshot 4 | `store/out/screenshot-4-credits.png` |
| Screenshot 5 | `store/out/screenshot-5-private.png` |
| Small promo tile (440×280) | `store/out/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/out/promo-marquee-1400x560.png` — **same photo caveat** |

Screenshot 2 and the marquee show a studio photo of a model where the live try-on appears. Store policy requires screenshots to show what the extension actually does; a studio photo presented as its output can be treated as misleading. Before submitting, take a screenshot of the trial room during one of your own sessions, save the live frame as `site/assets/img/live-frame.jpg`, and replace `m-coral.jpg` with it in `store/build-assets.mjs` (two places), then rebuild.

**Official URL:** https://tryoncam.com (verify the domain in Google Search Console to link it)
**Homepage URL:** https://tryoncam.com
**Support URL:** mailto:support@tryoncam.com — or https://tryoncam.com if the dashboard requires a web address

---

## Privacy tab

**Single purpose**
tryoncam lets shoppers see clothing from online stores on themselves, live through their camera, before they buy it.

**Permission justifications**

*storage*
Stores the signed-in session, the user's panel position and size, and the last copy of the service's settings so the extension works through brief network loss.

*identity*
Used for "Sign in with Google" (chrome.identity.launchWebAuthFlow). An account holds the user's try-on credits and purchases.

*Host permissions (all URLs)*
The extension finds product photos on the clothing store the user is browsing and places a Try On button on them. When the user clicks Try On, the extension fetches that product image, which is hosted on the store's own image servers, so it needs access to arbitrary sites. Page analysis happens locally; nothing about a page is sent anywhere until the user starts a try-on.

*Remote code*
No, I am not using remote code. All JavaScript, including the video SDK, is bundled in the package.

**Data usage — collected**
- ☑ Personally identifiable information — name, email address and profile picture, from Google sign-in
- ☑ Financial and payment information — purchase records (pack, amount, date, payment reference). Card details are handled by Stripe and never reach us.
- ☑ Website content — the address of the product image the user chooses to try on, and that image itself

**Data usage — not collected**
Health information, authentication information (passwords, PINs), personal communications, location, web history, user activity.

**Certifications** (tick all three)
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://tryoncam.com/privacy.html

---

## Distribution tab

**Visibility:** Public (or Unlisted for a soft launch — anyone with the link can install, it is not searchable)
**Regions:** All regions, unless you want to launch in specific markets first
**Pricing:** Free (credits are sold outside the store, through Stripe — allowed, since the Web Store no longer handles payments)

---

## Test instructions (for the reviewer)

1. Installing the extension opens its welcome page, https://tryoncam.com/demo.html?installed=1: a one-minute demo video and a sample shop. (Or use any online clothing store, e.g. https://www.myntra.com/men-tshirts.)
2. A black "Try On" button appears on product photos. Click one.
3. Sign in with any Google account when asked. New accounts receive 3 free try-on credits.
4. Allow camera access. The trial room shows the garment on you, live, for about 15 seconds.
5. While it is live, click Try On on another product to swap garments in the same session.
6. The toolbar button opens a menu with "Go to your account", where credits and purchases are shown.

No test account is needed: sign-in works with any Google account and includes free credits.
