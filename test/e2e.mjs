// End-to-end smoke test: loads the extension into Chrome, feeds a photo as the
// fake webcam to a stand-in Meet page on localhost, snaps (keyboard shortcut),
// and saves frames of the outgoing video to test/out/ for a look.
//
//   npm run test:e2e
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test/out');
const PHOTO_URL = 'https://storage.googleapis.com/mediapipe-assets/pose.jpg';
const W = 1280;
const H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The extension only runs on meet.google.com; a copy also matches localhost.
async function extensionCopy() {
  const dir = join(tmpdir(), 'thanos-snap-e2e-ext');
  await rm(dir, { recursive: true, force: true });
  for (const part of ['manifest.json', 'src', 'vendor', 'models']) {
    await cp(join(root, part), join(dir, part), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push('http://localhost/*');
  manifest.web_accessible_resources[0].matches.push('http://localhost/*');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// Chrome's fake camera plays a .y4m file; convert the photo with Chrome itself.
async function makeY4m(browser, imagePath, y4mPath) {
  const page = await browser.newPage();
  const b64 = (await readFile(imagePath)).toString('base64');
  const yuv = await page.evaluate(
    async (b64, W, H) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext('2d');
      const scale = Math.max(W / img.width, H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      const px = ctx.getImageData(0, 0, W, H).data;
      const out = new Uint8Array((W * H * 3) / 2);
      const u0 = W * H;
      const v0 = u0 + (W * H) / 4;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
          out[y * W + x] = 0.299 * r + 0.587 * g + 0.114 * b;
          if (x % 2 === 0 && y % 2 === 0) {
            const j = (y / 2) * (W / 2) + x / 2;
            out[u0 + j] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
            out[v0 + j] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          }
        }
      }
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(s);
    },
    b64,
    W,
    H,
  );
  await page.close();
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.from(yuv, 'base64')]);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  await writeFile(y4mPath, Buffer.concat([header, ...Array(30).fill(frame)]));
}

function serve() {
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(await readFile(join(root, 'test/page.html')));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const fixtures = join(root, 'test/fixtures');
  const photo = join(fixtures, 'pose.jpg');
  const y4m = join(fixtures, 'pose.y4m');
  await mkdir(fixtures, { recursive: true });
  try {
    await readFile(photo);
  } catch {
    // A stock photo from MediaPipe's own test assets.
    const res = await fetch(PHOTO_URL);
    if (!res.ok) throw new Error(`${PHOTO_URL}: HTTP ${res.status}`);
    await writeFile(photo, Buffer.from(await res.arrayBuffer()));
  }

  console.log('converting the photo to a fake camera feed…');
  const converter = await puppeteer.launch({ headless: true });
  await makeY4m(converter, photo, y4m);
  await converter.close();

  console.log('launching Chrome with the extension…');
  const ext = await extensionCopy();
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [ext],
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
      '--autoplay-policy=no-user-gesture-required',
      // Headless Chrome on macOS hangs opening even the fake mic without this.
      '--audio-service-sandbox-type=none',
    ],
  });
  const server = await serve();
  const failures = [];
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${server.address().port}/`);

    const info = await Promise.race([
      page.evaluate(() => window.ready),
      sleep(15000).then(() => {
        throw new Error(`getUserMedia did not resolve. Console:\n  ${logs.join('\n  ')}`);
      }),
    ]);
    console.log('track seen by the page:', JSON.stringify(info));

    const hud = () =>
      page.evaluate(
        () => document.querySelector('thanos-snap-hud')?.shadowRoot.querySelector('.panel').innerText ?? null,
      );
    const chip = () =>
      page.evaluate(() => document.querySelector('thanos-snap-hud').shadowRoot.querySelector('.chip').textContent);
    let status = null;
    for (let i = 0; i < 120; i++) {
      status = await hud();
      if (status && /ready|failed/.test(status)) break;
      await sleep(500);
    }
    console.log('panel:', status);
    if (!status?.includes('ready')) failures.push('models did not load');

    await sleep(3000); // let the room plate fill in
    const save = async (name) => {
      const png = await page.evaluate(() => window.grab());
      await writeFile(join(outDir, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
    };
    await save('0-before');

    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    const t0 = Date.now();
    for (const ms of [300, 900, 1600, 2400, 3300]) {
      await sleep(ms - (Date.now() - t0));
      await save(`1-dust-${ms}ms`);
    }
    await sleep(5500 - (Date.now() - t0));
    await save('2-gone');
    console.log('panel after snap:', await hud());
    if ((await chip()) !== 'gone') failures.push('state did not reach "gone"');

    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    const t1 = Date.now();
    for (const ms of [1500, 3000]) {
      await sleep(ms - (Date.now() - t1));
      await save(`3-return-${ms}ms`);
    }
    await sleep(5500 - (Date.now() - t1));
    await save('4-back');
    console.log('panel after second snap:', await hud());
    if ((await chip()) !== 'visible') failures.push('state did not return to "visible"');

    const problems = logs.filter((l) => /error|thanos/i.test(l));
    if (problems.length) console.log('console:\n  ' + problems.join('\n  '));
    if (logs.some((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))) {
      failures.push('errors in the console');
    }
  } finally {
    server.close();
    await browser.close();
  }
  console.log(`frames saved to ${outDir}`);
  if (failures.length) {
    console.error('FAILED: ' + failures.join('; '));
    process.exit(1);
  }
  console.log('PASSED');
}

await main();
