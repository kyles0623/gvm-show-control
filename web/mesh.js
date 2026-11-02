// Bluetooth Mesh (SIG Mesh Profile 1.0.1) for the browser: the crypto, network/transport PDUs, proxy SAR and
// provisioning PDUs that a mesh light (e.g. amaran) needs. Every format here is from the published Mesh Profile
// specification; nothing is light-specific. Uses WebCrypto only (AES-128, ECDH P-256).
//
// Sections of the spec referenced below: 3.4 network layer, 3.5 lower transport, 3.6 upper transport,
// 3.8 security (s1, k1-k4, nonces, obfuscation), 5 provisioning, 6 proxy protocol.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => new Uint8Array(s.replace(/[^0-9a-f]/gi, '').match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const xor = (a, b) => a.map((x, i) => x ^ b[i]);
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const be24 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const be32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------- AES primitives ----------

const keyCache = new Map();
async function aesKey(key) {
  const k = hex(key);
  let ck = keyCache.get(k);
  if (!ck) { ck = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']); keyCache.set(k, ck); }
  return ck;
}

/** AES-128 of one 16-byte block (AES-CBC with a zero IV, first block = ECB). */
export async function aes(key, block) {
  const out = await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, await aesKey(key), block);
  return new Uint8Array(out, 0, 16);
}

function dbl(b) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = ((b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0)) & 0xff;
  if (b[0] & 0x80) out[15] ^= 0x87;
  return out;
}

/** AES-CMAC (RFC 4493). */
export async function cmac(key, msg) {
  const L = await aes(key, new Uint8Array(16));
  const K1 = dbl(L), K2 = dbl(K1);
  const n = Math.max(1, Math.ceil(msg.length / 16));
  const full = msg.length > 0 && msg.length % 16 === 0;
  let x = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) x = await aes(key, xor(x, msg.subarray(i * 16, i * 16 + 16)));
  const last = new Uint8Array(16);
  last.set(msg.subarray((n - 1) * 16));
  if (!full) last[msg.length - (n - 1) * 16] = 0x80;
  return aes(key, xor(x, xor(last, full ? K1 : K2)));
}

/** AES-CCM (RFC 3610) with a 13-byte nonce, no associated data. Returns ciphertext || MIC. */
export async function ccmEncrypt(key, nonce, pt, micLen) {
  const { mic, s0 } = await ccmMac(key, nonce, pt, micLen);
  const ct = await ctr(key, nonce, pt);
  return concat(ct, xor(mic, s0).subarray(0, micLen));
}

/** Decrypts ciphertext || MIC; returns the plaintext, or null if the MIC doesn't match. */
export async function ccmDecrypt(key, nonce, data, micLen) {
  if (data.length < micLen) return null;
  const ct = data.subarray(0, data.length - micLen), got = data.subarray(data.length - micLen);
  const pt = await ctr(key, nonce, ct);
  const { mic, s0 } = await ccmMac(key, nonce, pt, micLen);
  const want = xor(mic, s0).subarray(0, micLen);
  return want.every((b, i) => b === got[i]) ? pt : null;
}

async function ccmMac(key, nonce, pt, M) {
  const b0 = new Uint8Array(16);
  b0[0] = (((M - 2) / 2) << 3) | 1;            // no AAD, L = 2
  b0.set(nonce, 1);
  b0[14] = pt.length >> 8; b0[15] = pt.length & 0xff;
  let x = await aes(key, b0);
  for (let i = 0; i < pt.length; i += 16) {
    const blk = new Uint8Array(16); blk.set(pt.subarray(i, i + 16));
    x = await aes(key, xor(x, blk));
  }
  return { mic: x.subarray(0, M), s0: (await aes(key, ctrBlock(nonce, 0))).subarray(0, M) };
}
function ctrBlock(nonce, i) { const a = new Uint8Array(16); a[0] = 1; a.set(nonce, 1); a[14] = i >> 8; a[15] = i & 0xff; return a; }
async function ctr(key, nonce, data) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    const s = await aes(key, ctrBlock(nonce, i / 16 + 1));
    for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j] ^ s[j];
  }
  return out;
}

// ---------- key derivation (3.8.2) ----------

export const s1 = (m) => cmac(new Uint8Array(16), typeof m === 'string' ? te.encode(m) : m);
export async function k1(N, salt, P) { const T = await cmac(salt, N); return cmac(T, typeof P === 'string' ? te.encode(P) : P); }
export async function k2(N, P = new Uint8Array([0])) {
  const T = await cmac(await s1('smk2'), N);
  const T1 = await cmac(T, concat(P, [1]));
  const T2 = await cmac(T, concat(T1, P, [2]));
  const T3 = await cmac(T, concat(T2, P, [3]));
  return { nid: T1[15] & 0x7f, encKey: T2, privKey: T3 };
}
export async function k3(N) { const T = await cmac(await s1('smk3'), N); return (await cmac(T, concat(te.encode('id64'), [1]))).subarray(8); }
export async function k4(N) { const T = await cmac(await s1('smk4'), N); return (await cmac(T, concat(te.encode('id6'), [1])))[15] & 0x3f; }

/** Everything derived from a network: netKey, appKey (16 bytes each), ivIndex. */
export async function networkKeys({ netKey, appKey, ivIndex = 0 }) {
  const { nid, encKey, privKey } = await k2(netKey);
  return { netKey, appKey, ivIndex, nid, encKey, privKey, aid: await k4(appKey), networkId: await k3(netKey) };
}

// ---------- nonces (3.8.5) ----------

const netNonce = (ctl, ttl, seq, src, iv) => new Uint8Array([0x00, (ctl << 7) | ttl, ...be24(seq), ...be16(src), 0, 0, ...be32(iv)]);
const appNonce = (type, szmic, seq, src, dst, iv) => new Uint8Array([type, szmic << 7, ...be24(seq), ...be16(src), ...be16(dst), ...be32(iv)]);
const proxyNonce = (seq, src, iv) => new Uint8Array([0x03, 0, ...be24(seq), ...be16(src), 0, 0, ...be32(iv)]);

// ---------- network layer (3.4.4, 3.8.7) ----------

async function pecb(privKey, iv, enc) {
  const blk = new Uint8Array(16);
  blk.set(be32(iv), 5);
  blk.set(enc.subarray(0, 7), 9);
  return aes(privKey, blk);
}

/**
 * Builds a Network PDU. transport = lower transport PDU. ctl=1 for control messages (64-bit NetMIC).
 * proxy=true: a proxy configuration message (proxy nonce, CTL=1, TTL=0, DST=0).
 */
export async function encodeNetwork(k, { ctl = 0, ttl = 7, seq, src, dst, transport, proxy = false }) {
  const micLen = ctl ? 8 : 4;
  const nonce = proxy ? proxyNonce(seq, src, k.ivIndex) : netNonce(ctl, ttl, seq, src, k.ivIndex);
  const enc = await ccmEncrypt(k.encKey, nonce, concat(be16(dst), transport), micLen);
  const p = await pecb(k.privKey, k.ivIndex, enc);
  const hdr = xor(new Uint8Array([(ctl << 7) | ttl, ...be24(seq), ...be16(src)]), p.subarray(0, 6));
  return concat([((k.ivIndex & 1) << 7) | k.nid], hdr, enc);
}

/** Decodes a Network PDU (null if it isn't for this network). proxy=true for proxy configuration messages. */
export async function decodeNetwork(k, pdu, { proxy = false } = {}) {
  if (pdu.length < 14 || (pdu[0] & 0x7f) !== k.nid) return null;
  const enc = pdu.subarray(7);
  const p = await pecb(k.privKey, k.ivIndex, enc);
  const h = xor(pdu.subarray(1, 7), p.subarray(0, 6));
  const ctl = h[0] >> 7, ttl = h[0] & 0x7f, seq = (h[1] << 16) | (h[2] << 8) | h[3], src = (h[4] << 8) | h[5];
  const nonce = proxy ? proxyNonce(seq, src, k.ivIndex) : netNonce(ctl, ttl, seq, src, k.ivIndex);
  const pt = await ccmDecrypt(k.encKey, nonce, enc, ctl ? 8 : 4);
  if (!pt) return null;
  return { ctl, ttl, seq, src, dst: (pt[0] << 8) | pt[1], transport: pt.subarray(2) };
}

// ---------- upper / lower transport (3.5, 3.6) ----------

/** Access message → encrypted upper transport PDU. key: appKey (akf=1) or device key (akf=0). */
export async function encryptAccess(key, akf, { seq, src, dst, iv, access }) {
  return ccmEncrypt(key, appNonce(akf ? 0x01 : 0x02, 0, seq, src, dst, iv), access, 4);
}
export async function decryptAccess(key, akf, { seqAuth, src, dst, iv, upper }) {
  return ccmDecrypt(key, appNonce(akf ? 0x01 : 0x02, 0, seqAuth, src, dst, iv), upper, 4);
}

/**
 * Splits an upper transport PDU into lower transport PDUs: one unsegmented (≤15 bytes) or 12-byte segments.
 * seq = sequence number of the first segment (SeqAuth); returns [{transport}] in order.
 */
export function segmentAccess(upper, { akf, aid, seq }) {
  const h0 = (akf << 6) | (akf ? aid : 0);
  if (upper.length <= 15) return [concat([h0], upper)];
  const n = Math.ceil(upper.length / 12), seqZero = seq & 0x1fff;
  const out = [];
  for (let o = 0; o < n; o++) {
    const v = (0 << 23) | (seqZero << 10) | (o << 5) | (n - 1);   // SZMIC=0 (32-bit TransMIC)
    out.push(concat([0x80 | h0, ...be24(v)], upper.subarray(o * 12, o * 12 + 12)));
  }
  return out;
}

/**
 * Lower transport receive. Returns {kind:'access', akf, aid, seqAuth, upper} for a complete access message,
 * {kind:'control', opcode, params} for an unsegmented control message, {kind:'partial', ack} while segments are
 * still missing (ack: what to send in a Segment Acknowledgment), or null.
 * rx = per-source reassembly state (a Map), net = decoded network PDU.
 */
export function receiveLower(rx, net) {
  const t = net.transport;
  if (!t.length) return null;
  const seg = t[0] >> 7;
  if (net.ctl) {
    if (seg) return null;                                   // segmented control messages aren't used here
    return { kind: 'control', opcode: t[0] & 0x7f, params: t.subarray(1) };
  }
  const akf = (t[0] >> 6) & 1, aid = t[0] & 0x3f;
  if (!seg) return { kind: 'access', akf, aid, seqAuth: net.seq, upper: t.subarray(1) };
  const v = (t[1] << 16) | (t[2] << 8) | t[3];
  const seqZero = (v >> 10) & 0x1fff, segO = (v >> 5) & 0x1f, segN = v & 0x1f;
  // SeqAuth: the full sequence number whose low 13 bits are SeqZero, at or below this segment's seq.
  let seqAuth = (net.seq & ~0x1fff) | seqZero;
  if (seqAuth > net.seq) seqAuth -= 0x2000;
  const key = `${net.src}:${seqZero}`;
  let r = rx.get(key);
  if (!r) { r = { parts: [], got: 0, segN, at: Date.now() }; rx.set(key, r); }
  if (!r.parts[segO]) { r.parts[segO] = t.subarray(4); r.got |= 1 << segO; }
  const all = (2 ** (segN + 1)) - 1;
  const ack = { seqZero, blockAck: r.got >>> 0, src: net.src };
  if ((r.got >>> 0) !== all) return { kind: 'partial', ack };
  rx.delete(key);
  return { kind: 'access', akf, aid, seqAuth, upper: concat(...r.parts), ack };
}

/** Segment Acknowledgment control message (opcode 0x00): OBO=0, SeqZero, BlockAck. */
export const segmentAck = ({ seqZero, blockAck }) => new Uint8Array([0x00, (seqZero >> 6) & 0x7f, (seqZero & 0x3f) << 2, ...be32(blockAck)]);

// ---------- access layer opcodes (3.7.3.1) ----------

export function opcodeBytes(op) {
  if (op < 0x80) return [op];                      // 1-octet
  if (op <= 0xffff) return [op >> 8, op & 0xff];   // 2-octet (0b10xxxxxx ...)
  return [op >> 16, op & 0xff, (op >> 8) & 0xff];  // 3-octet vendor: opcode, company ID (little-endian)
}
export function parseAccess(a) {
  if (!a.length) return null;
  if (a[0] < 0x80) return { opcode: a[0], params: a.subarray(1) };
  if (a[0] < 0xc0) return { opcode: (a[0] << 8) | a[1], params: a.subarray(2) };
  return { opcode: (a[0] << 16) | a[1] | (a[2] << 8), params: a.subarray(3) };
}

// ---------- proxy protocol (6.3) ----------

export const PROXY = { NETWORK: 0x00, BEACON: 0x01, CONFIG: 0x02, PROVISIONING: 0x03 };

/** Splits a proxy PDU into writes of at most `mtu` bytes (SAR: complete / first / continuation / last). */
export function proxySegments(type, data, mtu = 20) {
  const room = mtu - 1;
  if (data.length <= room) return [concat([type], data)];
  const out = [];
  for (let i = 0; i < data.length; i += room) {
    const sar = i === 0 ? 0x40 : i + room >= data.length ? 0xc0 : 0x80;
    out.push(concat([sar | type], data.subarray(i, i + room)));
  }
  return out;
}

/** Reassembles incoming proxy PDUs. push(bytes) → {type, data} when a message is complete, else null. */
export class ProxyReader {
  constructor() { this.buf = null; this.type = null; }
  push(b) {
    const sar = b[0] >> 6, type = b[0] & 0x3f, data = b.subarray(1);
    if (sar === 0) { this.buf = null; return { type, data }; }
    if (sar === 1) { this.buf = [data]; this.type = type; return null; }
    if (!this.buf || type !== this.type) { this.buf = null; return null; }
    this.buf.push(data);
    if (sar === 2) return null;
    const out = { type, data: concat(...this.buf) };
    this.buf = null;
    return out;
  }
}

/** Proxy configuration (6.5): Set Filter Type (0x00), Add Addresses (0x01). Returns the transport PDU. */
export const proxyConfig = {
  setFilterType: (type) => new Uint8Array([0x00, type]),          // 0x00 accept (white) list
  addAddresses: (addrs) => new Uint8Array([0x01, ...addrs.flatMap(be16)]),
};

/** Secure Network Beacon (3.9.3): {flags, networkId, ivIndex} (authentication not checked here). */
export function parseBeacon(d) {
  if (d.length < 22 || d[0] !== 0x01) return null;
  return { flags: d[1], networkId: d.subarray(2, 10), ivIndex: ((d[10] << 24) | (d[11] << 16) | (d[12] << 8) | d[13]) >>> 0 };
}

// ---------- provisioning (5.4) ----------

export const PROV = { INVITE: 0, CAPABILITIES: 1, START: 2, PUBLIC_KEY: 3, INPUT_COMPLETE: 4, CONFIRMATION: 5, RANDOM: 6, DATA: 7, COMPLETE: 8, FAILED: 9 };
export const PROV_ERRORS = ['prohibited', 'invalid PDU', 'invalid format', 'unexpected PDU', 'confirmation failed', 'out of resources', 'decryption failed', 'unexpected error', 'cannot assign addresses'];

export function parseCapabilities(p) {
  return {
    elements: p[0], algorithms: (p[1] << 8) | p[2], publicKeyType: p[3], staticOobType: p[4],
    outputOobSize: p[5], outputOobAction: (p[6] << 8) | p[7], inputOobSize: p[8], inputOobAction: (p[9] << 8) | p[10],
  };
}

/** A provisioner key pair: {priv, pub (64 bytes X||Y)}. */
export async function provisionerKeys() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));   // 0x04 || X || Y
  return { priv: kp.privateKey, pub: raw.subarray(1) };
}
export async function ecdhSecret(priv, devPub64) {
  const pub = await subtle.importKey('raw', concat([0x04], devPub64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

/**
 * The provisioning math (5.4.2.4-5.4.2.5) for No OOB authentication (AuthValue = 16 zero bytes).
 * inputs = Invite params || Capabilities params || Start params || provisioner pub || device pub.
 */
export async function provisioningCrypto({ inputs, secret }) {
  const confSalt = await s1(inputs);
  const confKey = await k1(secret, confSalt, 'prck');
  const auth = new Uint8Array(16);
  return {
    confirmation: (random) => cmac(confKey, concat(random, auth)),
    async session(provRandom, devRandom) {
      const provSalt = await s1(concat(confSalt, provRandom, devRandom));
      return {
        sessionKey: await k1(secret, provSalt, 'prsk'),
        nonce: (await k1(secret, provSalt, 'prsn')).subarray(3),
        devKey: await k1(secret, provSalt, 'prdk'),
      };
    },
  };
}

/** Provisioning Data plaintext: NetKey, key index, flags, IV index, unicast address (25 bytes). */
export const provisioningData = ({ netKey, keyIndex = 0, flags = 0, ivIndex = 0, unicast }) =>
  concat(netKey, be16(keyIndex), [flags], be32(ivIndex), be16(unicast));

// ---------- Configuration messages (4.3.2) ----------

export const CFG = {
  APPKEY_ADD: 0x00, APPKEY_STATUS: 0x8003,
  COMPOSITION_GET: 0x8008, COMPOSITION_STATUS: 0x02,
  MODEL_APP_BIND: 0x803d, MODEL_APP_STATUS: 0x803e,
};
const keyIndexes = (net, app) => [net & 0xff, ((net >> 8) & 0x0f) | ((app & 0x0f) << 4), (app >> 4) & 0xff];
export const cfg = {
  appKeyAdd: (appKey, net = 0, app = 0) => concat(opcodeBytes(CFG.APPKEY_ADD), keyIndexes(net, app), appKey),
  compositionGet: (page = 0) => new Uint8Array([...opcodeBytes(CFG.COMPOSITION_GET), page]),
  /** model: SIG model (16-bit) or vendor model {company, id}. */
  modelAppBind: (element, model, app = 0) => new Uint8Array([
    ...opcodeBytes(CFG.MODEL_APP_BIND), element & 0xff, element >> 8, app & 0xff, app >> 8,
    ...(typeof model === 'number' ? [model & 0xff, model >> 8] : [model.company & 0xff, model.company >> 8, model.id & 0xff, model.id >> 8]),
  ]),
};

/** Composition Data page 0 (4.2.1.1) → {cid, pid, vid, features, elements: [{loc, sig: [ids], vendor: [{company,id}]}]}. */
export function parseComposition(p) {
  const u16 = (i) => p[i] | (p[i + 1] << 8);
  const out = { page: p[0], cid: u16(1), pid: u16(3), vid: u16(5), crpl: u16(7), features: u16(9), elements: [] };
  let i = 11;
  while (i + 4 <= p.length) {
    const loc = u16(i), ns = p[i + 2], nv = p[i + 3];
    i += 4;
    const sig = [], vendor = [];
    for (let j = 0; j < ns && i + 2 <= p.length; j++, i += 2) sig.push(u16(i));
    for (let j = 0; j < nv && i + 4 <= p.length; j++, i += 4) vendor.push({ company: u16(i), id: u16(i + 2) });
    out.elements.push({ loc, sig, vendor });
  }
  return out;
}
