# Thanos Snap for Meet

A Chrome extension for Google Meet: snap your fingers and you crumble to dust
on everyone's screen. Snap again and the dust flies back and you reappear.

Everyone in the call sees it, because the extension replaces the camera track
Meet sends. You are still in the call, though: only your video vanishes.

## Install

```bash
npm install          # also copies MediaPipe into vendor/ and downloads the models into models/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Open or reload a Meet tab.

## Use

A small **Thanos Snap** panel appears at the bottom left once your camera is on.
Only you can see it. Click its title to collapse it.

1. **Capture empty room** (Alt+Shift+B): step out of the frame during the 3-second
   countdown. This shows the room behind you once you're gone. Without it, the
   room is learned from whatever is around you, and the spot where you sat is
   filled in as a smudge. The panel's **Room** row says `captured` while the
   capture is in use; capture again if Meet restarts your camera.
2. **Snap:** press your thumb and middle finger together, then flick the middle
   finger down into your palm. The panel shows `pinch ✓` when it sees the pose.
3. **Snap again** to come back. **Alt+Shift+S** or the **Snap** button does the
   same, which is handy for testing.

Snap detection uses the hand gesture only; it does not request microphone access.

## How it works

```
Meet page (MAIN world)           extension (isolated world)
──────────────────────           ───────────────────────────────────────────
getUserMedia() ── real stream ─▶ MediaStreamTrackProcessor → VideoFrames
                                   ├─ MediaPipe hand landmarker → snap detector
                                   ├─ MediaPipe selfie segmenter → body mask
                                   ├─ room plate (learned / captured)
                                   └─ dust particles → composite
Meet gets ◀── processed track ─── MediaStreamTrackGenerator
```

- `src/page-hook.js` runs in Meet's own JS world and wraps `getUserMedia`. Meet
  enforces Trusted Types, so MediaPipe can't load there. Everything else runs in
  the isolated world. The two worlds share only the DOM, so the streams cross
  between them as the `srcObject` of hidden `<video>` elements. The returned
  track forwards `label`, `getSettings` and `applyConstraints` to the real
  camera, so Meet's device picker keeps working.
- Frames are pulled with `MediaStreamTrackProcessor`, not
  `requestAnimationFrame`, so your video keeps running while the Meet tab is in
  the background.
- `src/dust.js`: the frame is a grid of small cells. Each cell gets a release time
  from a noise field. When a cell of your body is released, it becomes a particle
  that drifts on the wind, turns to ash and fades. Particle paths are a
  closed-form function of age, so the return effect is the same animation
  played backwards.
- `src/plate.js`: the empty room. Holes are filled by interpolating along rows and
  columns, so walls, desks and the horizon continue behind you. Webcams
  re-expose when you leave and come back, so a captured room is drawn scaled to
  the live room around you; otherwise it would show as a darker or lighter
  shape of you.

## Tuning

The thresholds are constants at the top of `src/snap-detector.js` (hand
geometry) and `src/dust.js` (timing, speed, ash colour). The panel shows the
live `gap` and `curl` values, which helps with tuning.

## Tests

```bash
npm test             # snap detector unit tests
npm run test:e2e     # loads the extension in headless Chrome with a photo as the
                     # fake webcam, snaps, and writes frames to test/out/
```

The e2e test runs against a stand-in page on localhost, not real Meet (that
needs a signed-in account). Test it on a real call too.

## Limitations

- Needs Chrome's `MediaStreamTrackProcessor`. If it's missing, the camera is
  passed through unchanged and the panel says so.
- Turn off Meet's own background effects. They work, but you pay for two
  segmentation passes.
- Meet changes often. The hook only touches `getUserMedia`, which is stable, but
  expect occasional upkeep.
