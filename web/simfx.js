// Simulated built-in effects: for lights that don't have the GVM light's 20 built-in effects (e.g. amaran), the app
// plays an approximation step by step. They follow the effect names and the settings the GVM app offers
// (brightness, color temperature, cycle, color); they are not copies of GVM's patterns, which run inside the light.
//
// Each generator yields {state, wait}: state is a partial look (mode, cct, hue, sat, bri), wait in ms. Settings are
// read on every step, so moving a slider while the effect runs takes effect at once. Steps are never shorter than
// MIN_MS: every step is a Bluetooth message, and mesh lights can't take them much faster.

export const MIN_MS = 100;

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.round(rnd(a, b));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ms = (v) => Math.max(MIN_MS, Math.round(v));
const lvl = (p, f = 1) => Math.max(0, Math.min(100, Math.round(p.level * f)));
const white = (p, cct, f = 1) => ({ mode: 'cct', cct: cct ?? p.cct ?? 5600, bri: lvl(p, f) });
const color = (p, hue, sat = 100, f = 1) => ({ mode: 'hsi', hue: ((Math.round(hue) % 360) + 360) % 360, sat, bri: lvl(p, f) });
const dark = (s) => ({ ...s, bri: 0 });
const cyc = (p, d = 1) => (p.cycle ?? d) * 1000;

/** Flash on for onMs, then dark for offMs. */
function* flash(state, onMs, offMs) {
  yield { state, wait: ms(onMs) };
  yield { state: dark(state), wait: ms(offMs) };
}

/**
 * Changes color while dark, then shows it. Some lights (the amaran Ace 25c) glide from one color to the next by
 * themselves, so red → blue straight away shows pink and purple in between; switching while dark hides that.
 */
function* switchTo(state, darkMs = 120) {
  yield { state: dark(state), wait: ms(darkMs) };
}

/** A decay from `state` to dark over `ms` in steps. */
function* decay(state, total, steps = 6) {
  for (let k = steps; k >= 0; k--) yield { state: { ...state, bri: Math.round((state.bri * k) / steps) }, wait: ms(total / (steps + 1)) };
}

export const SIMULATED = {
  // 1 Lightning: dark, then 1-3 quick cold flashes
  1: function* (p) { for (;;) { yield { state: dark(white(p, 6500)), wait: ms(rnd(800, 4000)) }; for (let i = rint(1, 3); i > 0; i--) yield* flash(white(p, 6500, rnd(0.6, 1)), rnd(100, 160), rnd(100, 250)); } },
  // 2 Cop Car: red twice, blue twice (color changes while dark, each flash long enough to settle)
  2: function* (p) { for (;;) { for (const hue of [0, 240]) { yield* switchTo(color(p, hue)); for (let i = 0; i < 2; i++) yield* flash(color(p, hue), 250, 150); } } },
  // 3 Candle: warm, gentle random flicker
  3: function* (p) { for (;;) yield { state: white(p, 2700, rnd(0.6, 1)), wait: ms(rnd(100, 250)) }; },
  // 4 TV: cool, shifting colors and levels
  4: function* (p) { for (;;) yield { state: Math.random() < 0.4 ? white(p, rint(5600, 8000), rnd(0.4, 1)) : color(p, rnd(190, 240), rint(15, 60), rnd(0.4, 1)), wait: ms(rnd(150, 700)) }; },
  // 5 Bad Bulb: on, with random drop-outs
  5: function* (p) { for (;;) { yield { state: white(p), wait: ms(rnd(300, 2500)) }; for (let i = rint(1, 4); i > 0; i--) yield* flash(white(p, undefined, rnd(0, 0.3)), rnd(100, 200), rnd(100, 200)); } },
  // 6 Party: a new saturated color every cycle
  6: function* (p) { let h = rnd(0, 360); for (;;) { h += rnd(60, 180); yield* switchTo(color(p, h), 100); yield { state: color(p, h), wait: ms(cyc(p)) }; } },
  // 7 Disco: random colors, flashing on and off (the next color is set while dark)
  7: function* (p) { for (;;) { const c = color(p, rnd(0, 360)); yield* switchTo(c, cyc(p) / 2); yield { state: c, wait: ms(cyc(p) / 2) }; } },
  // 8 Paparazzi: dark with random camera flashes
  8: function* (p) { for (;;) { yield { state: dark(white(p, 5600)), wait: ms(rnd(100, 900)) }; yield { state: white(p, 5600), wait: MIN_MS }; } },
  // 9 Explosion: a flash that burns down through orange, then a pause
  9: function* (p) { for (;;) { yield { state: white(p), wait: MIN_MS }; yield* decay(color(p, 28, 100), rnd(1500, 2500)); yield { state: dark(white(p)), wait: ms(rnd(1500, 4000)) }; } },
  // 10 Pulsing: smooth rise and fall
  10: function* (p) { for (let t = 0; ; t += 0.08) yield { state: white(p, undefined, 0.5 - 0.5 * Math.cos(2 * Math.PI * t)), wait: 160 }; },
  // 11 Fire: orange-red, fast random flicker
  11: function* (p) { for (;;) yield { state: color(p, rnd(12, 32), 100, rnd(0.5, 1)), wait: ms(rnd(100, 200)) }; },
  // 12 Fireworks: a colored burst that fades, then a gap (next color set while dark)
  12: function* (p) { for (;;) { const c = color(p, rnd(0, 360)); yield* switchTo(c, rnd(300, 1500)); yield* decay(c, rnd(900, 1600), 5); } },
  // 13 Welding: erratic blue-white sparks
  13: function* (p) { for (;;) yield* flash(color(p, 205, 25, rnd(0.6, 1)), rnd(100, 160), rnd(100, 400)); },
  // 14 CCT Loop: warm to cool and back (cycle = time per step)
  14: function* (p) { const ks = [2700, 3200, 3800, 4400, 5000, 5600, 6500]; for (;;) for (const k of [...ks, ...ks.slice(1, -1).reverse()]) yield { state: white(p, k), wait: ms(cyc(p)) }; },
  // 15 Hue Loop: around the color wheel (cycle = time per 30°)
  15: function* (p) { for (let h = 0; ; h += 10) yield { state: color(p, h), wait: ms(cyc(p) / 3) }; },
  // 16 Ambulance: red / white
  16: function* (p) { for (;;) { for (const c of [color(p, 0), white(p, 6500)]) { yield* switchTo(c); yield { state: c, wait: 300 }; } } },
  // 17 Fire Engine: red / orange
  17: function* (p) { for (;;) { for (const c of [color(p, 0), color(p, 30)]) { yield* switchTo(c); yield { state: c, wait: 300 }; } } },
  // 18 SOS: ... --- ... in Morse
  18: function* (p) {
    const dot = 200, on = white(p, 5600);
    for (;;) {
      for (const len of [1, 1, 1, 3, 3, 3, 1, 1, 1]) yield* flash(on, dot * len, dot);
      yield { state: dark(on), wait: dot * 6 };
    }
  },
  // 19 Strobe: white on/off (cycle = time per flash)
  19: function* (p) { for (;;) yield* flash(white(p), Math.min(cyc(p) / 2, 150), cyc(p) - Math.min(cyc(p) / 2, 150)); },
  // 20 Strobe II: colored on/off
  20: function* (p) { for (;;) yield* flash(color(p, p.hue ?? 0, p.sat ?? 100), Math.min(cyc(p) / 2, 150), cyc(p) - Math.min(cyc(p) / 2, 150)); },
};

/** Steps for built-in effect number n (falls back to a gentle pulse), none shorter than minMs. */
export function* simulatedSteps(n, p, minMs = MIN_MS) {
  for (const s of (SIMULATED[n] ?? SIMULATED[10])(p)) yield s.wait >= minMs ? s : { ...s, wait: minMs };
}

/** Speed test: on/off flashes at each interval, `flashes` times each. */
export const SPEED_TEST_MS = [500, 300, 200, 150, 100];
