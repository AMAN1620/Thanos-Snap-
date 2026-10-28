// Copies the MediaPipe runtime out of node_modules and downloads the two models,
// so the unpacked extension folder is self-contained (extensions cannot load
// remote code).
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mp = join(root, 'node_modules/@mediapipe/tasks-vision');

const VENDOR = [
  ['vision_bundle.mjs', 'vision_bundle.mjs'],
  ['wasm/vision_wasm_internal.js', 'vision_wasm_internal.js'],
  ['wasm/vision_wasm_internal.wasm', 'vision_wasm_internal.wasm'],
];

const MODELS = [
  [
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    'hand_landmarker.task',
  ],
  [
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    'selfie_segmenter.tflite',
  ],
];

const exists = (p) => stat(p).then(() => true, () => false);

await mkdir(join(root, 'vendor'), { recursive: true });
await mkdir(join(root, 'models'), { recursive: true });

for (const [from, to] of VENDOR) {
  await copyFile(join(mp, from), join(root, 'vendor', to));
}
console.log('vendor/: MediaPipe runtime copied');

for (const [url, name] of MODELS) {
  const dest = join(root, 'models', name);
  if (await exists(dest)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`models/${name}: downloaded`);
}
