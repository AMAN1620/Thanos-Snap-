// A small floating panel on the Meet page (only you see it): status, live hand
// readings for tuning, and manual buttons.
// Built with createElement/textContent only: Meet enforces Trusted Types.

const STYLE = `
  :host { all: initial; }
  .panel {
    position: fixed; left: 16px; bottom: 96px; z-index: 2147483647;
    width: 248px; padding: 10px 12px; border-radius: 12px;
    background: rgba(24, 20, 30, 0.92); color: #eee; box-shadow: 0 6px 24px rgba(0,0,0,.4);
    font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .panel.collapsed { width: auto; }
  .panel.collapsed .body { display: none; }
  header { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  header b { font-size: 13px; color: #d7b4ff; flex: 1; }
  .chip { padding: 1px 8px; border-radius: 99px; background: #3a3346; font-size: 11px; }
  .chip.gone { background: #6b3fa0; }
  .row { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; }
  .row span:first-child { color: #a99fb8; }
  button {
    font: inherit; color: inherit; background: #3a3346; border: 1px solid #514866;
    border-radius: 6px; padding: 4px 8px; cursor: pointer;
  }
  .buttons { display: flex; gap: 6px; margin-top: 8px; }
  .buttons button { flex: 1; }
  .note { margin-top: 8px; color: #a99fb8; }
  .error { color: #ff8f8f; }
`;

const STATE_LABELS = {
  visible: 'visible',
  dusting: 'turning to dust',
  gone: 'gone',
  returning: 'coming back',
};

export class Hud {
  constructor(controller) {
    this.ctl = controller;
    this.host = null;
    this.prefs = { collapsed: false };
  }

  async loadPrefs() {
    try {
      const { prefs } = await chrome.storage.local.get('prefs');
      Object.assign(this.prefs, prefs);
    } catch {
      // Storage unavailable: keep defaults.
    }
  }

  savePrefs() {
    chrome.storage.local.set({ prefs: this.prefs }).catch(() => {});
  }

  mount() {
    if (this.host || !document.body) return;
    this.host = document.createElement('thanos-snap-hud');
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style, this.build());
    document.body.appendChild(this.host);
    this.update();
    this.timer = setInterval(() => this.update(), 150);
  }

  unmount() {
    clearInterval(this.timer);
    this.host?.remove();
    this.host = null;
  }

  build() {
    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const row = (label) => {
      const value = el('span');
      return [el('div', { className: 'row' }, el('span', { textContent: label }), value), value];
    };

    this.chip = el('span', { className: 'chip' });
    const header = el('header', {}, el('b', { textContent: 'Thanos Snap' }), this.chip);
    header.addEventListener('click', () => {
      this.prefs.collapsed = !this.prefs.collapsed;
      this.savePrefs();
      this.update();
    });

    let modelRow, cameraRow, handRow, roomRow;
    [modelRow, this.model] = row('Model');
    [cameraRow, this.camera] = row('Camera');
    [handRow, this.hand] = row('Hand');
    [roomRow, this.roomState] = row('Room');
    const snap = el('button', { textContent: 'Snap', title: 'Alt+Shift+S' });
    snap.addEventListener('click', () => this.ctl.snap());
    const room = el('button', { textContent: 'Capture empty room', title: 'Alt+Shift+B' });
    room.addEventListener('click', () => this.ctl.captureRoom());

    this.note = el('div', { className: 'note' });
    this.errorLine = el('div', { className: 'note error' });

    this.panel = el(
      'div',
      { className: 'panel' },
      header,
      el(
        'div',
        { className: 'body' },
        modelRow,
        cameraRow,
        handRow,
        roomRow,
        el('div', { className: 'buttons' }, snap, room),
        this.note,
        this.errorLine,
      ),
    );
    return this.panel;
  }

  update() {
    const ctl = this.ctl;
    const now = performance.now();
    const d = ctl.detector.debug;
    const { state } = ctl.phase(now);

    this.panel.classList.toggle('collapsed', this.prefs.collapsed);
    this.chip.textContent = STATE_LABELS[state];
    this.chip.classList.toggle('gone', state !== 'visible');
    this.model.textContent = ctl.visionStatus;

    const p = ctl.active;
    this.camera.textContent = p?.size ? `${p.size.width}×${p.size.height} · ${p.fps} fps` : 'not in use';
    // A new camera stream (Meet restarting the camera) starts a new room.
    this.roomState.textContent = p?.plate?.captured ? 'captured' : 'not captured';

    if (!d.hands) this.hand.textContent = 'none';
    else if (d.gap === null) this.hand.textContent = `${d.hands} seen`;
    else {
      const pose = d.pinched ? 'pinch ✓' : `gap ${d.gap.toFixed(2)}`;
      this.hand.textContent = `${pose} · curl ${d.curl.toFixed(2)}`;
    }

    this.note.textContent = ctl.captureMessage(now) ?? 'Pinch thumb and middle finger, then flick the middle finger down.';
    this.errorLine.textContent = ctl.error ?? '';
  }
}
