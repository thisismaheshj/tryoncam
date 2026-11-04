/** Parsing the video links operators paste into the dashboard. No imports, so anything can use it. */

/**
 * Accepts a bare YouTube id, any of the YouTube URL shapes people actually
 * paste, or an https link straight to a video file.
 */
export function extractVideoId(input: string): string {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (isVideoFileUrl(value)) return value;
  if (/^[\w-]{6,20}$/.test(value)) return value;
  const patterns = [
    /[?&]v=([\w-]{6,20})/,
    /youtu\.be\/([\w-]{6,20})/,
    /youtube\.com\/embed\/([\w-]{6,20})/,
    /youtube\.com\/shorts\/([\w-]{6,20})/,
    /youtube\.com\/live\/([\w-]{6,20})/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

/** An https link to a video file the browser can play itself. */
export function isVideoFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /\.(mp4|webm|mov)$/i.test(url.pathname);
  } catch {
    return false;
  }
}
