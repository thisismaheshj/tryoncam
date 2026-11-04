/**
 * Garment image preparation, ported from Decart's own `tryon-examples`
 * (`lib/image-utils.ts`).
 *
 * Two details matter and are easy to miss:
 *
 * 1. The image is drawn onto a **white** canvas first. Product PNGs are
 *    routinely transparent, and transparency reaching the model shows up as
 *    black. White is also what Decart recommends as the reference background.
 * 2. The canvas is read back as JPEG and capped at 1024px. Their guidance is
 *    "at least 512x512"; beyond 1024 only costs bytes on the wire.
 *
 * The canvas must not be tainted, so the source has to be same-origin — which
 * is what routing every garment through /api/garment gives us for free.
 */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode that image.'));
    img.src = src;
  });
}

/** Fetches a URL and returns it flattened onto white as a JPEG blob. */
export async function urlToImageBlob(url) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 512;
  canvas.height = img.naturalHeight || 512;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return toBlob(canvas, 0.94);
}

/**
 * Caps the longest edge at `maxSize`, leaving smaller images untouched.
 *
 * It never upscales. A small source stays small — inventing pixels only
 * costs bandwidth and makes a blurry reference look deceptively large.
 */
export async function resizeImageBlob(blob, maxSize = 1280) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w <= maxSize && h <= maxSize) return blob;

    const scale = maxSize / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    // Downscaling a 2000px product shot with the default sampler leaves it
    // soft; the model reproduces what it is given, so quality here is not
    // cosmetic.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return toBlob(canvas, 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** URL -> white-backed, size-capped JPEG, ready for setImage(). */
export async function prepareGarment(url, maxSize = 1280) {
  return resizeImageBlob(await urlToImageBlob(url), maxSize);
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the garment image.'))),
      'image/jpeg',
      quality,
    );
  });
}
