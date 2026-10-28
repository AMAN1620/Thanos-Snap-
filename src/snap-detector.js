// Detects a snap gesture: press the thumb and middle fingertip together, then
// flick the middle finger down into the palm.

// Hand geometry, as multiples of palm size (wrist to middle-finger knuckle).
const PINCH_GAP = 0.35; // thumb tip to middle tip: pressed together
const RELEASE_GAP = 0.6; // ... apart again after the flick
const CURLED = 1.15; // wrist to middle tip: finger folded into the palm

const ARMED_MS = 800; // how long after a pinch a flick still counts
const COOLDOWN_MS = 1500;

export class SnapDetector {
  constructor(onSnap) {
    this.onSnap = onSnap;
    this.lastPinchAt = -Infinity;
    this.lastFlickAt = -Infinity;
    this.lastSnapAt = -Infinity;
    this.debug = { hands: 0, gap: null, curl: null };
  }

  // hands: MediaPipe landmarks (normalised to the frame); aspect: width / height.
  onHands(hands, aspect, now) {
    let pinched = false;
    let flicked = false;
    this.debug.hands = hands.length;
    this.debug.gap = this.debug.curl = null;
    for (const h of hands) {
      const d = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
      const palm = d(h[0], h[9]);
      if (palm < 1e-3) continue;
      const gap = d(h[4], h[12]) / palm;
      const curl = d(h[0], h[12]) / palm;
      this.debug.gap = gap;
      this.debug.curl = curl;
      if (gap < PINCH_GAP) pinched = true;
      else if (gap > RELEASE_GAP && curl < CURLED && now - this.lastPinchAt < ARMED_MS) flicked = true;
    }
    if (pinched) this.lastPinchAt = now;
    if (flicked) this.lastFlickAt = now;
    this.debug.pinched = pinched;
    this.check(now);
  }

  check(now) {
    if (now - this.lastSnapAt < COOLDOWN_MS || now - this.lastFlickAt >= 50) return;
    this.lastSnapAt = now;
    this.lastFlickAt = this.lastPinchAt = -Infinity;
    this.onSnap();
  }
}
