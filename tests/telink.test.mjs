// amaran "Telink 0x26" payloads (web/telink.js), against the values documented by wesbos/amaran-BLE-control (MIT).
// These check the port, not the light: the amaran driver stays 'untested' until confirmed on an Ace 25c.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../web/telink.js';

const sum = (p) => p.slice(1).reduce((s, x) => s + x, 0) & 0xff;

test('on/off', () => {
  assert.deepEqual([...T.onoff(true)], [0x8d, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x8c]);
  assert.deepEqual([...T.onoff(false)], [0x8c, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x8c]);
});

test('brightness 750 → 10-bit intensity, checksum', () => {
  const p = T.brightness(750);
  assert.equal(p[9], 0x8f);
  assert.equal(p[0], sum(p));
  assert.equal((p[8] << 2) | (p[7] >> 6), 750);
});

test('CCT: kelvin/10 in bits 52-61, neutral green/magenta, decodes back', () => {
  const p = T.cct(5600, 1000);
  assert.equal(p[9], 0x82);
  assert.equal(p[0], sum(p));
  let low = 0n; for (let i = 0; i < 8; i++) low |= BigInt(p[i]) << BigInt(i * 8);
  assert.equal(Number((low >> 52n) & 0x3ffn), 560);
  assert.equal(Number((low >> 45n) & 0x7fn), 10);
  for (const k of [2300, 4300, 10000]) {
    const q = T.cct(k, 130); q[9] = 0x02; q[0] = sum(q);
    const st = T.decodeStatus(q);
    assert.equal(st.kelvin, k); assert.equal(st.intensity, 130); assert.equal(st.mode, 'cct');
  }
});

test('HSI decodes back', () => {
  const q = T.hsi(123, 77, 640); q[9] = 0x01; q[0] = sum(q);
  assert.deepEqual(T.decodeStatus(q), { on: false, mode: 'hsi', sat: 77, hue: 123, intensity: 640 });
});

test('status request', () => { assert.deepEqual([...T.statusRequest()], [0x0e, 0, 0, 0, 0, 0, 0, 0, 0, 0x0e]); });
