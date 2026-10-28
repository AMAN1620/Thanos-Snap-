// Isolated-world controller: answers the page hook, owns the effect state
// (visible → dusting → gone → returning → visible), the models, the snap
// detector and the panel.

import { EFFECT_SECONDS } from './dust.js';
import { Hud } from './hud.js';
import { Pipeline } from './pipeline.js';
import { SnapDetector } from './snap-detector.js';
import { loadVision } from './vision.js';

const CAPTURE_COUNTDOWN_MS = 3000;
const CAPTURE_MS = 1200;

class Controller {
  constructor() {
    this.state = 'visible';
    this.effectId = 0;
    this.effectStart = 0;
    this.vision = null;
    this.visionStatus = 'not loaded';
    this.error = null;
    this.pipelines = new Set();
    this.active = null; // the newest pipeline; only it runs the models
    this.capture = null;
    this.detector = new SnapDetector(() => this.snap());
    this.hud = new Hud(this);
    this.hud.loadPrefs();
  }

  // Called synchronously from the bridge. Returns the processed video track,
  // or null to let Meet have the real stream.
  onInput(stream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
      this.error = 'This Chrome lacks MediaStreamTrackProcessor; camera left unchanged.';
      return null;
    }

    const pipeline = new Pipeline(this, track);
    this.pipelines.add(pipeline);
    this.active = pipeline;
    this.ensureVision();
    this.hud.mount();
    return pipeline.output;
  }

  pipelineEnded(pipeline) {
    this.pipelines.delete(pipeline);
    if (this.active === pipeline) this.active = [...this.pipelines].at(-1) ?? null;
    if (!this.pipelines.size) {
      this.state = 'visible';
    }
  }

  ensureVision() {
    if (this.vision || this.visionStatus === 'loading…') return;
    this.visionStatus = 'loading…';
    loadVision().then(
      (vision) => {
        this.vision = vision;
        this.visionStatus = `ready (${vision.delegate})`;
      },
      (err) => {
        console.error('[thanos-snap] could not load models', err);
        this.visionStatus = 'failed';
        this.error = String(err?.message ?? err);
      },
    );
  }

  // Current effect state and seconds into it; advances finished effects.
  phase(now) {
    let t = (now - this.effectStart) / 1000;
    if ((this.state === 'dusting' || this.state === 'returning') && t >= EFFECT_SECONDS) {
      this.state = this.state === 'dusting' ? 'gone' : 'visible';
    }
    return { state: this.state, t, effectId: this.effectId };
  }

  snap() {
    if (!this.vision || !this.active?.hasMask) return;
    const now = performance.now();
    const { state } = this.phase(now);
    if (state !== 'visible' && state !== 'gone') return; // mid-effect
    this.state = state === 'visible' ? 'dusting' : 'returning';
    this.effectStart = now;
    this.effectId += 1;
  }

  captureRoom() {
    const now = performance.now();
    this.capture = { from: now + CAPTURE_COUNTDOWN_MS, to: now + CAPTURE_COUNTDOWN_MS + CAPTURE_MS };
  }

  capturing(now) {
    return !!this.capture && now >= this.capture.from && now < this.capture.to;
  }

  captureMessage(now) {
    const c = this.capture;
    if (!c || now > c.to + 2500) return null;
    if (now < c.from) return `Step out of the frame… ${Math.ceil((c.from - now) / 1000)}`;
    if (now < c.to) return 'Capturing the empty room…';
    return 'Room captured. Come back in!';
  }
}

const controller = new Controller();

// Bridge with src/page-hook.js; see there.
document.addEventListener('thanos-snap:input', (event) => {
  const id = String(event.detail);
  const root = document.getElementById('thanos-snap-bridge');
  const input = root?.querySelector(`video[data-thanos-in="${CSS.escape(id)}"]`);
  const stream = input?.srcObject;
  if (!(stream instanceof MediaStream)) return;
  let track = null;
  try {
    track = controller.onInput(stream);
  } catch (err) {
    console.error('[thanos-snap] could not process the camera', err);
    controller.error = String(err?.message ?? err);
  }
  if (!track) return;
  const output = document.createElement('video');
  output.muted = true;
  output.dataset.thanosOut = id;
  output.srcObject = new MediaStream([track]);
  root.appendChild(output);
});

window.addEventListener(
  'keydown',
  (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyS') controller.snap();
    else if (e.code === 'KeyB') controller.captureRoom();
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
