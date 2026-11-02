// Bluetooth Mesh crypto + PDU layer (web/mesh.js). Vectors: Mesh Profile spec 8.1 sample data, and the
// independently checked amaran keys published by wesbos/amaran-BLE-control (MIT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import * as M from '../web/mesh.js';

const h = M.hex, u = M.unhex;

test('AES-CMAC: RFC 4493 examples', async () => {
  const key = u('2b7e151628aed2a6abf7158809cf4f3c');
  assert.equal(h(await M.cmac(key, new Uint8Array())), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(h(await M.cmac(key, u('6bc1bee22e409f96e93d7e117393172a'))), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(h(await M.cmac(key, u('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'))), 'dfa66747de9ae63030ca32611497c827');
});

test('s1, k1, k2, k3, k4: Mesh Profile 8.1 sample data', async () => {
  assert.equal(h(await M.s1('test')), 'b73cefbd641ef2ea598c2b6efb62f79c');
  assert.equal(h(await M.k1(u('3216d1509884b533248541792b877f98'), u('2ba14ffa0df84a2831938d57d276cab4'), u('5a09d60797eeb4478aada59db3352a0d'))), 'f6ed15a8934afbe7d83e8dcb57fcf5d7');
  const k2 = await M.k2(u('f7a2a44f8e8a8029064f173ddc1e2b00'));
  assert.equal(k2.nid, 0x7f);
  assert.equal(h(k2.encKey), '9f589181a0f50de73c8070c7a6d27f46');
  assert.equal(h(k2.privKey), '4c715bd4a64b938f99b453351653124f');
  assert.equal(h(await M.k3(u('f7a2a44f8e8a8029064f173ddc1e2b00'))), 'ff046958233db014');
  assert.equal(await M.k4(u('3216d1509884b533248541792b877f98')), 0x38);
});

test('k2/k4 match the amaran keys documented by wesbos/amaran-BLE-control', async () => {
  const k2 = await M.k2(u('0D8094267D3F4EA5B06B324C8C0AD926'));
  assert.equal(k2.nid, 0x3b);
  assert.equal(h(k2.encKey), 'ce1a0749c640a23be0bdf1c7c95fce93');
  assert.equal(h(k2.privKey), '96b5a15d3b3d3fa366251132ba16491c');
  assert.equal(await M.k4(u('AB1C91DC421149FF87694B05A236F214')), 0x03);
});

test('AES-CCM matches Node’s aes-128-ccm and round-trips', async () => {
  const key = M.randomBytes(16), nonce = M.randomBytes(13);
  for (const [len, mic] of [[0, 4], [5, 4], [16, 8], [33, 8], [40, 4]]) {
    const pt = M.randomBytes(len);
    const c = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: mic });
    c.setAAD(Buffer.alloc(0), { plaintextLength: len });
    const ref = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const mine = await M.ccmEncrypt(key, nonce, pt, mic);
    assert.equal(h(mine), ref.toString('hex'), `len ${len} mic ${mic}`);
    assert.equal(h(await M.ccmDecrypt(key, nonce, mine, mic)), h(pt));
    mine[0] ^= 1;
    if (len) assert.equal(await M.ccmDecrypt(key, nonce, mine, mic), null);
  }
});

test('network PDU: encode → decode (access CTL=0, control CTL=1, proxy config)', async () => {
  const k = await M.networkKeys({ netKey: u('0D8094267D3F4EA5B06B324C8C0AD926'), appKey: u('AB1C91DC421149FF87694B05A236F214') });
  const transport = M.randomBytes(12);
  for (const opt of [{ ctl: 0, ttl: 7 }, { ctl: 1, ttl: 0 }]) {
    const pdu = await M.encodeNetwork(k, { ...opt, seq: 0x123456, src: 0x0001, dst: 0x0002, transport });
    assert.equal(pdu.length, 1 + 6 + 2 + 12 + (opt.ctl ? 8 : 4));
    const d = await M.decodeNetwork(k, pdu);
    assert.deepEqual([d.ctl, d.ttl, d.seq, d.src, d.dst, h(d.transport)], [opt.ctl, opt.ttl, 0x123456, 1, 2, h(transport)]);
  }
  const pc = await M.encodeNetwork(k, { ctl: 1, ttl: 0, seq: 9, src: 1, dst: 0, transport: M.proxyConfig.setFilterType(0), proxy: true });
  const d = await M.decodeNetwork(k, pc, { proxy: true });
  assert.equal(h(d.transport), '0000');
  assert.equal(await M.decodeNetwork(k, pc), null, 'proxy nonce ≠ network nonce');
});

test('access message: unsegmented and segmented, through lower transport receive', async () => {
  const k = await M.networkKeys({ netKey: M.randomBytes(16), appKey: M.randomBytes(16) });
  for (const len of [11, 20]) {
    const access = M.randomBytes(len);
    const seq = 0x2005;
    const upper = await M.encryptAccess(k.appKey, 1, { seq, src: 1, dst: 2, iv: 0, access });
    const lowers = M.segmentAccess(upper, { akf: 1, aid: k.aid, seq });
    assert.equal(lowers.length, len <= 11 ? 1 : 2);
    const rx = new Map();
    let got;
    for (let i = lowers.length - 1; i >= 0; i--) got = M.receiveLower(rx, { ctl: 0, seq: seq + i, src: 1, transport: lowers[i] });
    assert.equal(got.kind, 'access');
    assert.equal(got.seqAuth, seq);
    assert.equal(got.aid, k.aid);
    assert.equal(h(await M.decryptAccess(k.appKey, 1, { seqAuth: got.seqAuth, src: 1, dst: 2, iv: 0, upper: got.upper })), h(access));
  }
});

test('proxy SAR: split and reassemble', () => {
  const data = M.randomBytes(65);
  const parts = M.proxySegments(M.PROXY.PROVISIONING, data, 20);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((p) => p[0] >> 6), [1, 2, 2, 3]);
  const r = new M.ProxyReader();
  let out;
  for (const p of parts) out = r.push(p) ?? out;
  assert.equal(out.type, 3);
  assert.equal(h(out.data), h(data));
  assert.equal(M.proxySegments(0, M.randomBytes(19), 20).length, 1);
});

test('provisioning math: both sides agree (simulated device)', async () => {
  const prov = await M.provisionerKeys(), dev = await M.provisionerKeys();
  const s1 = await M.ecdhSecret(prov.priv, dev.pub), s2 = await M.ecdhSecret(dev.priv, prov.pub);
  assert.equal(h(s1), h(s2));
  const inputs = M.concat([5], M.randomBytes(11), [0, 0, 0, 0, 0], prov.pub, dev.pub);
  const a = await M.provisioningCrypto({ inputs, secret: s1 }), b = await M.provisioningCrypto({ inputs, secret: s2 });
  const r1 = M.randomBytes(16), r2 = M.randomBytes(16);
  assert.equal(h(await a.confirmation(r2)), h(await b.confirmation(r2)));
  const sa = await a.session(r1, r2), sb = await b.session(r1, r2);
  const data = M.provisioningData({ netKey: M.randomBytes(16), unicast: 0x0002 });
  assert.equal(data.length, 25);
  const enc = await M.ccmEncrypt(sa.sessionKey, sa.nonce, data, 8);
  assert.equal(enc.length, 33);
  assert.equal(h(await M.ccmDecrypt(sb.sessionKey, sb.nonce, enc, 8)), h(data));
  assert.equal(sa.nonce.length, 13);
});

test('config messages and composition parsing', () => {
  assert.equal(h(M.cfg.appKeyAdd(new Uint8Array(16))).slice(0, 8), '00000000');
  assert.equal(M.cfg.appKeyAdd(new Uint8Array(16)).length, 20);
  assert.equal(h(M.cfg.compositionGet()), '800800');
  assert.equal(h(M.cfg.modelAppBind(0x0002, 0x1000)), '803d020000000010');
  assert.equal(h(M.cfg.modelAppBind(0x0002, { company: 0x0211, id: 0x0001 })), '803d0200000011020100');
  const comp = M.parseComposition(u('00 1102 0100 0000 0a00 0300 0000 02 01 0000 0100 1102 0000'));
  assert.equal(comp.cid, 0x0211);
  assert.deepEqual(comp.elements[0].sig, [0x0000, 0x0001]);
  assert.deepEqual(comp.elements[0].vendor, [{ company: 0x0211, id: 0x0000 }]);
  assert.deepEqual(M.parseAccess(u('8003 00 000000')).opcode, 0x8003);
  assert.equal(h(M.segmentAck({ seqZero: 0x1234, blockAck: 3 })), h(new Uint8Array([0, 0x48, 0xd0, 0, 0, 0, 3])));
});
