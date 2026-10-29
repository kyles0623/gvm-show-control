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

// ---------- custom effects and gels ----------
import { GELS } from '../web/effects.js';
import { toEffect, normStep, cycleSeconds, changedValues } from '../web/customfx.js';
import { FAST_STEP_MS } from '../web/effects.js';

test('custom effect: never faster than FAST_STEP_MS (60 ms), one cycle takes hold + fade of every step', () => {
  const def = { id: 't', name: 'T', steps: [
    normStep({ mode: 'hsi', hue: 250, sat: 100, bri: 40, hold: 1, fade: 0 }),
    normStep({ mode: 'hsi', hue: 0, sat: 100, bri: 40, hold: 0.5, fade: 2 }),
    normStep({ mode: 'cct', cct: 3200, bri: 60, hold: 0.02, fade: 1 }),       // hold below the minimum → clamped
  ] };
  const e = toEffect(def);
  for (const speed of [1, 4]) {
    const gen = e.steps({ speed, duration: 0 });
    const cycle = [];
    // First pass has no previous step to fade from; measure the second pass.
    for (let i = 0; i < 200; i++) { const s = gen.next().value; cycle.push(s); }
    for (const s of cycle) assert.ok(s.wait >= FAST_STEP_MS, `step wait ${s.wait} at speed ${speed}`);
  }
  // At speed 1 a steady-state cycle is 1 + 8 + 4 = 13 yields (step 2 fades 2 s in 250 ms parts, step 3 fades 1 s);
  // the first pass is also 13 (only the very first step has nothing to fade from, and it has no fade anyway).
  const gen = e.steps({ speed: 1, duration: 0 });
  const waits = Array.from({ length: 26 }, () => gen.next().value.wait);
  const cycle2 = waits.slice(13).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(cycle2 - cycleSeconds(def) * 1000) < 1, `cycle ${cycle2} ms vs ${cycleSeconds(def) * 1000} ms`);
  assert.equal(def.steps[2].hold, FAST_STEP_MS / 1000);
});

test('custom effect: fades take the short way round the hue circle', () => {
  const def = { id: 't', name: 'T', steps: [normStep({ mode: 'hsi', hue: 250, sat: 100, bri: 40, hold: 1 }), normStep({ mode: 'hsi', hue: 0, sat: 100, bri: 40, hold: 1, fade: 1 })] };
  const gen = toEffect(def).steps({ speed: 1, duration: 0 });
  const hues = Array.from({ length: 8 }, () => gen.next().value.state.hue);
  assert.ok(hues.every((h) => h === 0 || h >= 250), hues.join(' '));     // 250 → 360/0, never through 120
});

test('gels: valid values for the light (hue in 5° steps, CCT 3200–5600 in 100 K steps)', () => {
  assert.ok(GELS.length >= 10);
  for (const g of GELS) {
    if (g.state.mode === 'cct') assert.ok(g.state.cct >= 3200 && g.state.cct <= 5600 && g.state.cct % 100 === 0, g.id);
    else assert.ok(g.state.hue % 5 === 0 && g.state.hue >= 0 && g.state.hue < 360 && g.state.sat >= 0 && g.state.sat <= 100, g.id);
    assert.equal(g.state.bri, undefined, `${g.id} must not set brightness`);
  }
});

test('repo link: this repo by default, a fork when served from <user>.github.io/<repo>/', async () => {
  const { repoUrl, REPO_URL } = await import('../web/setup.js');
  assert.equal(repoUrl({ hostname: 'localhost', pathname: '/' }), REPO_URL);
  assert.equal(repoUrl({ hostname: 'kyles0623.github.io', pathname: '/gvm-show-control/' }), 'https://github.com/kyles0623/gvm-show-control');
  assert.equal(repoUrl({ hostname: 'someone.github.io', pathname: '/my-fork/index.html' }), 'https://github.com/someone/my-fork');
});

test('custom effect: brightness-only flicker can step every 60 ms; changed values are counted', () => {
  const a = normStep({ mode: 'cct', cct: 5600, bri: 10, hold: 0.06 }), b = normStep({ mode: 'cct', cct: 5600, bri: 60, hold: 0.06 });
  const gen = toEffect({ id: 'f', name: 'F', steps: [a, b] }).steps({ speed: 1, duration: 0 });
  const waits = Array.from({ length: 10 }, () => gen.next().value.wait);
  assert.ok(waits.every((w) => w === 60), waits.join(' '));
  assert.equal(changedValues(a, b), 1);                                                    // brightness only
  assert.equal(changedValues(a, normStep({ mode: 'hsi', hue: 0, sat: 100, bri: 60 })), 4); // mode, hue, sat, bri
});

test('custom effect: random Level / Hold / Fade stay within their ranges and vary', async () => {
  const { pick, hasRandom } = await import('../web/customfx.js');
  const s = normStep({ mode: 'hsi', hue: 0, sat: 100, bri: 20, briTo: 70, hold: 0.1, holdTo: 0.5, fade: 0, fadeTo: 2 });
  assert.deepEqual([s.bri, s.briTo, s.hold, s.holdTo, s.fade, s.fadeTo], [20, 70, 0.1, 0.5, 0, 2]);
  assert.deepEqual([pick(s, 'bri', () => 0), pick(s, 'bri', () => 0.999)], [20, 70]);
  const back = normStep({ bri: 80, briTo: 30 });                       // entered backwards → swapped
  assert.deepEqual([back.bri, back.briTo], [30, 80]);
  const def = { id: 'r', name: 'R', steps: [s, normStep({ mode: 'hsi', hue: 240, sat: 100, bri: 50, hold: 0.2 })] };
  assert.ok(hasRandom(def));
  const gen = toEffect(def).steps({ speed: 1, duration: 0 });
  const bris = new Set(), waits = [];
  for (let k = 0; k < 400; k++) {
    const st = gen.next().value;
    if (st.state.hue === 0) { bris.add(st.state.bri); assert.ok(st.state.bri >= 20 && st.state.bri <= 70, `bri ${st.state.bri}`); }
    waits.push(st.wait);
  }
  assert.ok(bris.size > 5, `only ${bris.size} distinct levels`);
  assert.ok(waits.every((w) => w >= FAST_STEP_MS));
  // fixed steps are unchanged by the random support
  const fixed = normStep({ bri: 40, hold: 1 });
  assert.equal(fixed.briTo, undefined);
  assert.equal(pick(fixed, 'bri'), 40);
});
