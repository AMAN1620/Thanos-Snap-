// Runs in Meet's own JS world (MAIN) at document_start. It wraps getUserMedia so
// Meet gets the processed camera track instead of the real one.
//
// The processing lives in the extension's isolated world (Meet enforces Trusted
// Types, so MediaPipe cannot be loaded into this world). The two worlds share
// the DOM but not JS objects, so streams cross over as the srcObject of hidden
// <video> elements, and the handshake is a pair of synchronous DOM events.
(() => {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) return;

  const realGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const realStop = MediaStreamTrack.prototype.stop;
  let seq = 0;

  function bridge() {
    let root = document.getElementById('thanos-snap-bridge');
    if (!root) {
      root = document.createElement('div');
      root.id = 'thanos-snap-bridge';
      root.hidden = true;
      document.documentElement.appendChild(root);
    }
    return root;
  }

  // Hands the real stream to the isolated world and returns its processed video
  // track, or null if the extension declined (no video, or not running).
  function exchange(stream) {
    const id = String(++seq);
    const input = document.createElement('video');
    input.muted = true;
    input.dataset.thanosIn = id;
    input.srcObject = stream;
    bridge().appendChild(input);

    // The isolated world handles this event synchronously and appends
    // <video data-thanos-out=id> before dispatchEvent returns.
    document.dispatchEvent(new CustomEvent('thanos-snap:input', { detail: id }));

    const output = bridge().querySelector(`video[data-thanos-out="${id}"]`);
    const track = output?.srcObject?.getVideoTracks()[0] ?? null;
    input.remove();
    output?.remove();
    return track;
  }

  // Meet inspects the camera track (label, deviceId, capabilities) and tunes it
  // with applyConstraints, so the processed track answers as the real one.
  function disguise(fake, real) {
    const getOutputSettings = fake.getSettings.bind(fake);
    const forward = (name) =>
      Object.defineProperty(fake, name, { configurable: true, value: real[name].bind(real) });
    ['getCapabilities', 'getConstraints', 'applyConstraints'].forEach(forward);
    Object.defineProperty(fake, 'getSettings', {
      configurable: true,
      value() {
        const settings = real.getSettings();
        const output = getOutputSettings();
        for (const key of ['width', 'height', 'aspectRatio']) {
          if (output[key] !== undefined) settings[key] = output[key];
        }
        return settings;
      },
    });
    Object.defineProperty(fake, 'label', { configurable: true, get: () => real.label });
    Object.defineProperty(fake, 'stop', {
      configurable: true,
      value() {
        realStop.call(fake);
        realStop.call(real);
      },
    });
  }

  mediaDevices.getUserMedia = async function getUserMedia(constraints) {
    const stream = await realGetUserMedia(constraints);
    const real = stream.getVideoTracks()[0];
    let fake = null;
    try {
      fake = exchange(stream);
    } catch (err) {
      console.warn('[thanos-snap] passing the camera through unchanged:', err);
    }
    if (!real || !fake) return stream;
    disguise(fake, real);
    return new MediaStream([fake, ...stream.getAudioTracks()]);
  };
})();
