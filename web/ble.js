// Connection layer: pairing, remembered device, auto-reconnect, GATT discovery,
// serialized writes, notification decoding, status echo, session log.
import { GVMProtocol, decode, stateFromFrame, CONTROL_CHAR } from './gvm-protocol.js';

export const SERVICE = '00010203-0405-0607-0809-0a0b0c0d1910';
export const OPTIONAL_SERVICES = ['0000180a-0000-1000-8000-00805f9b34fb', SERVICE];
const LOG_CAP = 500;
const BASE = '-0000-1000-8000-00805f9b34fb';
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const CONNECT_TIMEOUT_MS = 10000;
// The light sends a status frame every ~5 s while connected. If nothing arrives for this long,
// the link is dead even though the OS still reports it connected: drop it and reconnect.
const SILENT_MS = 12000;
const FRAME_GAP_MS = 60;

const OTA_UUIDS = new Set([
  '0000fe59' + BASE, '00001530-1212-efde-1523-785feabcd123', '00001531-1212-efde-1523-785feabcd123',
  '00001532-1212-efde-1523-785feabcd123', '00001534-1212-efde-1523-785feabcd123',
  '8ec90001-f315-4f60-9fb8-838830daea50', '8ec90002-f315-4f60-9fb8-838830daea50',
  '8ec90003-f315-4f60-9fb8-838830daea50', 'f000ffc0-0451-4000-b000-000000000000',
  'f000ffc1-0451-4000-b000-000000000000', 'f000ffc2-0451-4000-b000-000000000000',
  '00010203-0405-0607-0809-0a0b0c0d2b12', '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0',
  'f7bf3564-fb6d-4e53-88a4-5e37e0326063',
]);
const OTA_KEYWORDS = ['dfu', 'ota', 'oad', 'update', 'firmware', 'upgrade', 'bootloader'];

/**
 * Opens the browser's device chooser (must run inside a user gesture).
 * Resolves the chosen device, or rejects with err.problem = 'chooser' | 'adapter'.
 */
export async function chooseDevice({ anyDevice = false, extraServices = [] } = {}) {
  // requestDevice must be called synchronously in the click handler, so the availability
  // check runs in parallel and only adds context if the chooser fails.
  const available = navigator.bluetooth.getAvailability?.().catch(() => true) ?? Promise.resolve(true);
  const optionalServices = [...new Set([...OPTIONAL_SERVICES, ...extraServices])];
  const opts = anyDevice
    ? { acceptAllDevices: true, optionalServices }
    : { filters: [{ namePrefix: 'BT_LED' }, { services: [SERVICE] }], optionalServices };
  try {
    return await navigator.bluetooth.requestDevice(opts);
  } catch (e) {
    e.problem = (await available) === false && !/cancel/i.test(e.message) ? 'adapter' : 'chooser';
    throw e;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (v) => (v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));
export const toHex = (v) => Array.from(bytesOf(v), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
export const shortUuid = (u) => (u.startsWith('0000') && u.endsWith(BASE) ? '0x' + u.slice(4, 8).toUpperCase() : u);

/** Accepts "AA 55 0x10, 1f", "aa55", "AA:55". 1-digit token = one byte. null on invalid. */
export function parseHex(input) {
  const out = [];
  for (let tok of input.split(/[\s,;:\-]+/)) {
    if (!tok) continue;
    if (/^0x/i.test(tok)) tok = tok.slice(2);
    if (!tok || !/^[0-9a-f]+$/i.test(tok)) return null;
    if (tok.length === 1) tok = '0' + tok;
    if (tok.length % 2) return null;
    for (let i = 0; i < tok.length; i += 2) out.push(parseInt(tok.slice(i, i + 2), 16));
  }
  return out.length ? new Uint8Array(out) : null;
}

function isOTALike(svc, uuid, desc) {
  if (OTA_UUIDS.has(svc) || OTA_UUIDS.has(uuid)) return true;
  return OTA_KEYWORDS.some((k) => (desc ?? '').toLowerCase().includes(k));
}

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function ts() {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Events: 'status' (connection status changed), 'light' (light state changed),
 *         'log' (log changed), 'gatt' (characteristics changed).
 * status: unsupported | idle | connecting | connected | reconnecting | disconnected
 */
export class LightConnection extends EventTarget {
  /**
   * @param {{id?: string, name?: string, logger?: (line: string) => void}} opts
   *   id/name: the remembered device; logger: shared log sink (Rig) — otherwise logs locally.
   */
  constructor({ id = null, name = null, logger = null } = {}) {
    super();
    this.id = id;
    this.storedName = name;
    this.logger = logger;
    this.label = name ?? 'BT_LED';
    this.status = navigator.bluetooth ? 'idle' : 'unsupported';
    this.statusDetail = '';
    this.device = null;
    this.ctrl = null;            // control characteristic info
    this.chars = [];             // {id, svc, uuid, props[], ch, userDesc, ota, last}
    this.light = {};             // power, brightness, cct, hue, saturation, mode
    this.lastStatusAt = 0;
    this.lastRxAt = 0;
    this._watchdog = null;
    this.echoStatus = true;
    this.quietStatus = true;
    this.log = [];
    this.full = [];
    this._queue = Promise.resolve();
    this._retry = 0;
    this._retryTimer = null;
    this._userDisconnect = false;
    this._onDisc = (ev) => this._handleDisconnect(ev);
  }

  // ---------- log ----------
  logLine(msg) {
    if (this.logger) { this.logger(`[${this.label}] ${msg}`); return; }
    const line = `${ts()}  ${msg}`;
    this.full.push(line);
    this.log.push(line);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.dispatchEvent(new Event('log'));
  }
  clearLog() { this.log = []; this.dispatchEvent(new Event('log')); }

  /** Reports a user-facing problem; app.js turns the code into a plain-language message. */
  _problem(code, error = null) {
    this.dispatchEvent(new CustomEvent('problem', { detail: { code, error } }));
  }

  _setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    this.dispatchEvent(new Event('status'));
  }

  get rememberedId() { return this.id; }
  get deviceName() { return this.device?.name ?? this.storedName ?? 'BT_LED'; }

  // ---------- connect / reconnect ----------

  async connect(device, { auto = false } = {}) {
    clearTimeout(this._retryTimer);
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisc);
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    }
    this.device = device;
    this._userDisconnect = false;
    device.removeEventListener('gattserverdisconnected', this._onDisc);
    device.addEventListener('gattserverdisconnected', this._onDisc);
    this._setStatus(this._retry ? 'reconnecting' : 'connecting', this._retry ? `attempt ${this._retry + 1}` : '');
    this.logLine(`CONNECT → ${device.name ?? '(unnamed)'} id=${device.id}`);
    try {
      const server = await Promise.race([
        device.gatt.connect(),
        sleep(CONNECT_TIMEOUT_MS).then(() => { throw new Error('connect timeout'); }),
      ]);
      this.logLine('CONNECTED');
      await this._enqueue(() => this._discover(server));
      if (!this.ctrl) { const e = new Error('control characteristic not found'); e.code = 'not-light'; throw e; }
      this._retry = 0;
      this.lastRxAt = Date.now();
      this._startWatchdog();
      this._setStatus('connected');
      await this.sendFrames(GVMProtocol.handshake(), 'handshake');
    } catch (e) {
      this.logLine(`CONNECT FAILED: ${e.name ?? 'Error'}: ${e.message}`);
      if (device.gatt.connected) device.gatt.disconnect();
      if (e.code === 'not-light') {
        this._userDisconnect = true;
        this._setStatus('disconnected', 'not a supported light');
        this._problem('not-light', e);
      } else if (auto || this._retry) {
        if (this._retry === 3) this._problem('retrying', e);
        await this._tryWatchAdvertisements(device);
        this._scheduleReconnect();
      } else {
        this._setStatus('disconnected', 'connect failed');
        this._problem('connect', e);
      }
    }
  }

  async _tryWatchAdvertisements(device) {
    if (!device.watchAdvertisements || device.watchingAdvertisements) return;
    try {
      await device.watchAdvertisements();
      device.addEventListener('advertisementreceived', () => {
        if (this.status === 'reconnecting' && !device.gatt.connected) {
          this.logLine('Advertisement seen: reconnecting now');
          clearTimeout(this._retryTimer);
          this.connect(device);
        }
      }, { once: true });
    } catch { /* not supported without the experimental flag */ }
  }

  _scheduleReconnect() {
    if (this._userDisconnect || !this.device) return;
    const delay = RETRY_DELAYS_MS[Math.min(this._retry, RETRY_DELAYS_MS.length - 1)];
    this._retry++;
    this._setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.connect(this.device), delay);
  }

  /** Reconnects a light that has stopped sending anything (see SILENT_MS). */
  _startWatchdog() {
    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (this.status !== 'connected' || !this.device) return;
      const silent = Date.now() - this.lastRxAt;
      if (silent < SILENT_MS) return;
      clearInterval(this._watchdog);
      this.logLine(`NO RESPONSE for ${Math.round(silent / 1000)}s (status expected every 5s): dropping the link and reconnecting`);
      this.device.removeEventListener('gattserverdisconnected', this._onDisc);   // connect() re-adds it
      try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch {}
      this._handleDisconnect();
    }, 1000);
  }

  _handleDisconnect() {
    clearInterval(this._watchdog);
    this.ctrl = null;
    this.chars = [];
    this.dispatchEvent(new Event('gatt'));
    if (this._userDisconnect) {
      this.logLine('DISCONNECTED');
      this._setStatus('disconnected');
    } else {
      this.logLine('CONNECTION LOST: reconnecting');
      this._problem('lost');
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this._userDisconnect = true;
    clearInterval(this._watchdog);
    clearTimeout(this._retryTimer);
    this._retry = 0;
    if (this.device?.gatt.connected) { this.logLine('DISCONNECT requested'); this.device.gatt.disconnect(); }
    else this._setStatus('disconnected');
  }

  // ---------- discovery ----------

  async _discover(server) {
    this.chars = [];
    this.ctrl = null;
    let services = [];
    try { services = await server.getPrimaryServices(); }
    catch (e) { this.logLine(`No accessible services (${e.name})`); return; }
    for (const svc of services) {
      this.logLine(`SERVICE ${shortUuid(svc.uuid)}`);
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { this.logLine(`  characteristics error: ${e.message}`); }
      for (const ch of chars) {
        const p = ch.properties;
        const props = ['read', 'writeWithoutResponse', 'write', 'notify', 'indicate'].filter((k) => p[k]);
        const info = { id: `${svc.uuid}/${ch.uuid}`, svc: svc.uuid, uuid: ch.uuid, props, ch,
                       userDesc: null, ota: isOTALike(svc.uuid, ch.uuid, null), last: null };
        this.chars.push(info);
        try {
          for (const d of await ch.getDescriptors('gatt.characteristic_user_description')) {
            info.userDesc = new TextDecoder().decode(await d.readValue());
            info.ota = isOTALike(svc.uuid, ch.uuid, info.userDesc);
          }
        } catch {}
        this.logLine(`  CHAR ${shortUuid(ch.uuid)} [${props.join(', ')}]${info.userDesc ? ` "${info.userDesc}"` : ''}${info.ota ? ' [OTA-like: blocked]' : ''}`);
        ch.addEventListener('characteristicvaluechanged', (ev) => this._onValue(info, ev.target.value));
        if ((p.notify || p.indicate) && !info.ota) {
          try { await ch.startNotifications(); } catch (e) { this.logLine(`  SUBSCRIBE error: ${e.message}`); }
        }
        if (p.read && ch.uuid !== CONTROL_CHAR) {
          try { await ch.readValue(); } catch {}
        }
        if (ch.uuid === CONTROL_CHAR) this.ctrl = info;
      }
    }
    this.dispatchEvent(new Event('gatt'));
  }

  _onValue(info, dv) {
    const bytes = new Uint8Array(bytesOf(dv));
    info.last = bytes;
    if (info !== this.ctrl) {
      this.logLine(`RX ${shortUuid(info.uuid)} (${bytes.length}B): ${toHex(bytes)}`);
      this.dispatchEvent(new Event('gatt'));
      return;
    }
    this.lastRxAt = Date.now();
    for (const f of decode(bytes)) {
      if (!(f.isStatus && this.quietStatus)) this.logLine(`RX ${toHex(f.bytes)}  → ${f.text}`);
      if (!f.ok) continue;
      const update = stateFromFrame(f.bytes);
      if (update && Object.keys(update).length) {
        if (f.isStatus) this.lastStatusAt = Date.now();
        Object.assign(this.light, update);
        this.dispatchEvent(new CustomEvent('light', { detail: { source: f.isStatus ? 'status' : 'ack' } }));
      }
      if (f.isStatus && this.echoStatus) {
        this.sendFrames([GVMProtocol.statusEcho(f.bytes)], 'status echo', { quiet: this.quietStatus });
      }
    }
  }

  // ---------- writes ----------

  _enqueue(fn) {
    const p = this._queue.then(fn);
    this._queue = p.catch(() => {});
    return p;
  }

  get connected() { return this.status === 'connected' && !!this.device?.gatt.connected; }

  /** Sends GVMProtocol frames to the control characteristic, in order (writes are spaced by the queue). */
  async sendFrames(frames, label, { quiet = false } = {}) {
    if (frames == null) { this.logLine(`command not implemented: ${label}`); return false; }
    for (let i = 0; i < frames.length; i++) {
      const ok = await this.write(this.ctrl, frames[i], frames.length > 1 ? `${label} ${i + 1}/${frames.length}` : label, quiet);
      if (!ok) return false;
    }
    return true;
  }

  /** Writes raw bytes to a characteristic (default: control). Refuses OTA-like / non-writable targets. */
  async write(info, bytes, label, quiet = false) {
    if (!this.device?.gatt.connected) { if (!quiet) this.logLine(`TX blocked [${label}]: not connected`); return false; }
    if (!info) { this.logLine(`TX blocked [${label}]: no target characteristic`); return false; }
    if (info.ota) { this.logLine(`TX blocked [${label}]: ${info.uuid} looks like OTA/DFU`); return false; }
    const wwr = info.props.includes('writeWithoutResponse');
    if (!wwr && !info.props.includes('write')) { this.logLine(`TX blocked [${label}]: not writable`); return false; }
    return this._enqueue(async () => {
      try {
        // Minimum spacing between any two writes (the official app never sent faster than this).
        const wait = (this._lastWriteAt ?? 0) + FRAME_GAP_MS - performance.now();
        if (wait > 0) await sleep(wait);
        this._lastWriteAt = performance.now();
        if (wwr) await info.ch.writeValueWithoutResponse(bytes);
        else await info.ch.writeValueWithResponse(bytes);
        if (!quiet) this.logLine(`TX [${label}] ${wwr ? 'WWR' : 'WR'} ${shortUuid(info.uuid)}: ${toHex(bytes)}`);
        return true;
      } catch (e) {
        this.logLine(`TX error [${label}]: ${toHex(bytes)}  ${e.name}: ${e.message}`);
        return false;
      }
    });
  }
}
