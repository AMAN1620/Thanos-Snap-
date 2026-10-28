// The disintegration effect. The frame is divided into a grid of small cells.
// Each cell gets a release time from a noise field, so the body crumbles in
// patches. When a cell holding part of the person is released, it becomes a
// particle carrying that cell's colour, which drifts away on the wind, turns to
// ash and fades. Particle paths are a closed-form function of age, so the
// return effect is the same animation played backwards: the dust flies in and
// each cell reappears as its particle lands.

const SPREAD = 2.2; // seconds over which the whole body crumbles
const LIFE_MIN = 1.4;
const LIFE_MAX = 2.4;
export const EFFECT_SECONDS = SPREAD + LIFE_MAX;

const ASH = [74, 64, 56];

export class Dust {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.step = Math.max(3, Math.round(width / 256));
    this.gw = Math.ceil(width / this.step);
    this.gh = Math.ceil(height / this.step);
    const n = this.gw * this.gh;

    this.delay = new Float32Array(n);
    this.released = new Uint8Array(n);

    // One particle per cell at most.
    this.count = 0;
    this.cell = new Int32Array(n);
    this.birth = new Float32Array(n);
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.ax = new Float32Array(n);
    this.ay = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.rgb = new Uint8Array(n * 3);

    // Released cells, one pixel per cell; scaled up to erase the body.
    this.releasedCanvas = new OffscreenCanvas(this.gw, this.gh);
    this.releasedCtx = this.releasedCanvas.getContext('2d');
    this.releasedImage = new ImageData(this.gw, this.gh);
    this.releasedPx = new Uint32Array(this.releasedImage.data.buffer);

    this.particleCanvas = new OffscreenCanvas(width, height);
    this.particleCtx = this.particleCanvas.getContext('2d');
    this.particleImage = new ImageData(width, height);
    this.particlePx = new Uint32Array(this.particleImage.data.buffer);
  }

  // cells: { rgba, mask } sampled at grid resolution (one pixel per cell);
  // mask is the person alpha 0..255.
  start(reverse, cells) {
    this.reverse = reverse;
    this.count = 0;
    this.released.fill(0);
    makeDelays(this.delay, this.gw, this.gh);
    if (reverse) {
      // Returning: every cell of the person flies in, aimed at where they are now.
      for (let i = 0; i < this.delay.length; i++) if (cells.mask[i] >= 128) this.spawn(i, cells);
    }
  }

  // t: seconds since the effect started. Updates releasedCanvas and particleCanvas.
  update(t, cells) {
    const tau = this.reverse ? EFFECT_SECONDS - t : t;
    const { delay, released, releasedPx } = this;
    for (let i = 0; i < delay.length; i++) {
      const isReleased = delay[i] <= tau;
      if (!this.reverse && isReleased && !released[i] && cells.mask[i] >= 128) this.spawn(i, cells);
      released[i] = isReleased ? 1 : 0;
      releasedPx[i] = isReleased ? 0xff000000 : 0;
    }
    this.releasedCtx.putImageData(this.releasedImage, 0, 0);
    this.drawParticles(tau);
  }

  spawn(i, cells) {
    const k = this.count++;
    const s = this.width / 1280; // speeds are tuned for 720p
    this.cell[k] = i;
    this.birth[k] = this.delay[i];
    this.life[k] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    this.vx[k] = (25 + Math.random() * 70) * s;
    this.vy[k] = -(10 + Math.random() * 40) * s;
    this.ax[k] = (50 + Math.random() * 110) * s;
    this.ay[k] = -(15 + Math.random() * 50) * s;
    this.phase[k] = Math.random() * Math.PI * 2;
    this.rgb[k * 3] = cells.rgba[i * 4];
    this.rgb[k * 3 + 1] = cells.rgba[i * 4 + 1];
    this.rgb[k * 3 + 2] = cells.rgba[i * 4 + 2];
  }

  drawParticles(tau) {
    const { width, height, step, gw, particlePx: px } = this;
    const s = width / 1280;
    px.fill(0);
    for (let k = 0; k < this.count; k++) {
      const age = tau - this.birth[k];
      const life = this.life[k];
      if (age < 0 || age >= life) continue;
      const f = age / life;
      const cell = this.cell[k];
      const ph = this.phase[k];
      const x =
        (cell % gw) * step +
        this.vx[k] * age +
        0.5 * this.ax[k] * age * age +
        Math.sin(ph + age * 3.1) * 16 * s * age;
      const y =
        Math.floor(cell / gw) * step +
        this.vy[k] * age +
        0.5 * this.ay[k] * age * age +
        Math.cos(ph * 1.7 + age * 2.3) * 12 * s * age;

      // Fresh particles exactly cover their cell, so the crumbling edge is seamless.
      const size = Math.max(1, Math.round(step * (1 - 0.65 * f)));
      const alpha = Math.round(255 * Math.pow(1 - f, 1.3));
      const ash = Math.min(1, f * 1.6) * 0.85;
      const r = this.rgb[k * 3] * (1 - ash) + ASH[0] * ash;
      const g = this.rgb[k * 3 + 1] * (1 - ash) + ASH[1] * ash;
      const b = this.rgb[k * 3 + 2] * (1 - ash) + ASH[2] * ash;
      const color = ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;

      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x) + size);
      const y1 = Math.min(height, Math.round(y) + size);
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) px[row + xx] = color;
      }
    }
    this.particleCtx.putImageData(this.particleImage, 0, 0);
  }
}

// Release times in [0, SPREAD]: mostly a noise field (patches go together),
// a slight top-to-bottom drift, and per-cell jitter so edges look granular.
function makeDelays(out, gw, gh) {
  const seed = (Math.random() * 1e6) | 0;
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const u = (x / gh) * 3;
      const v = (y / gh) * 3;
      const n =
        0.55 * valueNoise(u, v, seed) +
        0.3 * valueNoise(u * 2.1, v * 2.1, seed + 1) +
        0.15 * valueNoise(u * 4.3, v * 4.3, seed + 2);
      const d = 0.75 * n + 0.15 * (y / gh) + 0.1 * Math.random();
      out[y * gw + x] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  const scale = SPREAD / (max - min || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) * scale;
}

function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
