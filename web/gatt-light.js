// A connection for lights that take plain Bluetooth writes (Neewer, ELK-BLEDOM / LEDBLE strips, Govee, Nanlite,
// Yongnuo): one write characteristic, whole-state commands from a protocol in lightproto.js. Same interface as
// LightConnection (ble.js) / AmaranConnection, so the rest of the app is unchanged.
//
// These lights are UNTESTED on hardware. Most send no replies, so the app shows what it sent (not what the light
// reports), and every frame is logged in hex so a user's log can confirm or correct the driver.
import { toHex } from './ble.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * proto: {
 *   service, write?            UUIDs; without `write`, the first writable characteristic of the service
 *   notify?                    UUID to subscribe to (replies are logged, not decoded)
 *   frames(state, conn)        → [Uint8Array] for {on, mode, kelvin, hue, sat, bri}
 *   key?(frame)                → string: frames with the same key replace each other (an unchanged one isn't resent)
 *   gapMs?                     pause between writes (default 20)
 *   chunk?                     split frames into writes of this size, back to back (Nanlite: 20)
 *   keepAlive?: {ms, frame}    sent while connected (Govee)
 * }
 */
export class GattLightConnection extends EventTarget {
  constructor({ id, name, logger, proto }) {
    super();
    this.id = id;
    this.label = name ?? 'light';
    this.logger = logger;
    this.proto = proto;
    this.status = navigator.bluetooth ? 'idle' : 'unsupported';
    this.statusDetail = '';
    this.device = null;
    this.light = {};
    this.chars = [];
    this.ctrl = null;
    this.confirmed = {};
    this.statusRaw = null;
    this.statusChangedAt = [];
    this.handshakeReply = null;
    this.quietStatus = true;
    this.echoStatus = false;
    this.lastRxAt = 0;
    this.lastStatusAt = 0;
    this.noAnswers = true;          // the app can't confirm commands: it shows what it sent
    this.noReply = false;
    this.master = 1;
    this.levelBri = null;
    this.seq = 0;
    this._want = { on: true, mode: 'cct', kelvin: 5600, hue: 0, sat: 100, bri: 50 };
    this._sent = new Map();
    this._pump = null;
    this._dirty = false;
    this._retry = 0;
    this._onDisc = () => this._lost();
  }

  logLine(msg) { this.logger?.(`[${this.label}] ${msg}`); }
  _setStatus(status, detail = '') { this.status = status; this.statusDetail = detail; this.dispatchEvent(new Event('status')); }
  _problem(code, error = null) { this.dispatchEvent(new CustomEvent('problem', { detail: { code, error } })); }
  get connected() { return this.status === 'connected' && !!this.device?.gatt.connected; }
  get wanted() { return { ...this.light, brightness: this.levelBri ?? this.light.brightness }; }

  // ---------- connect ----------

  async connect(device, { auto = false } = {}) {
    this.device = device;
    this._user = false;
    clearTimeout(this._retryTimer);
    this._setStatus('connecting');
    this.logLine(`CONNECT → ${device.name ?? '(unnamed)'} id=${device.id}${auto ? ' (auto)' : ''}`);
    try {
      const server = await Promise.race([device.gatt.connect(), sleep(10000).then(() => { throw new Error('connect timeout'); })]);
      const svc = await server.getPrimaryService(this.proto.service).catch(() => null);
      if (!svc) throw Object.assign(new Error(`no ${this.proto.service.slice(0, 8)} service: not this kind of light`), { code: 'not-light' });
      const chars = await svc.getCharacteristics();
      this.ctrl = this.proto.write
        ? chars.find((c) => c.uuid === this.proto.write)
        : chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (!this.ctrl) throw Object.assign(new Error('no writable characteristic'), { code: 'not-light' });
      this.chars = chars.map((c) => ({ id: c.uuid, svc: this.proto.service, uuid: c.uuid, props: Object.keys(c.properties).filter((k) => c.properties[k] === true), ch: c }));
      const n = this.proto.notify && chars.find((c) => c.uuid === this.proto.notify);
      if (n?.properties.notify) {
        n.addEventListener('characteristicvaluechanged', (ev) => {
          const v = ev.target.value;
          this.lastRxAt = Date.now();
          this.logLine(`RX ${toHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`);
        });
        await n.startNotifications().catch((e) => this.logLine(`notify: ${e.message}`));
      }
      device.removeEventListener('gattserverdisconnected', this._onDisc);
      device.addEventListener('gattserverdisconnected', this._onDisc);
      this._sent.clear();
      this._retry = 0;
      this.logLine(`connected: writing to ${this.ctrl.uuid} (${this.ctrl.properties.writeWithoutResponse ? 'without' : 'with'} response). Untested driver: every frame is logged.`);
      this._setStatus('connected');
      this._startKeepAlive();
    } catch (e) {
      this.logLine(`CONNECT FAILED: ${e.name ?? 'Error'}: ${e.message}`);
      try { if (device.gatt.connected) device.gatt.disconnect(); } catch {}
      if (e.code === 'not-light') { this._user = true; this._setStatus('disconnected', 'not a supported light'); this._problem('not-light', e); return; }
      if (auto) { this._setStatus('disconnected', e.message); this._problem('lost', e); return; }
      this._scheduleRetry();
    }
  }

  _startKeepAlive() {
    clearInterval(this._ka);
    const ka = this.proto.keepAlive;
    if (ka) this._ka = setInterval(() => { if (this.connected) this._write(ka.frame(), true); }, ka.ms);
  }

  _lost() {
    clearInterval(this._ka);
    if (this._user) return;
    this.logLine('connection lost');
    this._problem('lost');
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._user || !this.device) return;
    const delay = RETRY_MS[Math.min(this._retry++, RETRY_MS.length - 1)];
    this._setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { if (!this._user) this.connect(this.device); }, delay);
  }

  disconnect() {
    this._user = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._ka);
    try { if (this.device?.gatt.connected) this.device.gatt.disconnect(); } catch {}
    this.logLine('DISCONNECTED');
    this._setStatus('disconnected');
  }

  // ---------- writing ----------

  async _write(bytes, quiet = false, label = '') {
    const c = this.ctrl;
    if (!c) return false;
    const size = this.proto.chunk ?? bytes.length;
    try {
      for (let i = 0; i < bytes.length; i += size) {
        const part = bytes.subarray(i, i + size);
        if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(part); else await c.writeValueWithResponse(part);
      }
      if (!quiet) this.logLine(`TX ${label ? `[${label}] ` : ''}${toHex(bytes)}`);
      return true;
    } catch (e) {
      this.logLine(`TX error [${label}]: ${e.name}: ${e.message}`);
      return false;
    }
  }

  _scale(v) { return Math.max(0, Math.min(100, Math.round(v * this.master))); }

  /** Sends the latest wanted state (later calls while sending coalesce into one). */
  _flush(label, quiet) {
    this._dirty = true;
    this._label = label; this._quiet = quiet;
    if (!this._pump) this._pump = (async () => {
      let ok = true;
      while (this._dirty && this.connected) {
        this._dirty = false;
        const st = { ...this._want, bri: this._scale(this._want.bri) };
        for (const f of this.proto.frames(st, this)) {
          const k = this.proto.key?.(f);
          if (k && this._sent.get(k) === toHex(f)) continue;
          ok = (await this._write(f, this._quiet, this._label)) && ok;
          if (k) this._sent.set(k, toHex(f));
          await sleep(this.proto.gapMs ?? 20);
        }
      }
      this._pump = null;
      return ok;
    })();
    return this._pump;
  }

  _shown(source = 'sent') {
    const w = this._want;
    Object.assign(this.light, { power: w.on, mode: w.mode, brightness: w.bri, cct: w.kelvin, hue: w.hue, saturation: w.sat });
    this.levelBri = w.bri;
    this.dispatchEvent(new CustomEvent('light', { detail: { source } }));
  }

  /** Commands from the driver's encoder (GATT_ENC): [{t, …}]. */
  async sendFrames(cmds, label, { quiet = false } = {}) {
    if (!this.connected || !cmds) return false;
    const w = this._want;
    for (const c of cmds) {
      if (c.t === 'power') w.on = c.on;
      else if (c.t === 'bri') w.bri = c.v;
      else if (c.t === 'cct') { w.kelvin = c.k; w.mode = 'cct'; }
      else if (c.t === 'hue') { w.hue = c.v; w.mode = 'hsi'; }
      else if (c.t === 'sat') { w.sat = c.v; w.mode = 'hsi'; }
      else if (c.t === 'mode') w.mode = c.m === 'hsi' ? 'hsi' : 'cct';
    }
    this._shown();
    return this._flush(label, quiet);
  }

  /** A whole look: {mode, cct, hue, sat, bri}. */
  async applyState(s, { quiet = true } = {}) {
    if (!this.connected) return false;
    const w = this._want;
    if (s.bri != null) w.bri = s.bri;
    if (s.mode) w.mode = s.mode === 'hsi' ? 'hsi' : 'cct';
    if (s.cct != null) w.kelvin = s.cct;
    if (s.hue != null) w.hue = s.hue;
    if (s.sat != null) w.sat = s.sat;
    this._shown();
    return this._flush('look', quiet);
  }

  /** Pre-show check: these lights don't answer, so "acknowledged" means the write went out. */
  async waitAck() { await sleep(150); return this.connected; }

  async setMaster(m) {
    const prev = this.master;
    this.master = Math.max(0, Math.min(1, m));
    if (this.master !== prev && this.connected) await this._flush(`master ${Math.round(this.master * 100)}%`, true);
  }

  /** Raw writes (Debug tab) are not offered for untested lights: only documented frames are sent. */
  async write() { this.logLine('raw writes are not available for this light'); return false; }
}

/** Encoder for GattLightConnection / mesh lights: commands the connection turns into whole-state frames. */
export const STATE_ENC = {
  power: (on) => [{ t: 'power', on }],
  brightness: (v) => [{ t: 'bri', v }],
  cct: (k) => [{ t: 'cct', k }],
  hue: (v) => [{ t: 'hue', v }],
  saturation: (v) => [{ t: 'sat', v }],
  mode: (m) => [{ t: 'mode', m }],
};
