/**
 * Tutorial player. A YouTube id, or an https link to a video file, arrives in
 * the hash from the dashboard's settings. The menu hides the tutorial entry when none is set, so the
 * fallback below is only ever seen if a video is removed while this is open.
 *
 * This lives in its own file because extension pages may not run inline
 * scripts (MV3 content security policy): as an inline <script> it never ran.
 */
const videoId = decodeURIComponent(location.hash.slice(1) || '').trim();
const isFile = (() => {
  try {
    const url = new URL(videoId);
    return url.protocol === 'https:' && /\.(mp4|webm|mov)$/i.test(url.pathname);
  } catch {
    return false;
  }
})();
if (isFile) {
  const video = document.createElement('video');
  video.src = videoId;
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = 'auto';
  document.body.appendChild(video);
} else if (/^[\w-]{6,20}$/.test(videoId)) {
  // YouTube refuses to play inside a chrome-extension:// page (player error
  // 153: it needs a website as the embedder). tryoncam.com/watch.html hosts
  // the player, so YouTube sees a normal website.
  const frame = document.createElement('iframe');
  frame.src = `https://tryoncam.com/watch.html?v=${encodeURIComponent(videoId)}`;
  frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  document.body.appendChild(frame);
} else {
  const box = document.createElement('div');
  box.className = 'placeholder';
  box.innerHTML = '<b>The tutorial is coming soon</b><div>Hover any product photo on a clothing site and click Try On.</div>';
  document.body.appendChild(box);
}
