// Records demo.html to out/tryoncam-demo.mp4, one deterministic frame at a time.
// Usage: node --experimental-websocket render.mjs [fps] [scale]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const FPS = Number(process.argv[2] ?? 30);
const SCALE = Number(process.argv[3] ?? 1.5); // 1280x720 layout -> 1920x1080 video
const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'demo-chrome-'));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); }
}
const ws = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
// Every call times out, so a stalled browser fails the render instead of hanging it.
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method}: no answer in 20s`)); }, 20000);
  pending.set(n, (d) => { clearTimeout(timer); d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result); });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: SCALE, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: 'file://' + path.join(here, 'demo.html') + '?capture' });
for (let i = 0; i < 100 && !(await evaluate('!!window.ready').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
await evaluate('window.ready');
const total = await evaluate('window.TOTAL');
const frames = Math.round(total * FPS);

const outFile = path.join(here, 'out', 'tryoncam-demo.mp4');
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });

for (let f = 0; f < frames; f++) {
  await evaluate(`window.render(${f / FPS}); 1`); // captureScreenshot draws a fresh frame itself
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } });
  if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
  if (f % 90 === 0) console.log(`frame ${f}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
ws.close();
chrome.kill();
await new Promise((r) => chrome.on('exit', r));
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the OS cleans its temp folder */ }
console.log('wrote', outFile);
