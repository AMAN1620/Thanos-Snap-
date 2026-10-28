// The empty room: what is shown where you were. It is learned continuously
// from every pixel the segmenter says is not you, or captured outright with
// "Capture empty room". Parts never seen (right behind you) are filled in from
// their surroundings.
//
// A captured room is then kept as it was, at the camera's exposure of that
// moment; the pipeline matches it to the live exposure when drawing it.

const FILL_W = 160; // hole filling runs at this width
const REFILL_EVERY = 15; // frames between rebuilding the filled plate

export class Plate {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.filledCanvas = new OffscreenCanvas(width, height);
    this.filledCtx = this.filledCanvas.getContext('2d');
    this.fw = FILL_W;
    this.fh = Math.round((FILL_W * height) / width);
    this.small = new OffscreenCanvas(this.fw, this.fh);
    this.smallCtx = this.small.getContext('2d', { willReadFrequently: true });
    this.sinceRefill = Infinity;
    this.captured = false;
  }

  // source: the camera frame with the person cut out (transparent). After a
  // capture, frames only fill in what the capture missed: relearning the room
  // around you would leave the part behind you as the only part at the old
  // exposure, and nothing to measure the difference against.
  learn(source, rate, capturing = false) {
    if (capturing) this.captured = true;
    const c = this.ctx;
    c.globalCompositeOperation = this.captured && !capturing ? 'destination-over' : 'source-over';
    c.globalAlpha = rate;
    c.drawImage(source, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    this.sinceRefill += 1;
  }

  // The plate with its holes filled, rebuilt every few frames.
  filled() {
    if (this.sinceRefill < REFILL_EVERY) return this.filledCanvas;
    this.sinceRefill = 0;

    // Shrink, fill the holes there, and use that under the full-size plate.
    // getImageData returns un-premultiplied colour, so a half-covered pixel
    // has the colour of its covered part.
    const s = this.smallCtx;
    s.clearRect(0, 0, this.fw, this.fh);
    s.imageSmoothingQuality = 'high';
    s.drawImage(this.canvas, 0, 0, this.fw, this.fh);
    const image = s.getImageData(0, 0, this.fw, this.fh);
    fillHoles(image.data, this.fw, this.fh);
    s.putImageData(image, 0, 0);

    const f = this.filledCtx;
    f.imageSmoothingQuality = 'high';
    f.drawImage(this.small, 0, 0, this.width, this.height);
    f.filter = 'blur(4px)';
    f.drawImage(this.canvas, 0, 0);
    f.filter = 'none';
    f.drawImage(this.canvas, 0, 0);
    return this.filledCanvas;
  }
}

// Makes every pixel opaque. A hole pixel blends a straight-line interpolation
// across its row and one across its column, each weighted by how short its gap
// is. Walls, desks and the horizon run straight behind people, so this beats
// a radial blur. px may be any RGBA-laid-out array (alpha >= 24 is known).
export function fillHoles(px, w, h) {
  const covered = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) any = (covered[i] = px[i * 4 + 3] >= 24 ? 1 : 0) || any;
  if (!any) {
    for (let i = 0; i < w * h; i++) px.set([60, 60, 60, 255], i * 4);
    return;
  }

  const acc = new Float32Array(w * h * 4); // r, g, b, weight
  // Interpolates along one line of pixels (a row or a column).
  const line = (start, stride, count) => {
    let prev = -1;
    for (let k = 0; k <= count; k++) {
      if (k < count && !covered[start + k * stride]) continue;
      // (A line with nothing covered at all is left to the other direction.)
      if (k - prev > 1 && (prev >= 0 || k < count)) {
        const a = prev >= 0 ? start + prev * stride : -1;
        const b = k < count ? start + k * stride : -1;
        const gap = k - prev;
        // A gap open at the image edge only has one side to copy from.
        const weight = 1 / (a >= 0 && b >= 0 ? gap : gap * 3);
        for (let m = prev + 1; m < k; m++) {
          const t = (m - prev) / gap;
          const i = start + m * stride;
          for (let c = 0; c < 3; c++) {
            const va = a >= 0 ? px[a * 4 + c] : px[b * 4 + c];
            const vb = b >= 0 ? px[b * 4 + c] : px[a * 4 + c];
            acc[i * 4 + c] += (va + (vb - va) * t) * weight;
          }
          acc[i * 4 + 3] += weight;
        }
      }
      prev = k;
    }
  };
  for (let y = 0; y < h; y++) line(y * w, 1, w);
  for (let x = 0; x < w; x++) line(x, w, h);

  for (let i = 0; i < w * h; i++) {
    const weight = acc[i * 4 + 3];
    if (!covered[i] && weight > 0) {
      for (let c = 0; c < 3; c++) px[i * 4 + c] = acc[i * 4 + c] / weight;
    }
    px[i * 4 + 3] = 255;
  }

  // Neighbouring lines can have very different gaps, which shows as streaks;
  // a few rounds of neighbour averaging inside the holes smooth them out.
  for (let round = 0; round < 12; round++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (covered[i]) continue;
        const l = x > 0 ? i - 1 : i;
        const r = x < w - 1 ? i + 1 : i;
        const u = y > 0 ? i - w : i;
        const d = y < h - 1 ? i + w : i;
        for (let c = 0; c < 3; c++) {
          px[i * 4 + c] = (px[l * 4 + c] + px[r * 4 + c] + px[u * 4 + c] + px[d * 4 + c]) / 4;
        }
      }
    }
  }
}
