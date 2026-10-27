// Protocol and effect tests. Run: node --test tests/protocol.test.mjs   (Node 18+, no dependencies)
// The reference data is real traffic between the official app and a GVM 800-RGB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GVMProtocol as P, decode, crc16xmodem, stateFromFrame } from '../web/gvm-protocol.js';
import { parseHex } from '../web/ble.js';
import { EFFECTS, LOOKS, MIN_STEP_MS, defaults } from '../web/effects.js';

const fixture = JSON.parse(readFileSync(new URL('../protocol/gvm-800rgb-frames.json', import.meta.url), 'utf8'));
const bytes = (hex) => new Uint8Array(hex.split(' ').map((h) => parseInt(h, 16)));
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const frames = fixture.frames.map((f) => ({ ...f, b: bytes(f.hex) }));
const sent = frames.filter((f) => f.dir === 'app→light');

test('every captured frame has a valid CRC-16/XMODEM', () => {
  for (const f of frames) {
    const crc = (f.b[f.b.length - 2] << 8) | f.b[f.b.length - 1];
    assert.equal(crc16xmodem(f.b.slice(0, -2)), crc, f.hex);
  }
});

test('length byte counts the bytes after it', () => {
  for (const f of frames) assert.equal(f.b[2], f.b.length - 3, f.hex);
});

test('handshake matches the first frame the official app sends', () => {
  assert.equal(hex(P.handshake()[0]), sent[0].hex);
});

test('every captured set-parameter frame is reproduced by the encoders', () => {
  const encode = {
    0x00: (v) => P.power(v === 1)[0],
    0x02: (v) => P.brightness(v)[0],
    0x03: (v) => P.cct(v * 100)[0],
    0x04: (v) => P.hue(v * 5)[0],
    0x05: (v) => P.saturation(v)[0],
    0x06: (v) => P.mode(v === 2 ? 'hsi' : 'cct')[0],
  };
  const sets = sent.filter((f) => f.b[5] === 0x57);
  assert.ok(sets.length > 50);
  for (const f of sets) {
    const param = f.b[7], value = f.b[9];
    assert.ok(encode[param], `unexpected param 0x${param.toString(16)}`);
    assert.equal(hex(encode[param](value)), f.hex);
  }
});

test('status echo reproduces the app reply to every status frame', () => {
  let checked = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i], next = frames[i + 1];
    if (f.dir === 'light→app' && f.b[5] === 0x03 && next.dir === 'app→light' && next.b[5] === 0x48) {
      assert.equal(hex(P.statusEcho(f.b)), next.hex);
      checked++;
    }
  }
  assert.ok(checked > 10, `only ${checked} echoes checked`);
});

test('decoder turns status frames into light state', () => {
  const status = frames.find((f) => f.b[5] === 0x03);
  const st = stateFromFrame(status.b);
  for (const k of ['power', 'brightness', 'cct', 'hue', 'saturation', 'mode']) assert.ok(k in st, k);
  assert.ok(decode(status.b)[0].ok);
});

test('decoder splits two frames sent in one notification', () => {
  const two = new Uint8Array([...P.brightness(40)[0], ...P.power(true)[0]]);
  const out = decode(two);
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.ok));
});

test('encoders clamp out-of-range values', () => {
  assert.equal(P.brightness(150)[0][9], 100);
  assert.equal(P.cct(9000)[0][9], 56);
  assert.equal(P.cct(1000)[0][9], 32);
  assert.equal(P.hue(400)[0][9], 72);
});

test('hex input parser', () => {
  assert.deepEqual(Array.from(parseHex('AA 55 0x10, 1f')), [0xaa, 0x55, 0x10, 0x1f]);
  assert.deepEqual(Array.from(parseHex('aa55')), [0xaa, 0x55]);
  assert.deepEqual(Array.from(parseHex('f')), [0x0f]);
  assert.equal(parseHex('abc'), null);
  assert.equal(parseHex('zz'), null);
});

test('looks stay within the light’s ranges', () => {
  for (const l of LOOKS) {
    const s = l.state;
    assert.ok(s.bri >= 0 && s.bri <= 100, l.id);
    if (s.mode === 'cct') assert.ok(s.cct >= 3200 && s.cct <= 5600, l.id);
    else assert.ok(s.hue % 5 === 0 && s.hue <= 360 && s.sat <= 100, l.id);
  }
});

test('effects: valid values and never faster than MIN_STEP_MS, at max speed', () => {
  for (const e of EFFECTS) {
    const p = { ...defaults(e) };
    if ('speed' in p) p.speed = Math.max(...e.params.filter((d) => d.id === 'speed').map((d) => d.max));
    let n = 0;
    for (const step of e.steps(p)) {
      assert.ok(step.wait >= MIN_STEP_MS, `${e.id} wait ${step.wait}`);
      const s = step.state;
      if (s.bri != null) assert.ok(s.bri >= 10 && s.bri <= 100, `${e.id} bri ${s.bri}`);
      if (s.hue != null) assert.ok(s.hue >= 0 && s.hue <= 360, `${e.id} hue ${s.hue}`);
      if (++n > 200) break;
    }
  }
});

// ---------- crossfade math and show data (web/show.js) ----------
import { lerpState, stateAt, normState } from '../web/show.js';

test('crossfade: hue takes the short way round the wheel', () => {
  const a = { mode: 'hsi', cct: 5600, hue: 330, sat: 70, bri: 40 }, b = { mode: 'hsi', cct: 5600, hue: 20, sat: 90, bri: 60 };
  const hues = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(lerpState(a, b, t).hue));
  assert.deepEqual(hues, [330, 343, 355, 8, 20]);
  assert.equal(lerpState(a, b, 0.5).bri, 50);
});

test('crossfade: White ↔ Color dips through dark at the midpoint', () => {
  const plan = { from: { mode: 'hsi', cct: 5600, hue: 25, sat: 90, bri: 60 }, to: { mode: 'cct', cct: 5600, hue: 0, sat: 100, bri: 80 } };
  assert.equal(stateAt(plan, 0).mode, 'hsi');
  assert.ok(stateAt(plan, 0.49).bri < 2);
  assert.equal(stateAt(plan, 0.5).mode, 'cct');
  assert.ok(stateAt(plan, 0.51).bri < 2);
  assert.equal(stateAt(plan, 1).bri, 80);
});

test('looks and cues are rounded to what the light can show', () => {
  assert.deepEqual(normState({ mode: 'hsi', hue: 362, sat: 101, bri: -3, cct: 9000 }), { mode: 'hsi', cct: 5600, hue: 360, sat: 100, bri: 0 });
  assert.deepEqual(normState({ mode: 'cct', cct: 3149, power: 0 }), { mode: 'cct', cct: 3200, hue: 0, sat: 100, bri: 50, power: false });
});
