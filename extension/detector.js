/**
 * Garment discovery, following the heuristics read out of Anywear v2.7.
 * See docs/ANYWEAR-ARCHITECTURE.md for where each rule comes from.
 */
globalThis.TryOnDetect = (() => {
  /** Anywear's floor: anything smaller is an icon, badge or swatch. */
  const MIN_SIZE = 120;

  const FASHION_HOSTS = [
    'zara.com', 'zalando.com', 'zalando.co.uk', 'zalando.de', 'asos.com', 'hm.com',
    'uniqlo.com', 'gap.com', 'nordstrom.com', 'revolve.com', 'shein.com', 'aritzia.com',
    'gymshark.com', 'lululemon.com', 'net-a-porter.com', 'farfetch.com', 'ssense.com',
    'bershka.com', 'stradivarius.com', 'pullandbear.com', 'massimodutti.com', 'oysho.com',
    'aboutyou.com', 'poshmark.com', 'vinted.com', 'aerie.com', 'musinsa.com',
    'urbanoutfitters.com', 'abercrombie.com', 'mango.com', 'boohoo.com', 'prettylittlething.com',
    'pinterest.com', 'instagram.com',
  ];

  /** Pages that are never shopping, however many clothing words they contain. */
  const NEVER = [
    'google.', 'bing.', 'duckduckgo.', 'yahoo.', 'youtube.', 'reddit.', 'wikipedia.',
    'stackoverflow.', 'github.', 'medium.com', 'cnn.com', 'bbc.', 'theguardian.',
    'nytimes.', 'reuters.', 'bloomberg.', 'techcrunch.', 'theverge.', 'wired.',
    'espn.com', 'imdb.', 'booking.com', 'airbnb.', 'tripadvisor.', 'ikea.com',
    'homedepot.', 'lowes.', 'bestbuy.', 'yelp.', 'webmd.', 'mayoclinic.',
  ];

  function isFashionPage() {
    const host = location.hostname.toLowerCase();
    if (NEVER.some((n) => host.includes(n))) return false;
    if (FASHION_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;

    const html = document.documentElement.innerHTML;
    // Commerce platform signatures.
    if (/cdn\.shopify\.com|myshopify\.com|demandware\.net|woocommerce|Magento_Ui|cdn\.bigcommerce\.com/i.test(html)) {
      return true;
    }
    // Commerce UI markers.
    if (/add[_\-\s]?to[_\-\s]?(bag|basket|cart)/i.test(html)) return true;
    if (/size[_\-]?(guide|chart|selector)|color[_\-]?swatch/i.test(html)) return true;

    // Two or more apparel words in the visible text.
    const text = (document.body?.innerText ?? '').toLowerCase();
    const words = ['dresses', 'jeans', 'jackets', 'sweaters', 'hoodies', 'skirts',
      'blouses', 'trousers', 'sneakers', 'knitwear', 'swimwear', 'outerwear'];
    return words.filter((w) => text.includes(w)).length >= 2;
  }

  /** Lazy-load attributes, in the order they are worth trusting. */
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'data-image', 'data-zoom-image'];

  /**
   * currentSrc resolves srcset, but lazy-loaders routinely leave a 1x1
   * transparent GIF there while the element is already laid out at full size
   * (H&M does exactly this). A tiny data: URL is a placeholder, never a
   * garment, so fall through to whichever data-* attribute holds the real URL.
   */
  /**
   * Product photos drawn as CSS backgrounds rather than <img>. Myntra's product
   * pages do this (div.image-grid-image), and the extension, which only ever
   * looked at <img>, found nothing there to put a pill on.
   */
  function backgroundUrl(el) {
    const inline = el.style?.backgroundImage;
    const value = inline && inline !== 'none' ? inline : getComputedStyle(el).backgroundImage;
    const match = value && value.match(/url\(["']?([^"')]+)["']?\)/);
    return match ? match[1] : null;
  }

  function imageUrl(img) {
    if (img.tagName !== 'IMG') {
      const url = backgroundUrl(img);
      if (!url || isPlaceholder(url)) return null;
      try {
        return new URL(url, location.href).href;
      } catch {
        return null;
      }
    }
    const ordered = [];
    const live = img.currentSrc || img.src || '';
    if (live && !isPlaceholder(live)) ordered.push(live);
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      // data-srcset holds a candidate list; take the first URL.
      const first = attr.endsWith('srcset') ? value.split(',')[0]?.trim().split(/\s+/)[0] : value;
      if (first && !isPlaceholder(first)) ordered.push(first);
    }
    if (live && ordered.length === 0 && !isPlaceholder(live)) ordered.push(live);

    for (const candidate of ordered) {
      if (candidate.startsWith('data:')) return candidate;
      try {
        return new URL(candidate, location.href).href;
      } catch {
        // Try the next one.
      }
    }
    return null;
  }

  /**
   * Rewrites a CDN's resize parameters to ask for the largest variant.
   *
   * Retail CDNs serve the same asset at any width via a query parameter or a
   * path segment. `currentSrc` is whatever the browser picked for *display* —
   * on a listing page that is routinely a 128px thumbnail — so asking the CDN
   * for the full-size render is the difference between a sharp garment and an
   * upscaled smudge.
   */
  /**
   * Removes a CDN's resize instruction so the origin serves its master.
   *
   * This is preferred over asking for a huge width, because some CDNs happily
   * *upscale*: Nykaa's ImageKit returns 3000x4000 for `tr=w-3000` from a
   * 1500x2000 master. Bigger is not sharper when the extra pixels are invented.
   */
  function stripResizeParams(url) {
    if (!url || url.startsWith('data:')) return url;
    try {
      const parsed = new URL(url, location.href);
      for (const key of ['tr', 'imwidth', 'imheight', 'width', 'height', 'w', 'h',
                         'sw', 'sh', 'wid', 'hei', 'size', 'maxwidth', 'max-width',
                         'resize', 'fit', 'dpr', 'quality', 'q']) {
        parsed.searchParams.delete(key);
      }
      let out = parsed.toString();
      // Path-segment resizers.
      out = out.replace(/\/(?:tr|c_[^/]*),?w_\d+[^/]*\//gi, '/');
      out = out.replace(/_(?:\d{2,4})x(?:\d{2,4})?(\.(?:jpe?g|png|webp))/i, '$1');
      out = out.replace(/_(?:small|medium|large|compact|grande)(\.(?:jpe?g|png|webp))/i, '$1');
      return out;
    } catch {
      return url;
    }
  }

  function upgradeResolution(url, target = 2048) {
    if (!url || url.startsWith('data:')) return url;
    let out = url;

    // Query-parameter resizers: imwidth (H&M), width (Uniqlo), w, sw (SFCC),
    // wid/hei (Scene7), size, $n$ presets.
    out = out.replace(/([?&](?:imwidth|width|w|sw|wid|maxwidth|max-width)=)(\d+)/gi, (m, key, value) =>
      Number(value) < target ? key + target : m,
    );
    // Height params would otherwise pin the short edge and undo the upgrade.
    out = out.replace(/([?&](?:imheight|height|h|sh|hei)=)(\d+)/gi, (m, key, value) =>
      Number(value) < target ? key + target : m,
    );
    // ImageKit transformation syntax, as used by Nykaa: ?tr=w-720 or tr=w-720,h-960
    out = out.replace(/((?:[?&]tr=|,)w-)(\d+)/gi, (m, key, value) => (Number(value) < target ? key + target : m));
    out = out.replace(/(,h-)(\d+)/gi, (m, key, value) => (Number(value) < target ? key + target : m));
    // Cloudinary / imgix style path segments: /w_600/ or /c_fill,w_600/
    out = out.replace(/([/,]w_)(\d+)/gi, (m, key, value) => (Number(value) < target ? key + target : m));
    // Shopify: name_600x.jpg, name_600x800.jpg, name_small.jpg
    out = out.replace(/_(\d{2,4})x(\d{2,4})?(\.(?:jpe?g|png|webp))/i, `_${target}x$3`);
    out = out.replace(/_(?:small|medium|large|compact|grande)(\.(?:jpe?g|png|webp))/i, `_${target}x$1`);

    return out;
  }

  /**
   * Every URL worth trying for this image, best first.
   *
   * The caller fetches them in order and keeps the one that decodes largest,
   * because a CDN may ignore an upgraded parameter and silently return the
   * original — guessing is not enough, it has to be measured.
   */
  function sourceCandidates(img) {
    if (img.tagName !== 'IMG') {
      // A background has no srcset to read; try the master and an upgraded width.
      const url = imageUrl(img);
      return url ? [...new Set([stripResizeParams(url), upgradeResolution(url), url])] : [];
    }
    const out = [];
    const push = (url) => {
      if (!url || isPlaceholder(url)) return;
      try {
        const absolute = url.startsWith('data:') ? url : new URL(url, location.href).href;
        if (!out.includes(absolute)) out.push(absolute);
      } catch {
        // Skip unparseable.
      }
    };

    // 1. Explicit high-resolution attributes. Product pages expose the zoom
    //    asset for their lightbox, and it is the best source on the page.
    for (const attr of ['data-zoom-image', 'data-large_image', 'data-image-large', 'data-hires',
                        'data-old-hires', 'data-large', 'data-full-image', 'data-master']) {
      const value = img.getAttribute(attr);
      push(stripResizeParams(value));
      push(value);
    }

    // 2. srcset, largest first. Descriptors come in two flavours — `1024w`
    //    and `2x` — and Nykaa uses the density form, which a width-only
    //    parser scores as zero and effectively ignores.
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    const parsed = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/))
      .filter((bits) => bits[0])
      .map(([url, descriptor = '']) => {
        const match = descriptor.match(/^(\d+(?:\.\d+)?)([wx])$/);
        if (!match) return { url, rank: 0 };
        // Density descriptors are ranked below widths but above nothing.
        return { url, rank: match[2] === 'w' ? Number(match[1]) : Number(match[1]) * 1000 };
      })
      .sort((a, b) => b.rank - a.rank);

    // 3. The master, then upgraded variants, then what was displayed.
    const live = img.currentSrc || img.src || '';
    if (parsed[0]) push(stripResizeParams(parsed[0].url));
    push(stripResizeParams(live));
    if (parsed[0]) push(upgradeResolution(parsed[0].url));
    push(upgradeResolution(live));
    for (const { url } of parsed) push(url);
    push(live);

    // 4. Lazy-load attributes.
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      const first = attr.endsWith('srcset') ? value.split(',')[0]?.trim().split(/\s+/)[0] : value;
      push(upgradeResolution(first));
      push(first);
    }

    return out;
  }

  /** A 1x1 spacer or an inline SVG shim, not a product photo. */
  function isPlaceholder(url) {
    if (!url) return true;
    if (!url.startsWith('data:')) return false;
    // Real inline garments would be far larger than a spacer GIF/SVG.
    return url.length < 512;
  }

  /**
   * A background-image element that is a product photo, not decoration.
   * Stricter than an <img>: backgrounds are used for textures, hero strips and
   * section art, so it must be photo-sized and hold no photo of its own.
   */
  const BG_MIN_SIZE = 200;
  function isBackgroundCandidate(el) {
    if (el.closest('[data-tryon-ui]')) return false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < BG_MIN_SIZE || h < BG_MIN_SIZE) return false;
    const ratio = w / h;
    if (ratio > 2.5 || ratio < 0.4) return false;
    // A card that also holds a real <img> is served by that image instead.
    if ([...el.querySelectorAll('img')].some((img) => img.offsetWidth >= MIN_SIZE)) return false;
    return Boolean(imageUrl(el));
  }

  function isCandidate(img) {
    if (!img) return false;
    if (img.tagName !== 'IMG') return img.nodeType === 1 && isBackgroundCandidate(img);
    if (img.closest('[data-tryon-ui]')) return false; // never our own chrome

    const w = img.offsetWidth;
    const h = img.offsetHeight;
    if (w < MIN_SIZE || h < MIN_SIZE) return false;

    // Banners and hero strips are rarely a single garment.
    const ratio = w / h;
    if (ratio > 3 || ratio < 0.25) return false;

    // Intrinsic size catches the lazy-load case that rendered size cannot: a
    // 1x1 spacer stretched to 337x505 passes every layout check.
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth < MIN_SIZE) {
      // Only reject if there is no better URL parked on a data-* attribute.
      const url = imageUrl(img);
      if (!url || isPlaceholder(url)) return false;
    }

    return Boolean(imageUrl(img));
  }

  /**
   * What the torso try-on can actually render, and what it cannot.
   *
   * Lucy VTON replaces clothing on a torso. Handed a bracelet it does not
   * decline — it finds the nearest thing it can dress and puts the object
   * there, which is how a bracelet ends up worn as sunglasses.
   *
   * Anywear's answer is not to prompt the object into place; it is to not
   * offer Try-On at all. Their UGG filter blocks that retailer's entire core
   * catalogue on exactly this ground, and their Revolve filter allows
   * "dresses and tops yes; jeans, shoes, bags no".
   */
  const DEFAULT_WEARABLE = ['top', 'bottom', 'dress', 'outerwear', 'activewear', 'swimwear', 'lingerie', 'headwear'];

  /**
   * Which categories are offered a Try-On.
   *
   * `bottom` is included. It was originally excluded on the strength of
   * Anywear's Revolve filter — "dresses and tops yes; jeans, shoes, bags no" —
   * but that is one retailer's policy about its own catalogue, not a statement
   * that the model cannot render trousers. Generalising it blocked an entire
   * store whose products are shorts.
   *
   * Shoes, bags, eyewear, jewellery and accessories stay out: those are not
   * near a torso at all, and the model puts them somewhere it can (a bracelet
   * rendered as sunglasses).
   *
   * Operator-configurable, because the right answer is per catalogue.
   */
  let WEARABLE = new Set(DEFAULT_WEARABLE);

  /**
   * 'all': every product image on a shopping page gets a Try-On, whatever it
   * sells — what the operator asked for, so a jewellery store is not left
   * with one pill on the single necklace whose name the word list missed.
   * 'garments': only the categories above. The model dresses a torso, so this
   * is the mode for a catalogue where accessories render badly.
   */
  let MODE = 'garments';

  function setDiscoveryMode(mode) {
    const next = mode === 'garments' ? 'garments' : 'all';
    const changed = next !== MODE;
    MODE = next;
    return changed;
  }

  function setWearableCategories(list) {
    const next = Array.isArray(list) && list.length ? list : DEFAULT_WEARABLE;
    const changed = next.length !== WEARABLE.size || next.some((c) => !WEARABLE.has(c));
    WEARABLE = new Set(next);
    return changed;
  }

  const CATEGORY_PATTERNS = [
    // Things shops sell that nobody wears. Checked first, so "Lighter Case" is
    // a lighter, not an unknown product that happens to have a price.
    ['object', /\b(lighters?|lighter\s+cases?|flasks?|money\s+clips?|mugs?|tumblers?|bottles?|candles?|keychains?|key\s*rings?|phone\s+cases?|stickers?|posters?|perfumes?|fragrances?|colognes?|gift\s*cards?|cushions?|pillows?|books?|notebooks?|stationery|ashtrays?|incense|diffusers?)\b/i],
    // Worn on the head rather than the torso; offered by default because
    // shoppers expect it, and it can be unticked per catalogue.
    ['headwear', /\b(caps?(?![\s-]*sleeve)|hats?|beanies?|bucket\s+hats?|berets?|visors?|snapbacks?|fedoras?|headwear)\b/i],
    ['shoes', /\b(shoes?|boots?|sneakers?|sandals?|heels?|pumps?|loafers?|mules?|slippers?|trainers?|flats?|slides?|espadrilles?)\b/i],
    ['bag', /\b(bags?|purses?|handbags?|totes?|backpacks?|clutch(?:es)?|satchels?|crossbody|wallets?|pouches?)\b/i],
    ['eyewear', /\b(sunglasses?|eyeglasses?|eyewear|optical\s*frames?|spectacles?)\b/i],
    ['jewelry', /\b(necklaces?|earrings?|bracelets?|bangles?|rings?|anklets?|pendants?|pearls?|jewel(?:ry|lery)|jewell?ery|chains?|charms?|cufflinks?)\b/i],
    // "Accessories" itself too: an unnamed product under an ACCESSORIES heading
    // is far more likely a lighter than a shirt.
    ['accessory', /\b(accessor(?:y|ies)|belts?|scarves?|scarf|gloves?|watch(?:es)?|headbands?|bandanas?|ties?(?![\s-]*dye)|socks?)\b/i],
    ['swimwear', /\b(bikinis?|swimsuits?|swimwear|bathing\s+suits?|tankini|swim\s*trunks?)\b/i],
    ['outerwear', /\b(jackets?|coats?|blazers?|puffers?|parkas?|trenches?|windbreakers?|anoraks?|overcoats?|gilets?)\b/i],
    ['activewear', /\b(sports?\s+bras?|activewear|athletic\s+wear|yoga\s+(?:pants?|wear)|gymwear|sportswear)\b/i],
    ['lingerie', /\b(bras?|bralettes?|lingerie|corset|camisoles?)\b/i],
    ['dress', /\b(dress(?:es)?|gown|sundress|bodycon|rompers?|jumpsuits?|playsuits?|kurtas?|sarees?|lehengas?|abayas?)\b/i],
    ['top', /\b(shirts?|blouses?|t[-\s]?shirts?|tees?|tank\s+tops?|sweaters?|hoodies?|sweatshirts?|polos?|tunics?|knitwear|cardigans?|tops?|kurtis?)\b/i],
    ['bottom', /\b(jeans?|pants?|trousers?|shorts?|skirts?|leggings?|chinos?|joggers?|sweatpants?|bottoms?|salwars?|palazzos?)\b/i],
  ];

  /**
   * Regions and names that are never a product being sold.
   *
   * A storefront photo, a payment-methods strip and a brand logo all pass
   * every size and aspect check — they are large, well-proportioned images.
   * What separates them from a garment tile is *where they sit* and *what they
   * are called*, not how they look.
   */
  const CHROME_REGIONS = 'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"]';
  const NOT_A_PRODUCT =
    /\b(logo|brand|banner|hero|slider|carousel-banner|payment|visa|mastercard|paypal|badge|icon|sprite|avatar|profile|flag|map|storefront|store-?front|showroom|lookbook-hero|newsletter|footer|header|nav|social|instagram-feed|trust|guarantee|shipping|review-?photo)\b/i;

  /**
   * Sites where the image IS the content, not a tile in a catalogue.
   *
   * Pinterest and Instagram have no product URL, no price and no schema.org
   * Product — by design. Requiring commerce-shaped evidence there blocks
   * everything, which is exactly what happened to a board full of t-shirts.
   *
   * These are on the allowlist already, so the page has cleared the fashion
   * gate before any of this runs. A commerce site detected by platform
   * signature still has to show real evidence, which is what keeps a
   * storefront photo off a Shopify page.
   */
  const CURATION_HOSTS = ['pinterest.com', 'pinterest.co.uk', 'pinterest.ca', 'pin.it',
    'instagram.com', 'tumblr.com', 'we-heart-it.com', 'weheartit.com'];

  function isCurationFeed() {
    const host = location.hostname.toLowerCase();
    return CURATION_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  }

  /** A link that points at something buyable. */
  const PRODUCT_HREF = new RegExp(
    [
      // /product/…, /p/…, /dp/…, /collections/x/products/…
      String.raw`\/(?:product|products|p|pd|prod|dp|item|items|buy|shop\/[^/]+|collections\/[^/]+\/products)(?:\/|$|[?#])`,
      // Myntra and similar: …/29993984/buy
      String.raw`\/buy(?:$|[?#])`,
      // -p-12345, /p12345, …/1234567.html, …/1234567/
      String.raw`[/-]p-?\d{5,}`,
      String.raw`\/\d{6,}(?:\/|$|[?#]|\.html)`,
    ].join('|'),
    'i',
  );
  const PRICE_NEARBY = /(?:[$£€₹¥]|\bRs\.?|\bINR\b|\bUSD\b|\bGBP\b|\bEUR\b)\s?\d/;

  /**
   * Positive evidence that this image is a product on sale.
   *
   * Requiring evidence rather than merely lacking disqualifying words is the
   * important part: a photograph of a shop has no garment words in its alt
   * text, so a "no bad words found" rule admits it. A product tile, by
   * contrast, is nearly always wrapped in a link to its own page or sitting
   * beside a price.
   */
  function hasProductContext(img) {
    // On a curation feed the picture is the point; there is nothing else to
    // corroborate it with.
    if (isCurationFeed()) return true;

    const link = img.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') ?? '';
      if (PRODUCT_HREF.test(href)) return true;
    }

    // A price in the immediate card is the other reliable tell.
    const card = img.closest('[class*="product" i], [class*="card" i], [class*="tile" i], li, article');
    if (card && PRICE_NEARBY.test((card.textContent ?? '').slice(0, 300))) return true;

    // On a product page the hero often is not itself a link; schema.org says
    // the page sells one thing, so a large image on it is very likely it.
    if (isProductPage() && img.offsetWidth >= 200) return true;

    return false;
  }

  /** schema.org Product/ProductGroup in JSON-LD — the PDP signal Anywear uses. */
  let productPageCache = null;
  function isProductPage() {
    if (productPageCache !== null) return productPageCache;
    productPageCache = false;
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(node.textContent ?? '');
        const items = data['@graph'] ?? (Array.isArray(data) ? data : [data]);
        for (const item of items) {
          const types = [].concat(item?.['@type'] ?? []);
          if (types.includes('Product') || types.includes('ProductGroup')) {
            productPageCache = true;
            return true;
          }
        }
      } catch {
        // Malformed JSON-LD is common; ignore it.
      }
    }
    return productPageCache;
  }

  /** Header, footer, nav — and anything named like site furniture. */
  function isPageFurniture(img) {
    if (img.closest(CHROME_REGIONS)) return true;
    // "Men Brand Logo Printed T-shirt" is a product, not a logo. An image
    // whose own description names something sold is never site furniture.
    const alt = `${img.getAttribute('alt') ?? ''} ${img.getAttribute('title') ?? ''}`;
    if (CATEGORY_PATTERNS.some(([, pattern]) => pattern.test(alt))) return false;
    const described = [
      img.getAttribute('alt') ?? '',
      img.getAttribute('class') ?? '',
      img.getAttribute('id') ?? '',
      img.closest('[class]')?.getAttribute('class') ?? '',
      (img.currentSrc || img.src || '').split('?')[0],
    ].join(' ');
    return NOT_A_PRODUCT.test(described);
  }

  /**
   * Best guess at what a given image is selling.
   *
   * Reads nearest-first: the image's own alt text and its card's link, then
   * the page's JSON-LD, breadcrumbs, title and URL. On a listing page the
   * per-image signals are what distinguish one tile from its neighbours.
   */
  function categoryOf(img, { ownOnly = false } = {}) {
    const sources = [];
    if (img) {
      sources.push(img.getAttribute('alt') || '');
      sources.push(img.getAttribute('title') || '');
      const link = img.closest('a');
      if (link) {
        sources.push(link.getAttribute('href') || '');
        sources.push((link.textContent || '').slice(0, 200));
      }
      const card = img.closest('[class*="product" i], [class*="card" i], li, article');
      if (card) sources.push((card.textContent || '').slice(0, 200));
    }
    // Page-level hints (heading, title, URL) say what the page is about, not
    // what this one image shows; `ownOnly` callers need the image's own words.
    if (!ownOnly) {
      sources.push(document.querySelector('h1')?.textContent || '');
      sources.push(document.querySelector('meta[property="og:title"]')?.content || '');
      sources.push(document.title || '');
      // The query string too: on a search page it is the clearest statement of
      // what the user is looking at, and `/search/pins/?q=oversized t-shirt`
      // says "t-shirt" nowhere in its path.
      sources.push(decodeURIComponent(location.pathname + location.search).replace(/[_\-/?&=+]/g, ' '));
    }

    for (const text of sources) {
      if (!text) continue;
      for (const [category, pattern] of CATEGORY_PATTERNS) {
        if (pattern.test(text)) return category;
      }
    }
    return null;
  }

  /**
   * Unknown means allowed.
   *
   * Anywear fails *closed* only inside a per-retailer filter, where the
   * catalogue is known; globally they show the button on any product image.
   * Refusing everything we cannot classify would make the extension silently
   * dead on most of the web.
   */
  function isWearable(img) {
    if (isPageFurniture(img)) return { ok: false, category: 'furniture' };

    // Pinterest and similar feeds: no prices or product links, and the search
    // query ("streetwear tshirt") would vouch for every pin. So a pin is judged
    // by its own words only: one that names something unwearable (a book, a
    // mug, jewellery in clothing mode) is skipped; anything else keeps its pill.
    // Requiring every pin to name a garment was tried and left most clothing
    // pins bare — their descriptions rarely name the garment.
    if (isCurationFeed()) {
      const own = categoryOf(img, { ownOnly: true });
      const skip = own !== null && (own === 'object' || (MODE === 'garments' && !WEARABLE.has(own)));
      return skip ? { ok: false, category: own, reason: 'pin names something unwearable' } : { ok: true, category: own };
    }

    const category = categoryOf(img);

    // Any product: a recognised product word or commerce evidence is enough.
    // Product evidence is still required for the unrecognised — that is what
    // keeps pills off shop photographs and banners.
    if (MODE === 'all') {
      return category !== null || hasProductContext(img)
        ? { ok: true, category }
        : { ok: false, category: null, reason: 'no product context' };
    }

    // A recognised non-wearable is out regardless of context.
    if (category !== null && !WEARABLE.has(category)) return { ok: false, category };

    // Unknown is only admitted with positive product evidence. Treating
    // "unknown" as "probably fine" is what put a Try-On pill on a photograph
    // of a shop.
    if (category === null && !hasProductContext(img)) {
      return { ok: false, category: null, reason: 'no product context' };
    }
    return { ok: true, category };
  }

  /**
   * Resolves a hovered image back to the garment's FRONT view.
   *
   * Listing cards commonly hold two images and cross-fade to the back view on
   * hover — which is precisely when the user reaches for the Try-On button, so
   * the image under the cursor is the wrong one. A back view can differ enough
   * to change what the model produces (a collar appearing on a collarless
   * kurta, for instance).
   *
   * Anywear's rule, which this follows: act only when the card holds EXACTLY
   * two images. Three or more is usually a colourway strip or an angle
   * carousel, where the siblings may be a different garment entirely, so
   * guessing would be worse than leaving it alone.
   */
  function frontOf(img) {
    // Background photos have no hover-swap sibling to resolve.
    if (img.tagName !== 'IMG') return img;
    let node = img.parentElement;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth += 1) {
      const found = [...node.querySelectorAll('img')].filter(isCandidate);
      if (found.length === 2) {
        // Document order: the front view is authored first and sits underneath.
        return found[0];
      }
      if (found.length > 2) return img; // ambiguous — leave it alone
      node = node.parentElement;
    }
    return img;
  }

  /**
   * Watches for candidates, including lazy-loaded and SPA-routed ones, exactly
   * as Anywear does with a MutationObserver on the body.
   */
  /**
   * Calls `onCandidate` for every image that could carry a pill, as it appears.
   *
   * Three things made pills silently miss products on modern shops:
   *  - an image accepted or rejected once was never looked at again, so a
   *    tile whose price rendered a moment after its image stayed bare;
   *  - lazy loading changes `src` on an existing element, which a childList
   *    observer never sees;
   *  - an image counts only once it has a size, which arrives on `load`.
   * Now a rejected image is retried (at most every 1.5s), attribute changes
   * and every image load trigger a scan, and scans are batched per frame.
   * `onCandidate` returns true once it has placed a pill.
   */
  function observe(onCandidate) {
    const done = new WeakSet();
    const lastTry = new WeakMap();
    const scan = () => {
      const now = Date.now();
      // Background-image photos are found by their inline style: checking the
      // computed style of every element on a page would be far too slow.
      for (const img of document.querySelectorAll('img, [style*="background-image"], [style*="background:"]')) {
        if (done.has(img)) continue;
        if (now - (lastTry.get(img) ?? 0) < 1500) continue;
        lastTry.set(img, now);
        if (!isCandidate(img)) continue;
        if (onCandidate(img)) done.add(img);
      }
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        scan();
      }, 250);
    };
    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src', 'class', 'style'],
    });
    document.addEventListener('load', (event) => {
      if (event.target instanceof HTMLImageElement) schedule();
    }, true);
    // A rejected image may qualify once its card finishes rendering; a slow
    // heartbeat catches what no event announces.
    const heartbeat = setInterval(schedule, 2000);
    return () => {
      observer.disconnect();
      clearInterval(heartbeat);
    };
  }

  return { MIN_SIZE, isFashionPage, isCandidate, imageUrl, isPlaceholder, upgradeResolution, stripResizeParams, sourceCandidates, frontOf, categoryOf, isWearable, hasProductContext, isPageFurniture, isProductPage,
    setWearableCategories, setDiscoveryMode, DEFAULT_WEARABLE, isCurationFeed, observe };
})();
