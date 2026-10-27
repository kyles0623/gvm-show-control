// The rig: every paired light, which ones are selected, and a shared session log.
// Each light has its own LightConnection (own write queue, reconnect, status), so lights are
// driven in parallel. Events re-dispatched with detail.light = the light object:
//   'status' | 'light' | 'gatt' | 'problem' (detail also has code/error), plus 'lights' and 'log'.
import { LightConnection, chooseDevice } from './ble.js';

const KEY = 'gvm.lights';
const LOG_CAP = 500;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function ts() {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export class Rig extends EventTarget {
  constructor() {
    super();
    this.supported = !!navigator.bluetooth;
    this.lights = [];          // {id, label, name, conn}
    this.selection = null;     // null = all lights, else Set of ids
    this.log = [];
    this.full = [];
    this._load();
  }

  // ---------- log ----------
  logLine(msg) {
    const line = `${ts()}  ${msg}`;
    this.full.push(line);
    this.log.push(line);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.dispatchEvent(new Event('log'));
  }
  clearLog() { this.log = []; this.dispatchEvent(new Event('log')); }

  // ---------- storage ----------
  _load() {
    let saved = store.get(KEY, null);
    if (!saved) {
      // Migrate the single-light format (gvm.deviceId / gvm.deviceName / gvm.ui.lightName).
      let id = null, name = null;
      try { id = localStorage.getItem('gvm.deviceId'); name = localStorage.getItem('gvm.deviceName'); } catch {}
      saved = [];
      if (id) {
        name = name || 'BT_LED';
        const custom = store.get('gvm.ui.lightName', '');
        saved.push({ id, name, label: custom || name });
      }
      store.set(KEY, saved);
    }
    for (const l of saved) this._add(l);
  }

  _save() {
    store.set(KEY, this.lights.map(({ id, label, name }) => ({ id, label, name })));
    // Keep the legacy key pointing at the first light (older code paths and tests read it).
    try {
      if (this.lights[0]) { localStorage.setItem('gvm.deviceId', this.lights[0].id); localStorage.setItem('gvm.deviceName', this.lights[0].name); }
      else { localStorage.removeItem('gvm.deviceId'); localStorage.removeItem('gvm.deviceName'); }
    } catch {}
  }

  _add({ id, name, label }) {
    const conn = new LightConnection({ id, name: label || name, logger: (m) => this.logLine(m) });
    const light = { id, name: name || 'BT_LED', label: label || name || 'BT_LED', conn };
    for (const type of ['status', 'light', 'gatt', 'problem']) {
      conn.addEventListener(type, (ev) => {
        this.dispatchEvent(new CustomEvent(type, { detail: { ...(ev.detail ?? {}), light } }));
      });
    }
    this.lights.push(light);
    return light;
  }

  _uniqueLabel(base) {
    const used = new Set(this.lights.map((l) => l.label));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  // ---------- queries ----------
  get(id) { return this.lights.find((l) => l.id === id); }
  get connected() { return this.lights.filter((l) => l.conn.connected); }
  get anyConnected() { return this.lights.some((l) => l.conn.connected); }
  get anyActive() { return this.lights.some((l) => ['connected', 'connecting', 'reconnecting'].includes(l.conn.status)); }

  isSelected(id) { return !this.selection || this.selection.has(id); }
  /** Connected lights that controls act on. */
  targets() { return this.connected.filter((l) => this.isSelected(l.id)); }
  /** The light whose state the sliders show: first selected connected light. */
  primary() { return this.targets()[0] ?? this.connected[0] ?? this.lights[0] ?? null; }

  select(id, { add = false } = {}) {
    if (id == null) this.selection = null;
    else if (add) {
      const s = new Set(this.selection ?? this.lights.map((l) => l.id));
      if (s.has(id) && s.size > 1) s.delete(id); else s.add(id);
      this.selection = s.size === this.lights.length ? null : s;
    } else this.selection = new Set([id]);
    this.dispatchEvent(new Event('lights'));
  }

  // ---------- management ----------
  rename(id, label) {
    const l = this.get(id);
    if (!l) return;
    l.label = label.trim() || l.name;
    l.conn.label = l.label;
    this._save();
    this.dispatchEvent(new Event('lights'));
  }

  async forget(id) {
    const l = this.get(id);
    if (!l) return;
    l.conn.disconnect();
    try { await l.conn.device?.forget?.(); } catch {}
    this.lights = this.lights.filter((x) => x !== l);
    if (this.selection) { this.selection.delete(id); if (!this.selection.size) this.selection = null; }
    this._save();
    this.logLine(`Forgot ${l.label}`);
    this.dispatchEvent(new Event('lights'));
  }

  /** Opens the chooser; connects the chosen light, adding it if new. Call from a user gesture. */
  async pair(opts = {}) {
    if (!this.supported) return null;
    let device;
    try { device = await chooseDevice(opts); }
    catch (e) {
      this.logLine(`CHOOSER closed: ${e.name}: ${e.message}`);
      this.dispatchEvent(new CustomEvent('problem', { detail: { code: e.problem, error: e, light: null } }));
      return null;
    }
    let light = this.get(device.id);
    if (!light) {
      light = this._add({ id: device.id, name: device.name ?? 'BT_LED', label: this._uniqueLabel(device.name ?? 'BT_LED') });
      this._save();
      this.dispatchEvent(new Event('lights'));
    }
    await light.conn.connect(device);
    if (light.conn.status === 'disconnected' && light.conn.statusDetail === 'not a supported light') {
      await this.forget(light.id);   // explorer pick that isn't a light: don't keep it
    }
    return light;
  }

  /** Connects every remembered light the browser still has permission for. */
  async restoreAll() {
    if (!navigator.bluetooth?.getDevices) { this.logLine('getDevices() unavailable: use Pair'); return false; }
    if ((await navigator.bluetooth.getAvailability?.().catch(() => true)) === false) {
      this.logLine('Bluetooth adapter unavailable');
      this.dispatchEvent(new CustomEvent('problem', { detail: { code: 'adapter', light: null } }));
      return false;
    }
    let devices = [];
    try { devices = await navigator.bluetooth.getDevices(); } catch {}
    let any = false;
    await Promise.all(this.lights.map(async (l) => {
      if (l.conn.connected || l.conn.status === 'connecting') { any = true; return; }
      const device = devices.find((d) => d.id === l.id);
      if (!device) {
        l.conn.logLine('not permitted any more: pair again');
        this.dispatchEvent(new CustomEvent('problem', { detail: { code: 'forgotten', light: l } }));
        return;
      }
      any = true;
      l.conn.logLine('auto-connect');
      await l.conn.connect(device, { auto: true });
    }));
    return any;
  }

  /** Reconnect one light (Retry now / Connect). */
  async reconnect(light) {
    if (light.conn.device) return light.conn.connect(light.conn.device);
    return this.restoreAll();
  }

  disconnectAll() { for (const l of this.lights) l.conn.disconnect(); }
}
