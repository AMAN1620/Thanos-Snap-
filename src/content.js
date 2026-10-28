// Isolated-world entry point. Content scripts cannot be ES modules, so this
// only loads the real one. vendor/vision_wasm_internal.js runs before this file
// and leaves MediaPipe's ModuleFactory on this world's global object.
import(chrome.runtime.getURL('src/main.js')).catch((err) =>
  console.error('[thanos-snap] failed to start:', err),
);
