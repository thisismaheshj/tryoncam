/**
 * Gathers every marketing and graphic asset into site/assets/brand/, the one
 * place they live publicly, and writes the manifest the dashboard's
 * Content → Assets page reads.
 *
 *   node scripts/build-brand-kit.mjs
 *
 * Re-run after rebuilding any of the sources (store/build-assets.mjs,
 * store/og/build.sh, store/x-header/build.sh), then deploy the site.
 *
 * Only what is listed below is published. Nothing is picked up by folder, so a
 * private file sitting next to the images can never end up in the kit.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const kit = path.join(site, 'assets/brand');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

rmSync(kit, { recursive: true, force: true });
mkdirSync(kit, { recursive: true });

// --- Assets made here ---------------------------------------------------------------

/** Logo lockups, rendered on a transparent page. */
const lockups = path.join(root, 'store/x-header/out');
mkdirSync(lockups, { recursive: true });
for (const theme of ['light', 'dark']) {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', '--window-size=1600,480', '--virtual-time-budget=4000',
    '--allow-file-access-from-files', `--screenshot=${path.join(lockups, `tryoncam-lockup-${theme}.png`)}`,
    `file://${path.join(root, 'store/x-header/lockup.html')}?theme=${theme}`,
  ], { stdio: 'ignore' });
}

/** Store copy without the submission notes around it (those mention the signing key). */
function storeCopy() {
  const listing = readFileSync(path.join(root, 'store/LISTING.md'), 'utf8');
  const after = (label) => listing.split(`**${label}**`)[1] ?? '';
  const firstParagraph = (text) => text.replace(/^[^\n]*\n/, '').trim().split(/\n\s*\n/)[0].trim();
  // The description runs until the next bold label (**Category:**), where the submission notes begin.
  const description = after('Description').split(/\n\*\*/)[0].split(/\n---/)[0].trim();
  return [
    `Name: ${firstParagraph(after('Name'))}`,
    `Summary: ${firstParagraph(after('Summary'))}`,
    '',
    description,
    '',
  ].join('\n');
}
mkdirSync(path.join(kit, 'copy'), { recursive: true });
writeFileSync(path.join(kit, 'copy/chrome-store-listing.txt'), storeCopy());

// --- What the kit contains ---------------------------------------------------------------

const B = 'brand/camface';
const X = 'store/x-header/out';
const S = 'store/out';

/**
 * [source, where it is published, title, what it is for].
 * A destination starting with "site:" is already public on tryoncam.com and is
 * linked where it is, not copied.
 */
const GROUPS = [
  {
    id: 'logo', title: 'Logo',
    note: 'The Camface mark. Use the full mark at 24px and up; the small version exists only for 16px.',
    items: [
      [`${B}/camface.svg`, 'logo/tryoncam-mark.svg', 'Mark · SVG', 'Anywhere the logo appears on its own. Scales to any size.'],
      [`${B}/camface-square.svg`, 'logo/tryoncam-mark-square.svg', 'Mark, square corners · SVG', 'Places that round the corners themselves (app stores, avatars).'],
      [`${B}/camface-glyph.svg`, 'logo/tryoncam-glyph.svg', 'Glyph · SVG', 'The face alone, without the blue tile.'],
      [`${B}/camface-small.svg`, 'logo/tryoncam-mark-small.svg', 'Mark, simplified · SVG', 'Only for 16px, where the full detail blurs.'],
      [`${X}/tryoncam-lockup-light.png`, 'logo/tryoncam-lockup-light.png', 'Lockup for light backgrounds', 'Mark and name together, transparent background.'],
      [`${X}/tryoncam-lockup-dark.png`, 'logo/tryoncam-lockup-dark.png', 'Lockup for dark backgrounds', 'Mark and name together, white text, transparent background.'],
      [`${B}/png/camface-1024.png`, 'logo/tryoncam-mark-1024.png', 'Mark · 1024 PNG', 'Profile pictures: X, Instagram, LinkedIn, YouTube.'],
      [`${B}/png/camface-512.png`, 'logo/tryoncam-mark-512.png', 'Mark · 512 PNG', ''],
      [`${B}/png/camface-256.png`, 'logo/tryoncam-mark-256.png', 'Mark · 256 PNG', ''],
      [`${B}/png/camface-glyph-1024.png`, 'logo/tryoncam-glyph-1024.png', 'Glyph · 1024 PNG', ''],
    ],
  },
  {
    id: 'social', title: 'Social',
    note: 'Headers keep the bottom-left clear for the profile photo. Link previews are chosen in Content → Website → Link preview.',
    items: [
      [`${X}/tryoncam-x-header-a.png`, 'social/tryoncam-x-header-a.png', 'X header A · light', 'X (Twitter) profile header, 1500×500.'],
      [`${X}/tryoncam-x-header-b.png`, 'social/tryoncam-x-header-b.png', 'X header B · dark', 'X (Twitter) profile header, 1500×500.'],
      [`${X}/tryoncam-x-header-c.png`, 'social/tryoncam-x-header-c.png', 'X header C · brand blue', 'X (Twitter) profile header, 1500×500.'],
      [`${X}/tryoncam-x-header-a@2x.jpg`, 'social/tryoncam-x-header-a@2x.jpg', 'X header A · 2x', 'Same design at 3000×1000, for LinkedIn banners or print.'],
      [`${X}/tryoncam-x-header-b@2x.jpg`, 'social/tryoncam-x-header-b@2x.jpg', 'X header B · 2x', ''],
      [`${X}/tryoncam-x-header-c@2x.jpg`, 'social/tryoncam-x-header-c@2x.jpg', 'X header C · 2x', ''],
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((v) => [`site/assets/og/og-${v}.jpg`, `site:assets/og/og-${v}.jpg`, `Link preview ${v.toUpperCase()}`, 'Shown when a tryoncam.com link is shared, 1200×630.']),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((v) => [`store/og/out/yt-${v}.jpg`, `social/tryoncam-youtube-thumb-${v}.jpg`, `YouTube thumbnail ${v.toUpperCase()}`, '1280×720.']),
      ['store/og/out/thumbnails-sheet.jpg', 'social/tryoncam-thumbnails-overview.jpg', 'All thumbnails, one sheet', 'An overview for picking one.'],
    ],
  },
  {
    id: 'store', title: 'Chrome Web Store',
    note: 'Upload these in the developer dashboard. Screenshot 2 still uses a studio photo: replace it with a real session frame before submitting.',
    items: [
      [`${S}/icon-128.png`, 'store/tryoncam-store-icon-128.png', 'Store icon', '128×128, the icon in search results.'],
      [`${S}/promo-small-440x280.png`, 'store/tryoncam-promo-small-440x280.png', 'Small promo tile', '440×280.'],
      [`${S}/promo-marquee-1400x560.png`, 'store/tryoncam-promo-marquee-1400x560.png', 'Marquee promo tile', '1400×560, used if Google features the listing.'],
      [`${S}/screenshot-1-try-on-any-store.png`, 'store/tryoncam-screenshot-1.png', 'Screenshot 1 · any store', '1280×800.'],
      [`${S}/screenshot-2-live-trial-room-REPLACE-PHOTO.png`, 'store/tryoncam-screenshot-2-replace-photo.png', 'Screenshot 2 · trial room', 'Replace the photo with a real session frame first.'],
      [`${S}/screenshot-3-sign-in-free.png`, 'store/tryoncam-screenshot-3.png', 'Screenshot 3 · sign in free', '1280×800.'],
      [`${S}/screenshot-4-credits.png`, 'store/tryoncam-screenshot-4.png', 'Screenshot 4 · credits', '1280×800. Prices are from the day it was built.'],
      [`${S}/screenshot-5-private.png`, 'store/tryoncam-screenshot-5.png', 'Screenshot 5 · private', '1280×800.'],
    ],
  },
  {
    id: 'icons', title: 'App & browser icons',
    note: 'Already wired into the site and the extension; here for anywhere else that asks.',
    items: [
      ['site/favicon.svg', 'site:favicon.svg', 'Favicon · SVG', 'Browser tab icon.'],
      ['site/favicon.ico', 'site:favicon.ico', 'Favicon · ICO', 'Older browsers.'],
      ['site/apple-touch-icon.png', 'site:apple-touch-icon.png', 'Apple touch icon', '180×180, iPhone home screen.'],
      ['site/icon-512.png', 'site:icon-512.png', 'App icon 512', 'PWA and app listings.'],
      ['site/icon-512-maskable.png', 'site:icon-512-maskable.png', 'App icon 512 · maskable', 'Android, which crops to its own shape.'],
      [`${B}/extension/icon128.png`, 'icons/extension-icon-128.png', 'Extension icon 128', ''],
      [`${B}/extension/icon48.png`, 'icons/extension-icon-48.png', 'Extension icon 48', ''],
      [`${B}/extension/icon16.png`, 'icons/extension-icon-16.png', 'Extension icon 16', ''],
    ],
  },
  {
    id: 'video', title: 'Video',
    note: 'Not in the zip (too large); download each on its own.',
    items: [
      ['site/assets/demo.mp4', 'site:assets/demo.mp4', 'Demo video', 'The one-minute walkthrough on the landing page.'],
      ['brag-output/brag.mp4', 'video/tryoncam-launch.mp4', 'Launch video', 'Short promo for social posts.'],
      ['brag-output/brag.jpg', 'video/tryoncam-launch-poster.jpg', 'Launch video poster', 'Cover image for the launch video.'],
    ],
  },
  {
    id: 'copy', title: 'Copy',
    note: 'Words that go with the pictures.',
    items: [
      ['site/assets/brand/copy/chrome-store-listing.txt', 'copy/chrome-store-listing.txt', 'Chrome Web Store listing', 'Name, summary and description, as submitted.'],
      ['brag-output/share-copy.txt', 'copy/share-post.txt', 'Launch post', 'One paragraph for sharing the launch video.'],
    ],
  },
];

const PALETTE = [
  { name: 'Accent blue', hex: '#3d5bf5', use: 'Buttons, links, the logo tile' },
  { name: 'Soft blue', hex: '#8ea2ff', use: 'Highlight text on dark' },
  { name: 'Ink', hex: '#0e0f12', use: 'Text, dark backgrounds' },
  { name: 'Paper', hex: '#f6f5f1', use: 'Light backgrounds' },
  { name: 'Live green', hex: '#22c55e', use: 'Live and success states' },
];
const FONTS = [
  { name: 'Bricolage Grotesque', use: 'Headlines, the wordmark (ExtraBold, tight tracking)', url: 'https://fonts.google.com/specimen/Bricolage+Grotesque' },
  { name: 'Geist', use: 'Body text and interface', url: 'https://fonts.google.com/specimen/Geist' },
  { name: 'Geist Mono', use: 'Small labels, in capitals', url: 'https://fonts.google.com/specimen/Geist+Mono' },
];

// --- Build ---------------------------------------------------------------------------------

function measure(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.svg') {
    const box = readFileSync(file, 'utf8').match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
    return box ? { width: Number(box[1]), height: Number(box[2]) } : {};
  }
  if (['.png', '.jpg', '.jpeg', '.ico'].includes(ext)) {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
    return { width: Number(out.match(/pixelWidth: (\d+)/)?.[1]), height: Number(out.match(/pixelHeight: (\d+)/)?.[1]) };
  }
  if (ext === '.mp4') {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]).toString();
    const probe = JSON.parse(out);
    return { width: probe.streams?.[0]?.width, height: probe.streams?.[0]?.height, seconds: Math.round(Number(probe.format?.duration)) };
  }
  return {};
}

const KIND = { '.svg': 'image', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.ico': 'image', '.mp4': 'video', '.txt': 'text' };
const zipList = [];
const groups = GROUPS.map((group) => ({
  id: group.id,
  title: group.title,
  note: group.note,
  items: group.items.map(([source, dest, title, use]) => {
    const from = path.join(root, source);
    if (!existsSync(from)) throw new Error(`Missing ${source}. Rebuild it before building the kit.`);
    let url;
    if (dest.startsWith('site:')) {
      url = dest.slice(5);
    } else {
      const to = path.join(kit, dest);
      mkdirSync(path.dirname(to), { recursive: true });
      if (path.resolve(from) !== path.resolve(to)) copyFileSync(from, to);
      url = `assets/brand/${dest}`;
    }
    const ext = path.extname(source).toLowerCase();
    const kind = KIND[ext] ?? 'file';
    if (kind !== 'video') zipList.push({ file: path.join(site, url), name: `${group.id}/${path.basename(url)}` });
    return { title, use, url, kind, format: ext.slice(1).toUpperCase(), bytes: statSync(from).size, ...measure(from) };
  }),
}));

// The whole kit in one download, videos aside.
const zipPath = path.join(kit, 'tryoncam-brand-kit.zip');
const staging = path.join(root, 'dist/brand-kit');
rmSync(staging, { recursive: true, force: true });
for (const entry of zipList) {
  const to = path.join(staging, 'tryoncam-brand-kit', entry.name);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(entry.file, to);
}
writeFileSync(path.join(staging, 'tryoncam-brand-kit/COLOURS-AND-FONTS.txt'),
  ['tryoncam brand', '', 'Colours', ...PALETTE.map((c) => `  ${c.hex}  ${c.name} — ${c.use}`), '', 'Fonts', ...FONTS.map((f) => `  ${f.name} — ${f.use} (${f.url})`), ''].join('\n'));
execFileSync('zip', ['-qr', zipPath, 'tryoncam-brand-kit'], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  base: 'https://tryoncam.com/',
  zip: { url: 'assets/brand/tryoncam-brand-kit.zip', bytes: statSync(zipPath).size, files: zipList.length },
  palette: PALETTE,
  fonts: FONTS,
  groups,
};
writeFileSync(path.join(kit, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const count = groups.reduce((n, g) => n + g.items.length, 0);
console.log(`Brand kit: ${count} assets in ${groups.length} groups, zip ${(manifest.zip.bytes / 1e6).toFixed(1)} MB → site/assets/brand/`);
