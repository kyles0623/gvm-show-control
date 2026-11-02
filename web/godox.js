// Godox Bluetooth Mesh lights: the same mesh network, setup and shared connection as amaran (amaran.js), with
// Godox's vendor commands (lightproto.js, from binary-person/ha-godox-mesh, MIT). UNTESTED on hardware.
//
// Never sent: FD 04 (arms Bluetooth firmware update on LK8720 lights) or any other FD request than the status
// request FD 01. The frame builders here can't produce them.
import { AmaranConnection, meshHub } from './amaran.js';
import * as P from './lightproto.js';
import * as M from './mesh.js';

const REPLY = (0xf1 << 16) | 0x11 | (0x02 << 8);     // vendor opcode F1 11 02 as mesh.js parseAccess returns it

export class GodoxConnection extends AmaranConnection {
  constructor(opts) {
    super(opts);
    this.label = opts.name ?? 'Godox';
    this._want = { on: true, mode: 'cct', kelvin: 5600, hue: 0, sat: 100, bri: 50 };
  }

  /** Caps of the model chosen for this light (set by the rig). */
  get modelCaps() { return this.caps ?? { cct: [2800, 6500], hsi: false }; }

  _access(frame) { return new Uint8Array([...P.GODOX.OPCODE, ...frame]); }

  async _send(label, quiet) {
    const w = this._want;
    const f = P.godoxFrame({ ...w, bri: this._scale(w.bri) }, this.modelCaps);
    return meshHub.sendAccess(this.node.addr, this._access(f), { label, quiet, from: this });
  }

  async sendFrames(cmds, label, { quiet = false } = {}) {
    if (!this.connected || !cmds) return false;
    const w = this._want;
    let status = false, change = false;
    for (const c of cmds) {
      if (c.t === 'status') { status = true; continue; }
      change = true;
      if (c.t === 'power') w.on = c.on;
      else if (c.t === 'bri') { w.bri = c.v; this.levelBri = c.v; }
      else if (c.t === 'cct') { w.kelvin = c.k; w.mode = 'cct'; }
      else if (c.t === 'hue') { w.hue = c.v; w.mode = 'hsi'; }
      else if (c.t === 'sat') { w.sat = c.v; w.mode = 'hsi'; }
      else if (c.t === 'mode') w.mode = c.m === 'hsi' ? 'hsi' : 'cct';
    }
    let ok = true;
    if (change) {
      ok = await this._send(label, quiet);
      Object.assign(this.light, { power: w.on, mode: w.mode, brightness: w.bri, cct: w.kelvin, hue: w.hue, saturation: w.sat });
      this.dispatchEvent(new CustomEvent('light', { detail: { source: 'sent' } }));
    }
    if (status) ok = (await meshHub.sendAccess(this.node.addr, this._access(P.godoxStatusRequest()), { label: 'status request', quiet: true, from: this })) && ok;
    return ok;
  }

  async applyState(s, { quiet = true } = {}) {
    if (!this.connected) return false;
    const w = this._want;
    if (s.bri != null) { w.bri = s.bri; this.levelBri = s.bri; }
    if (s.mode) w.mode = s.mode === 'hsi' ? 'hsi' : 'cct';
    if (s.cct != null) w.kelvin = s.cct;
    if (s.hue != null) w.hue = s.hue;
    if (s.sat != null) w.sat = s.sat;
    return this.sendFrames([{ t: 'mode', m: w.mode }], 'look', { quiet });
  }

  _onAccess(a) {
    this.lastRxAt = Date.now();
    this.logLine(`RX 0x${a.src.toString(16).padStart(4, '0')} opcode 0x${a.opcode.toString(16)}: ${M.hex(a.params)}`);
    if (a.opcode !== REPLY || a.params.length !== 8) return;
    const st = P.godoxParseStatus(a.params);
    if (!st) return;
    this.lastStatusAt = Date.now();
    // Only brightness (and colour temperature in record A0) is reported; power isn't (off is 0 %).
    if (st.record === 0xa0) {
      const bri = this.master > 0 ? Math.min(100, Math.round(st.bri / this.master)) : st.bri;
      if (this._scale(this.levelBri ?? -1) !== st.bri) this.levelBri = bri;
      this.light.brightness = this.levelBri;
      if (this._want.mode === 'cct' && st.kelvin) this.light.cct = st.kelvin;
      this.dispatchEvent(new CustomEvent('light', { detail: { source: 'status' } }));
    }
    this._statusWaiters?.splice(0).forEach((f) => f(true));
  }

  async setMaster(m) {
    const prev = this.master;
    this.master = Math.max(0, Math.min(1, m));
    if (this.master !== prev && this.connected) await this._send(`master ${Math.round(this.master * 100)}%`, true);
  }
}
