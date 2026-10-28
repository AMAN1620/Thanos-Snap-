// Unit tests for the snap decision logic, with synthetic hand landmarks.
//   node --test test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapDetector } from '../src/snap-detector.js';

// A hand in normalised coordinates on a square frame: wrist at the bottom,
// middle knuckle 0.1 above it (palm size 0.1), and the thumb and middle
// fingertips placed as given.
function hand({ thumb, middle }) {
  const h = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  h[0] = { x: 0.5, y: 0.8, z: 0 };
  h[9] = { x: 0.5, y: 0.7, z: 0 };
  h[4] = { x: thumb[0], y: thumb[1], z: 0 };
  h[12] = { x: middle[0], y: middle[1], z: 0 };
  return h;
}
// Thumb and middle fingertip pressed together, in front of the palm.
const PINCH = hand({ thumb: [0.55, 0.64], middle: [0.56, 0.645] });
// Just after the snap: middle tip folded onto the palm base, thumb up and away.
const FLICK = hand({ thumb: [0.6, 0.6], middle: [0.5, 0.74] });
// An open hand, fingers extended.
const OPEN = hand({ thumb: [0.62, 0.7], middle: [0.5, 0.6] });

function detector() {
  const snaps = [];
  const d = new SnapDetector(() => snaps.push(true));
  return { d, snaps };
}

test('pinch then middle-finger flick is a snap', () => {
  const { d, snaps } = detector();
  d.onHands([PINCH], 1, 1000);
  d.onHands([PINCH], 1, 1033);
  d.onHands([FLICK], 1, 1066);
  assert.equal(snaps.length, 1);
});

test('a flick long after the pinch is not a snap', () => {
  const { d, snaps } = detector();
  d.onHands([PINCH], 1, 1000);
  d.onHands([OPEN], 1, 1100);
  d.onHands([FLICK], 1, 2500);
  assert.equal(snaps.length, 0);
});

test('an open hand never snaps', () => {
  const { d, snaps } = detector();
  for (let t = 0; t < 2000; t += 33) d.onHands([OPEN], 1, t);
  assert.equal(snaps.length, 0);
});

test('cooldown stops a double trigger', () => {
  const { d, snaps } = detector();
  d.onHands([PINCH], 1, 1000);
  d.onHands([FLICK], 1, 1033);
  d.onHands([PINCH], 1, 1100);
  d.onHands([FLICK], 1, 1133);
  assert.equal(snaps.length, 1);
  d.onHands([PINCH], 1, 3000);
  d.onHands([FLICK], 1, 3033);
  assert.equal(snaps.length, 2);
});

test('gesture recognition does not depend on microphone input', () => {
  const { d, snaps } = detector();
  d.onHands([PINCH], 1, 1000);
  d.onHands([FLICK], 1, 1033);
  assert.equal(snaps.length, 1);
});
