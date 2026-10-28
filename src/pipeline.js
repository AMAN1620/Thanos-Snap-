// One camera track in, one processed track out. Frames are pulled with
// MediaStreamTrackProcessor and pushed with MediaStreamTrackGenerator, so the
// loop is driven by the camera and keeps running while the Meet tab is in the
// background (requestAnimationFrame would stall and freeze your video).

import { Dust } from './dust.js';
import { Plate, fillHoles } from './plate.js';

const MASK_W = 256; // segmentation runs on a frame this wide
// The segmenter is unsure at your edges (and on some clothing), and a
// half-erased edge leaves a visible outline, so the body mask is the confident
// core grown by a margin. The room is learned from outside a wider margin.
const BODY_CONF = 0.1;
const BODY_GROW = 4; // mask pixels
const ROOM_GROW = 8;
const LEARN_EVERY = 3; // frames between room-plate updates
// The camera re-exposes as you enter and leave the frame, so the plate is
// matched to the live room around you, in cells of this many mask pixels.
const MATCH_CELL = 8;

export class Pipeline {
  constructor(controller, track) {
    this.ctl = controller;
    this.processor = new MediaStreamTrackProcessor({ track });
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.output = this.generator;
    this.size = null;
    this.frames = 0;
    this.fps = 0;
    this.effectId = 0;
    this.loggedError = false;
    this.run();
  }

  async run() {
    const reader = this.processor.readable.getReader();
    const writer = this.generator.writable.getWriter();
    let fpsFrames = 0;
    let fpsSince = performance.now();
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        let out = frame;
        try {
          out = this.process(frame);
        } catch (err) {
          if (!this.loggedError) console.error('[thanos-snap] frame failed', err);
          this.loggedError = true;
          this.ctl.error = String(err?.message ?? err);
        }
        if (out !== frame) frame.close();
        // Rejects once Meet stops the track.
        await writer.write(out);

        fpsFrames += 1;
        const now = performance.now();
        if (now - fpsSince >= 1000) {
          this.fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
          fpsFrames = 0;
          fpsSince = now;
        }
      }
    } catch {
      // The output track was stopped.
    } finally {
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      this.ctl.pipelineEnded(this);
    }
  }

  resize(width, height) {
    const canvas = (w, h, opts) => {
      const c = new OffscreenCanvas(w, h);
      return [c, c.getContext('2d', opts)];
    };
    this.size = { width, height };
    this.mw = MASK_W;
    this.mh = Math.round((MASK_W * height) / width);
    const n = this.mw * this.mh;

    [this.small, this.smallCtx] = canvas(this.mw, this.mh);
    [this.cam, this.camCtx] = canvas(width, height);
    [this.keep, this.keepCtx] = canvas(width, height);
    [this.erase, this.eraseCtx] = canvas(width, height);
    [this.layer, this.layerCtx] = canvas(width, height);
    [this.out, this.outCtx] = canvas(width, height);

    this.conf = new Float32Array(n);
    this.smooth = new Float32Array(n);
    this.core = new Uint8Array(n);
    this.body = new Uint8Array(n);
    this.wide = new Uint8Array(n);
    // You: white, alpha 255 inside the body mask (soft edges come from upscaling).
    [this.bodyMask, this.bodyMaskCtx] = canvas(this.mw, this.mh);
    this.bodyImage = new ImageData(this.mw, this.mh);
    this.bodyImage.data.fill(255);
    // Room: alpha 255 wherever it is safely not you.
    [this.keepMask, this.keepMaskCtx] = canvas(this.mw, this.mh);
    this.keepImage = new ImageData(this.mw, this.mh);
    this.keepImage.data.fill(255);
    this.hasMask = false;

    // Exposure matching: the live frame and the plate side by side at mask
    // size, a gain per cell and channel, and the gains as two layers (multiply
    // can only darken and color-dodge can only brighten).
    [this.plateSmall, this.plateSmallCtx] = canvas(this.mw, this.mh);
    [this.match, this.matchCtx] = canvas(2 * this.mw, this.mh, { willReadFrequently: true });
    this.cw = Math.ceil(this.mw / MATCH_CELL);
    this.ch = Math.ceil(this.mh / MATCH_CELL);
    this.sums = new Float32Array(this.cw * this.ch * 7);
    this.gain = new Float32Array(this.cw * this.ch * 4);
    [this.darken, this.darkenCtx] = canvas(this.cw, this.ch);
    [this.brighten, this.brightenCtx] = canvas(this.cw, this.ch);
    this.darkenImage = new ImageData(this.cw, this.ch);
    this.brightenImage = new ImageData(this.cw, this.ch);

    this.plate = new Plate(width, height);
    this.dust = new Dust(width, height);
    [this.grid, this.gridCtx] = canvas(this.dust.gw, this.dust.gh, { willReadFrequently: true });
    this.cellMask = new Uint8Array(this.dust.gw * this.dust.gh);
    this.effectId = 0;
  }

  // Returns the frame to send: the input itself when nothing needs drawing.
  process(frame) {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (this.size?.width !== width || this.size?.height !== height) this.resize(width, height);
    this.frames += 1;

    const ctl = this.ctl;
    const vision = ctl.vision;
    if (!vision || ctl.active !== this) return frame;

    const now = performance.now();
    const ts = vision.timestamp();
    this.smallCtx.drawImage(frame, 0, 0, this.mw, this.mh);
    ctl.detector.onHands(vision.detectHands(frame, ts), width / height, now);
    vision.segment(this.small, ts, this.conf);
    this.updateMasks();

    const { state, t, effectId } = ctl.phase(now);
    const capturing = ctl.capturing(now);
    const learn = capturing || this.frames % LEARN_EVERY === 0;
    if (state === 'visible' && !learn) return frame;

    this.camCtx.drawImage(frame, 0, 0);
    this.cutOutPerson();
    // Capturing only learns faster: anyone still in the frame stays cut out,
    // or they would be baked into the empty room.
    if (learn) this.plate.learn(this.keep, capturing ? 0.3 : 0.15, capturing);
    if (state === 'visible') return frame;

    this.compose(state, t, effectId);
    return new VideoFrame(this.out, { timestamp: frame.timestamp });
  }

  updateMasks() {
    const { conf, smooth, core, body, wide, mw, mh } = this;
    for (let i = 0; i < conf.length; i++) {
      smooth[i] = smooth[i] * 0.4 + conf[i] * 0.6;
      core[i] = smooth[i] > BODY_CONF ? 1 : 0;
    }
    dilate(core, body, mw, mh, BODY_GROW);
    dilate(core, wide, mw, mh, ROOM_GROW);
    const b = this.bodyImage.data;
    const k = this.keepImage.data;
    for (let i = 0; i < body.length; i++) {
      b[i * 4 + 3] = body[i] ? 255 : 0;
      k[i * 4 + 3] = wide[i] ? 0 : 255;
    }
    this.bodyMaskCtx.putImageData(this.bodyImage, 0, 0);
    this.keepMaskCtx.putImageData(this.keepImage, 0, 0);
    this.hasMask = true;
  }

  // keep = camera frame with you (plus a margin) cut out.
  cutOutPerson() {
    const { width, height } = this.size;
    const k = this.keepCtx;
    k.globalCompositeOperation = 'copy';
    k.drawImage(this.cam, 0, 0);
    k.globalCompositeOperation = 'destination-in';
    k.drawImage(this.keepMask, 0, 0, width, height);
    k.globalCompositeOperation = 'source-over';
  }

  compose(state, t, effectId) {
    const { width, height } = this.size;
    const o = this.outCtx;
    // The room: the learned plate behind, at the live exposure, and the live
    // room on top.
    o.drawImage(this.plate.filled(), 0, 0);
    if (this.matchExposure()) {
      const w = this.cw * MATCH_CELL * (width / this.mw);
      const h = this.ch * MATCH_CELL * (height / this.mh);
      o.globalCompositeOperation = 'multiply';
      o.drawImage(this.darken, 0, 0, w, h);
      o.globalCompositeOperation = 'color-dodge';
      o.drawImage(this.brighten, 0, 0, w, h);
      o.globalCompositeOperation = 'source-over';
    }
    o.drawImage(this.keep, 0, 0);
    if (state === 'gone') return;

    const cells = this.sampleCells();
    if (this.effectId !== effectId) {
      this.effectId = effectId;
      this.dust.start(state === 'returning', cells);
    }
    this.dust.update(t, cells);

    // erase = you, limited to the cells already turned to dust.
    const e = this.eraseCtx;
    e.globalCompositeOperation = 'copy';
    e.imageSmoothingEnabled = true;
    e.drawImage(this.bodyMask, 0, 0, width, height);
    e.globalCompositeOperation = 'destination-in';
    e.imageSmoothingEnabled = false;
    e.drawImage(this.dust.releasedCanvas, 0, 0, width, height);

    const l = this.layerCtx;
    l.globalCompositeOperation = 'copy';
    l.drawImage(this.cam, 0, 0);
    l.globalCompositeOperation = 'destination-out';
    l.drawImage(this.erase, 0, 0);

    o.drawImage(this.layer, 0, 0);
    o.drawImage(this.dust.particleCanvas, 0, 0);
  }

  // Sets the darken and brighten layers to the gain that takes the plate to
  // the live exposure: per cell, live room over plate where the room is in
  // view, and filled in from the cells around where you cover it. Returns
  // false if no room is in view to compare.
  matchExposure() {
    const { mw, mh, cw, ch, sums, gain, wide } = this;
    this.plateSmallCtx.drawImage(this.plate.canvas, 0, 0, mw, mh);
    const m = this.matchCtx;
    m.drawImage(this.small, 0, 0);
    m.drawImage(this.plateSmall, mw, 0);
    const px = m.getImageData(0, 0, 2 * mw, mh).data;

    sums.fill(0); // per cell: live r, g, b, plate r, g, b, pixel count
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const live = (y * 2 * mw + x) * 4;
        const plate = live + mw * 4;
        if (wide[y * mw + x] || px[plate + 3] < 240) continue;
        const s = (((y / MATCH_CELL) | 0) * cw + ((x / MATCH_CELL) | 0)) * 7;
        for (let c = 0; c < 3; c++) {
          sums[s + c] += px[live + c];
          sums[s + 3 + c] += px[plate + c];
        }
        sums[s + 6] += 1;
      }
    }

    let known = 0;
    for (let k = 0; k < cw * ch; k++) {
      const n = sums[k * 7 + 6];
      const ok = n >= (MATCH_CELL * MATCH_CELL) / 2;
      for (let c = 0; c < 3; c++) gain[k * 4 + c] = ok ? (sums[k * 7 + c] + n) / (sums[k * 7 + 3 + c] + n) : 0;
      gain[k * 4 + 3] = ok ? 255 : 0;
      known += ok;
    }
    if (!known) return false;
    fillHoles(gain, cw, ch);

    const d = this.darkenImage.data;
    const b = this.brightenImage.data;
    for (let i = 0; i < gain.length; i++) {
      if (i % 4 === 3) {
        d[i] = b[i] = 255;
        continue;
      }
      const g = Math.min(2, Math.max(0.5, gain[i]));
      d[i] = 255 * Math.min(1, g);
      b[i] = 255 * (1 - 1 / Math.max(1, g));
    }
    this.darkenCtx.putImageData(this.darkenImage, 0, 0);
    this.brightenCtx.putImageData(this.brightenImage, 0, 0);
    return true;
  }

  // Colour and person alpha at one pixel per dust cell.
  sampleCells() {
    const { gw, gh } = this.dust;
    const g = this.gridCtx;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.cam, 0, 0, gw, gh);
    const rgba = g.getImageData(0, 0, gw, gh).data;
    g.drawImage(this.bodyMask, 0, 0, gw, gh);
    const alpha = g.getImageData(0, 0, gw, gh).data;
    for (let i = 0; i < this.cellMask.length; i++) this.cellMask[i] = alpha[i * 4 + 3];
    return { rgba, mask: this.cellMask };
  }
}

// Binary dilation by a square of radius r (separable running max).
function dilate(src, dst, w, h, r) {
  const tmp = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r) && !v; dx++) v = src[row + dx];
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r) && !v; dy++) v = tmp[dy * w + x];
      dst[y * w + x] = v;
    }
  }
}
