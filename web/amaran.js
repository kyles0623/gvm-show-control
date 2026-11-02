// amaran (Sidus) lights over Bluetooth Mesh: the app sets the light up in its own mesh network (provisioning),
// adds and binds an application key, then sends the light's "Telink 0x26" commands through the light's
// Mesh Proxy service. Same interface as LightConnection (ble.js), so the rest of the app is unchanged.
//
// Status: UNTESTED on hardware. Mesh formats are from the Bluetooth Mesh Profile spec (mesh.js, tested against the
// spec's sample data); the light commands are from wesbos/amaran-BLE-control (telink.js). Each step logs what it
// sends and receives so it can be checked on the real light. Nothing is written to firmware-update characteristics.
import * as M from './mesh.js';
import * as T from './telink.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid16 = (x) => `0000${x}-0000-1000-8000-00805f9b34fb`;
export const MESH_UUIDS = {
  PROV_SERVICE: uuid16('1827'), PROV_IN: uuid16('2adb'), PROV_OUT: uuid16('2adc'),
  PROXY_SERVICE: uuid16('1828'), PROXY_IN: uuid16('2add'), PROXY_OUT: uuid16('2ade'),
};
const SRC = 0x0001;                 // this app's address in its network
const TTL = 7;
const STORE_KEY = 'gvm.mesh';
const POLL_MS = 5000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

// ---------- the app's mesh network (keys, addresses, sequence number), kept in this browser ----------

export class MeshStore {
  constructor(storage = globalThis.localStorage) { this.s = storage; this.load(); }
  load() {
    let d = null;
    try { d = JSON.parse(this.s.getItem(STORE_KEY)); } catch {}
    this.d = d && d.netKey ? d : null;
  }
  get exists() { return !!this.d; }
  /** Creates the network on first use: random NetKey and AppKey, IV index 0, provisioner address 0x0001. */
  ensure() {
    if (!this.d) {
      this.d = { netKey: M.hex(M.randomBytes(16)), appKey: M.hex(M.randomBytes(16)), ivIndex: 0, seq: 1, nextAddr: 0x0002, nodes: {} };
      this.save();
    }
    return this.d;
  }
  save() { try { this.s.setItem(STORE_KEY, JSON.stringify(this.d)); } catch {} }
  node(deviceId) { return this.d?.nodes[deviceId] ?? null; }
  /** The next sequence number (saved every time: a reused number makes the light ignore the message). */
  nextSeq() { const d = this.ensure(); const s = d.seq; d.seq = (d.seq + 1) & 0xffffff; this.save(); return s; }
}
export const meshStore = new MeshStore();

// ---------- connection ----------

export class AmaranConnection extends EventTarget {
  constructor({ id, name, logger }) {
    super();
    this.id = id;
    this.label = name ?? 'amaran';
    this.logger = logger;
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
    this.master = 1;
    this.levelBri = null;
    this.noReply = false;
    this.confirmSetup = null;     // async (conn) => boolean: asked before the light is set up (set by the rig)
    this._retry = 0;
    this._queue = Promise.resolve();
    this._rx = new Map();
    this._reader = new M.ProxyReader();
    this._waiters = [];
    this._onDisc = () => this._handleDisconnect();
    this._want = { on: true, mode: 'cct', kelvin: 5600, hue: 0, sat: 100, bri: 50 };
  }

  logLine(msg) { this.logger?.(`[${this.label}] ${msg}`); }
  _setStatus(status, detail = '') { this.status = status; this.statusDetail = detail; this.dispatchEvent(new Event('status')); }
  _problem(code, error = null) { this.dispatchEvent(new CustomEvent('problem', { detail: { code, error } })); }
  get connected() { return this.status === 'connected' && !!this.device?.gatt.connected; }
  get wanted() { return { ...this.light, brightness: this.levelBri ?? this.light.brightness }; }
  get node() { return meshStore.node(this.id); }

  // ---------- connect ----------

  async connect(device, { auto = false } = {}) {
    clearTimeout(this._retryTimer);
    this.device = device;
    this._userDisconnect = false;
    device.removeEventListener('gattserverdisconnected', this._onDisc);
    device.addEventListener('gattserverdisconnected', this._onDisc);
    this._setStatus(this._retry ? 'reconnecting' : 'connecting');
    this.logLine(`CONNECT → ${device.name ?? '(unnamed)'} id=${device.id}`);
    try {
      let server = await this._gatt(device);
      let proxy = await server.getPrimaryService(MESH_UUIDS.PROXY_SERVICE).catch(() => null);
      if (!proxy) {
        const prov = await server.getPrimaryService(MESH_UUIDS.PROV_SERVICE).catch(() => null);
        if (!prov) { const e = new Error('no Bluetooth Mesh service'); e.code = 'not-light'; throw e; }
        // Not in any network yet: set it up in this app's network (asks first; it leaves the amaran app).
        if (auto) { const e = new Error('this light needs setting up: pair it again'); e.code = 'needs-setup'; throw e; }
        if (!(await this.confirmSetup?.(this))) { const e = new Error('setup cancelled'); e.code = 'cancelled'; throw e; }
        await this._provision(server, prov);
        server = await this._reconnectAfterSetup(device);
        proxy = await server.getPrimaryService(MESH_UUIDS.PROXY_SERVICE);
      }
      if (!this.node) {
        const e = new Error('this light is in another app’s mesh network (amaran app?). Hold “Press to Reset” in the light’s Bluetooth menu, then pair it again');
        e.code = 'mesh-foreign'; throw e;
      }
      await this._openProxy(proxy);
      if (!this.node.configured) await this._configure();
      this._retry = 0;
      this._setStatus('connected');
      this._startPoll();
      this.requestStatus();
    } catch (e) {
      this.logLine(`CONNECT FAILED: ${e.name ?? 'Error'}: ${e.message}`);
      this._settingUp = false;
      try { if (device.gatt.connected) device.gatt.disconnect(); } catch {}
      if (['not-light', 'mesh-foreign', 'needs-setup', 'cancelled'].includes(e.code)) {
        this._userDisconnect = true;
        this._setStatus('disconnected', e.code === 'not-light' ? 'not a supported light' : e.message);
        if (e.code !== 'cancelled') this._problem(e.code === 'not-light' ? 'not-light' : 'mesh', e);
      } else if (auto || this._retry) {
        this._scheduleReconnect();
      } else {
        this._setStatus('disconnected', 'connect failed');
        this._problem('mesh', e);
      }
    }
  }

  async _gatt(device) {
    return Promise.race([device.gatt.connect(), sleep(10000).then(() => { throw new Error('connect timeout'); })]);
  }

  _scheduleReconnect() {
    if (this._userDisconnect || !this.device) return;
    const delay = RETRY_DELAYS_MS[Math.min(this._retry, RETRY_DELAYS_MS.length - 1)];
    this._retry++;
    this._setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
    this._retryTimer = setTimeout(() => this.connect(this.device), delay);
  }

  _handleDisconnect() {
    clearInterval(this._poll);
    this.ctrl = null; this.chars = [];
    this.dispatchEvent(new Event('gatt'));
    if (this._settingUp) return;                       // the light restarts after setup: expected
    if (this._userDisconnect) { this.logLine('DISCONNECTED'); this._setStatus('disconnected'); return; }
    this.logLine('CONNECTION LOST: reconnecting');
    this._problem('lost');
    this._scheduleReconnect();
  }

  disconnect() {
    this._userDisconnect = true;
    clearInterval(this._poll);
    clearTimeout(this._retryTimer);
    this._retry = 0;
    if (this.device?.gatt.connected) { this.logLine('DISCONNECT requested'); this.device.gatt.disconnect(); }
    else this._setStatus('disconnected');
  }

  // ---------- writes ----------

  /** Serialized writes of one proxy PDU (split into 20-byte writes). */
  _write(ch, type, data, label) {
    const parts = M.proxySegments(type, data, 20);
    const job = this._queue.then(async () => {
      for (const p of parts) { await ch.writeValueWithoutResponse(p); await sleep(15); }
      if (label) this.logLine(`TX ${label} (${parts.length} write${parts.length > 1 ? 's' : ''})`);
      return true;
    }).catch((e) => { this.logLine(`TX error [${label}]: ${e.name}: ${e.message}`); return false; });
    this._queue = job;
    return job;
  }

  _waitFor(match, ms) {
    return new Promise((resolve) => {
      const w = { match, done: (v) => { clearTimeout(w.t); this._waiters = this._waiters.filter((x) => x !== w); resolve(v); } };
      w.t = setTimeout(() => w.done(null), ms);
      this._waiters.push(w);
    });
  }
  _deliver(msg) { for (const w of [...this._waiters]) if (w.match(msg)) w.done(msg); }

  // ---------- provisioning (Mesh Profile 5.4, PB-GATT) ----------

  async _provision(server, svc) {
    this._settingUp = true;
    const store = meshStore.ensure();
    const keys = await M.networkKeys({ netKey: M.unhex(store.netKey), appKey: M.unhex(store.appKey), ivIndex: store.ivIndex });
    const pin = await svc.getCharacteristic(MESH_UUIDS.PROV_IN), pout = await svc.getCharacteristic(MESH_UUIDS.PROV_OUT);
    const reader = new M.ProxyReader(), inbox = [];
    let wake = null;
    pout.addEventListener('characteristicvaluechanged', (ev) => {
      const b = new Uint8Array(ev.target.value.buffer.slice(ev.target.value.byteOffset, ev.target.value.byteOffset + ev.target.value.byteLength));
      const m = reader.push(b);
      if (m && m.type === M.PROXY.PROVISIONING) { inbox.push(m.data); wake?.(); }
    });
    await pout.startNotifications();
    const send = (pdu, label) => this._write(pin, M.PROXY.PROVISIONING, new Uint8Array(pdu), `provisioning: ${label}`);
    const recv = async (type, ms = 15000) => {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(() => true);
        if (i >= 0) {
          const p = inbox.splice(i, 1)[0];
          if (p[0] === M.PROV.FAILED) throw new Error(`the light refused setup: ${M.PROV_ERRORS[p[1]] ?? p[1]}`);
          if (p[0] === type) { this.logLine(`RX provisioning: type ${type} (${p.length - 1} bytes)`); return p.subarray(1); }
          this.logLine(`RX provisioning: unexpected type ${p[0]}`);
          continue;
        }
        if (Date.now() > end) throw new Error(`setup: no answer from the light (step ${type})`);
        await new Promise((r) => { wake = r; setTimeout(r, 250); });
      }
    };

    this.logLine('SETUP: joining the light to this app’s mesh network');
    const invite = [5];                                          // attention timer 5 s (the light may blink)
    await send([M.PROV.INVITE, ...invite], 'invite');
    const capsP = await recv(M.PROV.CAPABILITIES);
    const caps = M.parseCapabilities(capsP);
    this.logLine(`SETUP: capabilities ${JSON.stringify(caps)}`);
    if (!(caps.algorithms & 1)) throw new Error('the light doesn’t offer the standard P-256 setup');
    const start = [0, 0, 0, 0, 0];                                // P-256, no OOB public key, no OOB authentication
    await send([M.PROV.START, ...start], 'start');
    const mine = await M.provisionerKeys();
    await send([M.PROV.PUBLIC_KEY, ...mine.pub], 'public key');
    const devPub = await recv(M.PROV.PUBLIC_KEY, 30000);
    const secret = await M.ecdhSecret(mine.priv, devPub);
    const pc = await M.provisioningCrypto({ inputs: M.concat(invite, capsP, start, mine.pub, devPub), secret });
    const myRandom = M.randomBytes(16);
    await send([M.PROV.CONFIRMATION, ...(await pc.confirmation(myRandom))], 'confirmation');
    const devConf = await recv(M.PROV.CONFIRMATION);
    await send([M.PROV.RANDOM, ...myRandom], 'random');
    const devRandom = await recv(M.PROV.RANDOM);
    if (M.hex(await pc.confirmation(devRandom)) !== M.hex(devConf)) throw new Error('setup: the light’s confirmation didn’t match');
    const sess = await pc.session(myRandom, devRandom);
    const addr = store.nextAddr;
    const data = M.provisioningData({ netKey: keys.netKey, ivIndex: store.ivIndex, unicast: addr });
    await send([M.PROV.DATA, ...(await M.ccmEncrypt(sess.sessionKey, sess.nonce, data, 8))], 'data');
    await recv(M.PROV.COMPLETE);
    store.nodes[this.id] = { addr, elements: caps.elements, devKey: M.hex(sess.devKey), configured: false, at: new Date().toISOString() };
    store.nextAddr = addr + Math.max(1, caps.elements);
    meshStore.save();
    this.logLine(`SETUP: done. The light is node 0x${addr.toString(16).padStart(4, '0')} (${caps.elements} element(s))`);
  }

  /** After setup the light restarts and comes back with the Mesh Proxy service. */
  async _reconnectAfterSetup(device) {
    try { if (device.gatt.connected) device.gatt.disconnect(); } catch {}
    await sleep(2000);
    for (let i = 0; i < 10; i++) {
      try {
        const server = await this._gatt(device);
        if (await server.getPrimaryService(MESH_UUIDS.PROXY_SERVICE).catch(() => null)) { this._settingUp = false; return server; }
        device.gatt.disconnect();
      } catch {}
      await sleep(1500);
    }
    this._settingUp = false;
    throw new Error('the light didn’t come back after setup: switch it off and on, then Connect');
  }

  // ---------- proxy ----------

  async _openProxy(svc) {
    const store = meshStore.ensure();
    this.keys = await M.networkKeys({ netKey: M.unhex(store.netKey), appKey: M.unhex(store.appKey), ivIndex: store.ivIndex });
    this.devKey = M.unhex(this.node.devKey);
    this._in = await svc.getCharacteristic(MESH_UUIDS.PROXY_IN);
    const out = await svc.getCharacteristic(MESH_UUIDS.PROXY_OUT);
    this.chars = [
      { id: 'proxy-in', svc: MESH_UUIDS.PROXY_SERVICE, uuid: MESH_UUIDS.PROXY_IN, props: ['writeWithoutResponse'], ch: this._in },
      { id: 'proxy-out', svc: MESH_UUIDS.PROXY_SERVICE, uuid: MESH_UUIDS.PROXY_OUT, props: ['notify'], ch: out },
    ];
    this.dispatchEvent(new Event('gatt'));
    out.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      this._onNotify(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await out.startNotifications();
    await sleep(500);
    // Accept list: messages to this app (0x0001) and from the light's elements are forwarded to us.
    const set = this._waitFor((m) => m.kind === 'proxy-config', 2000);
    await this._sendProxyConfig(M.proxyConfig.setFilterType(0x00), 'proxy filter: accept list');
    this.logLine((await set) ? 'proxy filter status received' : 'no proxy filter status (continuing)');
    await this._sendProxyConfig(M.proxyConfig.addAddresses([SRC]), 'proxy filter: add 0x0001');
  }

  async _sendProxyConfig(transport, label) {
    const pdu = await M.encodeNetwork(this.keys, { ctl: 1, ttl: 0, seq: meshStore.nextSeq(), src: SRC, dst: 0, transport, proxy: true });
    return this._write(this._in, M.PROXY.CONFIG, pdu, label);
  }

  /** Sends an access message to `dst`: app key (akf=1) or the light's device key (akf=0). */
  async _sendAccess(dst, access, { akf = 1, label, quiet = false } = {}) {
    const k = this.keys;
    const seq = meshStore.nextSeq();
    const upper = await M.encryptAccess(akf ? k.appKey : this.devKey, akf, { seq, src: SRC, dst, iv: k.ivIndex, access });
    const lowers = M.segmentAccess(upper, { akf, aid: k.aid, seq });
    let ok = true;
    for (let i = 0; i < lowers.length; i++) {
      const s = i === 0 ? seq : meshStore.nextSeq();
      const net = await M.encodeNetwork(k, { ctl: 0, ttl: TTL, seq: s, src: SRC, dst, transport: lowers[i] });
      ok = (await this._write(this._in, M.PROXY.NETWORK, net, quiet ? null : `${label} → 0x${dst.toString(16).padStart(4, '0')}: ${M.hex(access)}`)) && ok;
    }
    return ok;
  }

  async _sendControl(dst, transport) {
    const net = await M.encodeNetwork(this.keys, { ctl: 1, ttl: TTL, seq: meshStore.nextSeq(), src: SRC, dst, transport });
    return this._write(this._in, M.PROXY.NETWORK, net, null);
  }

  async _onNotify(bytes) {
    const m = this._reader.push(bytes);
    if (!m) return;
    this.lastRxAt = Date.now();
    if (m.type === M.PROXY.BEACON) {
      const b = M.parseBeacon(m.data);
      if (b && this.keys && M.hex(b.networkId) === M.hex(this.keys.networkId) && b.ivIndex !== this.keys.ivIndex) {
        this.logLine(`network beacon: IV index ${b.ivIndex}`);
        this.keys.ivIndex = b.ivIndex; meshStore.d.ivIndex = b.ivIndex; meshStore.save();
      }
      return;
    }
    if (!this.keys) return;
    if (m.type === M.PROXY.CONFIG) {
      const d = await M.decodeNetwork(this.keys, m.data, { proxy: true });
      if (d) { this.logLine(`RX proxy filter status ${M.hex(d.transport)}`); this._deliver({ kind: 'proxy-config' }); }
      return;
    }
    if (m.type !== M.PROXY.NETWORK) return;
    const net = await M.decodeNetwork(this.keys, m.data);
    if (!net || net.dst !== SRC) return;
    // The mesh relays every light's replies to 0x0001 through every proxy: only this light's elements count here
    // (otherwise one light takes on another's color, seen with two Ace 25c lights).
    const node = this.node;
    if (!node || net.src < node.addr || net.src >= node.addr + Math.max(1, node.elements ?? 1)) return;
    const low = M.receiveLower(this._rx, net);
    if (!low) return;
    if (low.ack) await this._sendControl(net.src, M.segmentAck(low.ack));
    if (low.kind !== 'access') return;
    const key = low.akf ? this.keys.appKey : this.devKey;
    const access = await M.decryptAccess(key, low.akf, { seqAuth: low.seqAuth, src: net.src, dst: net.dst, iv: this.keys.ivIndex, upper: low.upper });
    if (!access) { this.logLine(`RX from 0x${net.src.toString(16)}: couldn’t decrypt`); return; }
    const a = M.parseAccess(access);
    this.logLine(`RX 0x${net.src.toString(16).padStart(4, '0')} opcode 0x${a.opcode.toString(16)}: ${M.hex(a.params)}`);
    this._deliver({ kind: 'access', src: net.src, ...a });
    // The light's state, if this is a status payload (checked by its checksum).
    if (a.params.length >= 10) {
      const st = T.decodeStatus(a.params.subarray(a.params.length - 10));
      if (st) this._onStatus(st, a.params);
    }
  }

  _onStatus(st, raw) {
    this.lastStatusAt = Date.now();
    this.lastStatus = M.hex(raw);
    // Brightness the light reports is after the grand master; the app shows the level before it.
    const bri = Math.round(st.intensity / 10);
    if (this.levelBri == null || this._scale(this.levelBri) !== bri) this.levelBri = this.master > 0 ? Math.min(100, Math.round(bri / this.master)) : bri;
    Object.assign(this.light, { power: st.on, mode: st.mode, brightness: this.levelBri });
    if (st.mode === 'cct') this.light.cct = st.kelvin; else { this.light.hue = st.hue; this.light.saturation = st.sat; }
    Object.assign(this._want, { on: st.on, mode: st.mode, bri: this.light.brightness, ...(st.mode === 'cct' ? { kelvin: st.kelvin } : { hue: st.hue, sat: st.sat }) });
    this.dispatchEvent(new CustomEvent('light', { detail: { source: 'status' } }));
    this._deliver({ kind: 'status' });
  }

  // ---------- configuration (app key + model bindings), once after setup ----------

  async _configure() {
    const node = this.node, a = node.addr;
    this.logLine('SETUP: adding the app key');
    let st = null;
    for (let i = 0; i < 3 && !st; i++) {
      const w = this._waitFor((m) => m.kind === 'access' && m.opcode === M.CFG.APPKEY_STATUS, 3000);
      await this._sendAccess(a, M.cfg.appKeyAdd(this.keys.appKey), { akf: 0, label: 'Config AppKey Add' });
      st = await w;
    }
    if (!st) throw new Error('setup: the light didn’t confirm the app key');
    this.logLine(`SETUP: app key status ${st.params[0]}`);
    const cw = this._waitFor((m) => m.kind === 'access' && m.opcode === M.CFG.COMPOSITION_STATUS, 5000);
    await this._sendAccess(a, M.cfg.compositionGet(0), { akf: 0, label: 'Config Composition Data Get' });
    const comp = await cw;
    let elements = [];
    if (comp) {
      const c = M.parseComposition(comp.params);
      this.logLine(`SETUP: composition company 0x${c.cid.toString(16)} product 0x${c.pid.toString(16)} version 0x${c.vid.toString(16)}: ${c.elements.map((e, i) => `element ${i}: SIG ${e.sig.map((x) => x.toString(16)).join(',')} vendor ${e.vendor.map((v) => `${v.company.toString(16)}:${v.id.toString(16)}`).join(',')}`).join(' · ')}`);
      elements = c.elements;
      node.composition = { cid: c.cid, pid: c.pid, vid: c.vid, elements: c.elements };
    } else this.logLine('SETUP: no composition data (continuing without model bindings)');
    // Bind the app key to every model except Configuration Server/Client, so whichever one handles the light's
    // commands accepts them.
    for (let i = 0; i < elements.length; i++) {
      for (const model of [...elements[i].sig.filter((x) => x > 0x0001), ...elements[i].vendor]) {
        const w = this._waitFor((m) => m.kind === 'access' && m.opcode === M.CFG.MODEL_APP_STATUS, 2500);
        await this._sendAccess(a, M.cfg.modelAppBind(a + i, model), { akf: 0, label: 'Config Model App Bind', quiet: true });
        const r = await w;
        this.logLine(`SETUP: bind ${typeof model === 'number' ? model.toString(16) : `${model.company.toString(16)}:${model.id.toString(16)}`} on element ${i}: ${r ? `status ${r.params[0]}` : 'no answer'}`);
      }
    }
    node.configured = true;
    meshStore.save();
  }

  // ---------- light commands ----------

  _scale(v) { return Math.max(0, Math.min(100, Math.round(v * this.master))); }
  _intensity() { return this._scale(this._want.bri) * 10; }

  /** Commands from the driver's encoder: [{t, ...}] (see AMARAN_ENC). */
  async sendFrames(cmds, label, { quiet = false } = {}) {
    if (!this.connected || !cmds) return false;
    const w = this._want;
    let ok = true;
    for (const c of cmds) {
      let payload;
      if (c.t === 'power') { w.on = c.on; payload = T.onoff(c.on); }
      else if (c.t === 'bri') { w.bri = c.v; this.levelBri = c.v; payload = T.brightness(this._intensity()); }
      else if (c.t === 'cct') { w.kelvin = c.k; w.mode = 'cct'; payload = T.cct(w.kelvin, this._intensity()); }
      else if (c.t === 'hue' || c.t === 'sat') { if (c.t === 'hue') w.hue = c.v; else w.sat = c.v; w.mode = 'hsi'; payload = T.hsi(w.hue, w.sat, this._intensity()); }
      else if (c.t === 'mode') { w.mode = c.m === 'hsi' ? 'hsi' : 'cct'; payload = w.mode === 'hsi' ? T.hsi(w.hue, w.sat, this._intensity()) : T.cct(w.kelvin, this._intensity()); }
      else if (c.t === 'status') payload = T.statusRequest();
      else continue;
      ok = (await this._sendAccess(this.node.addr, new Uint8Array([T.OPCODE, ...payload]), { label: `${label} [${c.t}]`, quiet })) && ok;
    }
    // No acknowledgment comes back for these: show what was sent.
    Object.assign(this.light, { power: w.on, mode: w.mode, brightness: w.bri, cct: w.kelvin, hue: w.hue, saturation: w.sat });
    this.dispatchEvent(new CustomEvent('light', { detail: { source: 'sent' } }));
    return ok;
  }

  /** A whole look in one message (white or color carries the intensity): {mode, cct, hue, sat, bri}. */
  async applyState(s, { quiet = true } = {}) {
    if (!this.connected) return false;
    const w = this._want;
    if (s.bri != null) { w.bri = s.bri; this.levelBri = s.bri; }
    if (s.mode) w.mode = s.mode === 'hsi' ? 'hsi' : 'cct';
    if (s.cct != null) w.kelvin = s.cct;
    if (s.hue != null) w.hue = s.hue;
    if (s.sat != null) w.sat = s.sat;
    const L = this.light;
    const same = L.mode === w.mode && L.brightness === w.bri && (w.mode === 'hsi' ? L.hue === w.hue && L.saturation === w.sat : L.cct === w.kelvin);
    if (same) return true;
    // Only brightness changed: the short brightness command; otherwise the full white / color command.
    const onlyBri = L.mode === w.mode && (w.mode === 'hsi' ? L.hue === w.hue && L.saturation === w.sat : L.cct === w.kelvin);
    return this.sendFrames([onlyBri ? { t: 'bri', v: w.bri } : { t: 'mode', m: w.mode }], 'look', { quiet });
  }

  requestStatus() { return this.connected ? this.sendFrames([{ t: 'status' }], 'status request', { quiet: true }) : false; }
  _startPoll() { clearInterval(this._poll); this._poll = setInterval(() => this.requestStatus(), POLL_MS); }

  /** Pre-show check: asks the light for its state; true if it answers within ms. */
  async waitAck(_param, ms = 1500) {
    const w = this._waitFor((m) => m.kind === 'status', ms);
    await this.requestStatus();
    return !!(await w);
  }

  async setMaster(m) {
    const prev = this.master;
    this.master = Math.max(0, Math.min(1, m));
    if (this.master !== prev && this.connected) await this.sendFrames([{ t: 'bri', v: this._want.bri }], `master ${Math.round(this.master * 100)}%`, { quiet: true });
  }

  /** Raw write (Debug tab): not offered for mesh lights. */
  async write() { this.logLine('raw writes are not available for mesh lights'); return false; }
}

/** The amaran driver's encoder: commands the connection turns into Telink payloads with the current state. */
export const AMARAN_ENC = {
  power: (on) => [{ t: 'power', on }],
  brightness: (v) => [{ t: 'bri', v }],
  cct: (k) => [{ t: 'cct', k }],
  hue: (v) => [{ t: 'hue', v }],
  saturation: (v) => [{ t: 'sat', v }],
  mode: (m) => [{ t: 'mode', m }],
};
