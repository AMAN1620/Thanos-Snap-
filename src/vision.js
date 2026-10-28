// Loads the MediaPipe hand landmarker and selfie segmenter.
//
// MediaPipe normally injects its WASM loader with a <script> tag, which would
// run in Meet's world (and be refused by Meet's Trusted Types policy). Instead
// the loader is a content script, and an empty wasmLoaderPath tells MediaPipe
// to use the ModuleFactory already on this world's global object. Each task
// creation consumes that global, so it is put back before every create.

const url = (path) => chrome.runtime.getURL(path);

let loading = null;

export function loadVision() {
  loading ??= init();
  return loading;
}

async function init() {
  const factory = self.ModuleFactory;
  if (!factory) throw new Error('MediaPipe WASM loader did not run');
  const { HandLandmarker, ImageSegmenter } = await import(url('vendor/vision_bundle.mjs'));
  const fileset = { wasmLoaderPath: '', wasmBinaryPath: url('vendor/vision_wasm_internal.wasm') };

  async function create(Task, options) {
    let lastError;
    for (const delegate of ['GPU', 'CPU']) {
      self.ModuleFactory = factory;
      try {
        const task = await Task.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate },
        });
        return { task, delegate };
      } catch (err) {
        lastError = err;
        console.warn(`[thanos-snap] ${Task.name} on ${delegate} failed`, err);
      }
    }
    throw lastError;
  }

  const hands = await create(HandLandmarker, {
    baseOptions: { modelAssetPath: url('models/hand_landmarker.task') },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.4,
  });
  const segmenter = await create(ImageSegmenter, {
    baseOptions: { modelAssetPath: url('models/selfie_segmenter.tflite') },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });

  let lastTs = 0;
  return {
    delegate: hands.delegate === segmenter.delegate ? hands.delegate : 'mixed',

    // Both tasks need strictly increasing timestamps.
    timestamp() {
      lastTs = Math.max(performance.now(), lastTs + 1);
      return lastTs;
    },

    detectHands(image, ts) {
      return hands.task.detectForVideo(image, ts).landmarks;
    },

    // Writes the person confidence (0..1) for every pixel of `image` into `out`.
    segment(image, ts, out) {
      segmenter.task.segmentForVideo(image, ts, (result) => {
        out.set(result.confidenceMasks[0].getAsFloat32Array());
      });
    },
  };
}
