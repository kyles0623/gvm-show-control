// Looks (static states) and effects (animated loops).
// Every step only uses captured command types: mode, brightness, cct, hue, saturation.
// Values: bri 0-100 %, cct 3200-5600 K, hue 0-360° (5° resolution), sat 0-100 %.
//
// Effects take a live params object `p` (edited from the UI while running; each step reads
// the current values). Brightness params never go below 10 % (lowest level in the capture).
// Every step waits at least MIN_STEP_MS so the BLE link is not flooded.

export const MIN_STEP_MS = 200;

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const lohi = (a, b) => [Math.min(a, b), Math.max(a, b)];

/** Hue sets for the Party effect (degrees). */
const PARTY_PALETTES = {
  rainbow: [0, 30, 55, 120, 180, 220, 270, 320],
  warm: [0, 15, 30, 45, 330, 345],
  cool: [160, 180, 200, 220, 240, 260, 280],
  pinkblue: [320, 330, 340, 225, 235, 245],
};
/** Base wait in ms divided by speed, never below MIN_STEP_MS. */
const t = (ms, p) => Math.max(MIN_STEP_MS, ms / (p.speed ?? 1));

// Shared param definitions.
// Default max brightness: fast effects (Cops, Party) 25–30 %, saturated colors (Fire, Candle) under 40 %, others 50 %.
const LEVEL = (def) => ({ id: 'level', label: 'Max brightness', min: 10, max: 100, step: 1, def, unit: '%', kind: 'bri' });
const FLOOR = (def, label = 'Min brightness') => ({ id: 'floor', label, min: 10, max: 100, step: 1, def, unit: '%', kind: 'bri' });
const SPEED = (def = 1, max = 2.5) => ({ id: 'speed', label: 'Speed', min: 0.25, max, step: 0.05, def, unit: '×', kind: 'speed' });
const HUE = (id, label, def) => ({ id, label, min: 0, max: 360, step: 5, def, unit: '°', kind: 'hue' });
const SAT = (def, label = 'Saturation') => ({ id: 'sat', label, min: 0, max: 100, step: 1, def, unit: '%', kind: 'sat' });
/** Run time; 0 = until stopped. When it ends the lights return to the look from before the effect. */
const DURATION = { id: 'duration', label: 'Run for', min: 0, max: 120, step: 1, def: 0, unit: 's', kind: 'plain' };

export const LOOKS = [
  { id: 'daylight',  name: 'Daylight',  swatch: '#f4f1ff', state: { mode: 'cct', cct: 5600, bri: 50 } },
  { id: 'tungsten',  name: 'Tungsten',  swatch: '#ffb46b', state: { mode: 'cct', cct: 3200, bri: 50 } },
  { id: 'sunset',    name: 'Sunset',    swatch: 'hsl(25 95% 55%)',  state: { mode: 'hsi', hue: 25, sat: 90, bri: 50 } },
  { id: 'moonlight', name: 'Moonlight', swatch: 'hsl(215 50% 60%)', state: { mode: 'hsi', hue: 215, sat: 45, bri: 25 } },
  { id: 'night',     name: 'Night',     swatch: 'hsl(235 100% 35%)', state: { mode: 'hsi', hue: 235, sat: 100, bri: 10 } },
  { id: 'romance',   name: 'Romance',   swatch: 'hsl(330 70% 55%)', state: { mode: 'hsi', hue: 330, sat: 70, bri: 40 } },
];

export const EFFECTS = [
  {
    id: 'cops', name: 'Cops', swatch: 'linear-gradient(90deg, hsl(0 100% 50%) 50%, hsl(240 100% 55%) 50%)',
    desc: 'Alternates between two colors',
    params: [LEVEL(25), SPEED(1), HUE('hueA', 'Color A', 0), HUE('hueB', 'Color B', 240),
      { id: 'pattern', label: 'Pattern', kind: 'choice', def: 'alternate',
        options: [['alternate', 'A / B'], ['double', 'A A / B B'], ['strobe', 'A / dark / B / dark']] },
      { id: 'multi', label: 'Multiple lights', kind: 'choice', def: 'alternate',
        options: [['same', 'In sync'], ['alternate', 'Alternate A/B']] },
      DURATION],
    *steps(p) {
      for (;;) {
        const A = { mode: 'hsi', hue: p.hueA, sat: 100, bri: p.level };
        const B = { mode: 'hsi', hue: p.hueB, sat: 100, bri: p.level };
        const dim = { bri: 10 };
        // `alt` is what every other light shows when "Multiple lights" is Alternate.
        if (p.pattern === 'double') {
          yield { state: A, alt: B, wait: t(220, p) }; yield { state: dim, alt: dim, wait: t(200, p) };
          yield { state: A, alt: B, wait: t(220, p) }; yield { state: B, alt: A, wait: t(220, p) };
          yield { state: dim, alt: dim, wait: t(200, p) }; yield { state: B, alt: A, wait: t(220, p) };
        } else if (p.pattern === 'strobe') {
          yield { state: A, alt: dim, wait: t(250, p) }; yield { state: dim, alt: B, wait: t(250, p) };
          yield { state: B, alt: dim, wait: t(250, p) }; yield { state: dim, alt: A, wait: t(250, p) };
        } else {
          yield { state: A, alt: B, wait: t(400, p) };
          yield { state: B, alt: A, wait: t(400, p) };
        }
      }
    },
  },
  {
    id: 'tv', name: 'Television', swatch: 'hsl(210 35% 55%)',
    desc: 'Flicker with random level and tint changes, occasional scene cuts',
    perLight: true,
    params: [LEVEL(50), FLOOR(15), SPEED(1), HUE('hue', 'Tint', 210), SAT(30, 'Color strength'),
      { id: 'cuts', label: 'Scene cuts', min: 0, max: 50, step: 1, def: 15, unit: '%', kind: 'plain' }, DURATION],
    *steps(p) {
      let bri = (p.floor + p.level) / 2, hueOff = 0;
      for (;;) {
        const [lo, hi] = lohi(p.floor, p.level);
        if (Math.random() < p.cuts / 100) { hueOff = pick([-15, -5, 0, 5, 15, 180]); bri = rnd(lo, hi); }
        else bri = Math.min(hi, Math.max(lo, bri + rnd(-0.25, 0.25) * (hi - lo)));
        const hue = (((p.hue + (hueOff === 180 ? 0 : hueOff)) % 360) + 360) % 360;
        const warmCut = hueOff === 180; // occasional warm scene
        yield { state: { mode: 'hsi', hue: warmCut ? 30 : hue, sat: Math.round(rnd(0.5, 1.2) * p.sat), bri }, wait: t(rnd(250, 700), p) };
      }
    },
  },
  {
    id: 'fire', name: 'Fire', swatch: 'hsl(20 100% 50%)',
    desc: 'Orange flicker',
    perLight: true,
    params: [LEVEL(35), FLOOR(15), SPEED(1), HUE('hue', 'Base color', 20),
      { id: 'spread', label: 'Color spread', min: 0, max: 30, step: 5, def: 10, unit: '°', kind: 'plain' }, DURATION],
    *steps(p) {
      for (;;) {
        const [lo, hi] = lohi(p.floor, p.level);
        const hue = Math.max(0, p.hue + Math.round(rnd(-p.spread, p.spread) / 5) * 5);
        yield { state: { mode: 'hsi', hue, sat: 100, bri: rnd(lo, hi) }, wait: t(rnd(300, 500), p) };
      }
    },
  },
  {
    id: 'candle', name: 'Candle', swatch: 'hsl(32 100% 60%)',
    desc: 'Gentle warm flicker',
    perLight: true,
    params: [LEVEL(35), FLOOR(20), SPEED(1), HUE('hue', 'Color', 30), SAT(85), DURATION],
    *steps(p) {
      for (;;) {
        const [lo, hi] = lohi(p.floor, p.level);
        yield { state: { mode: 'hsi', hue: p.hue, sat: p.sat, bri: rnd(lo, hi) }, wait: t(rnd(350, 700), p) };
      }
    },
  },
  {
    id: 'party', name: 'Party',
    swatch: 'conic-gradient(hsl(0 100% 55%), hsl(60 100% 55%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 60%), hsl(300 100% 55%), hsl(360 100% 55%))',
    desc: 'Club-style color changes: Jump between colors, Flow around the palette, or pulse to a Beat',
    perLight: true,   // every light runs its own sequence, so several lights show different colors
    params: [
      LEVEL(30), FLOOR(15), SPEED(1),
      { id: 'palette', label: 'Colors', kind: 'choice', def: 'rainbow',
        options: [['rainbow', 'Rainbow'], ['warm', 'Warm'], ['cool', 'Cool'], ['pinkblue', 'Pink / Blue']] },
      { id: 'style', label: 'Style', kind: 'choice', def: 'jump',
        options: [['jump', 'Jump'], ['flow', 'Flow'], ['beat', 'Beat']] },
      SAT(100), DURATION,
    ],
    *steps(p) {
      let i = Math.floor(Math.random() * 8);   // random start so lights don't match
      let prev = -1;
      for (;;) {
        const pal = PARTY_PALETTES[p.palette] ?? PARTY_PALETTES.rainbow;
        const [lo, hi] = lohi(p.floor, p.level);
        if (p.style === 'flow') {
          // glide from one palette color to the next in 5 small hue steps
          const a = pal[i % pal.length], b = pal[(i + 1) % pal.length];
          const d = ((((b - a) % 360) + 540) % 360) - 180;
          for (let k = 1; k <= 5; k++) {
            yield { state: { mode: 'hsi', hue: (((a + (d * k) / 5) % 360) + 360) % 360, sat: p.sat, bri: hi }, wait: t(260, p) };
          }
          i++;
        } else {
          let hue;
          do { hue = pick(pal); } while (pal.length > 1 && hue === prev);
          prev = hue;
          if (p.style === 'beat') {
            yield { state: { mode: 'hsi', hue, sat: p.sat, bri: hi }, wait: t(260, p) };
            yield { state: { bri: lo }, wait: t(260, p) };
          } else {
            yield { state: { mode: 'hsi', hue, sat: p.sat, bri: rnd(Math.max(lo, hi - 25), hi) }, wait: t(450, p) };
          }
        }
      }
    },
  },
  {
    id: 'breathe', name: 'Breathe', swatch: 'radial-gradient(circle, #ffd9b3, #3a2a1a)',
    desc: 'Slow brightness pulse, keeps the current color',
    params: [LEVEL(50), FLOOR(10),
      { id: 'period', label: 'Cycle time', min: 2, max: 20, step: 0.5, def: 6, unit: 's', kind: 'plain' }, DURATION],
    *steps(p) {
      const step = 300;
      for (let ph = 0; ; ph += step / (p.period * 1000)) {
        const [lo, hi] = lohi(p.floor, p.level);
        yield { state: { bri: lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph)) }, wait: step };
      }
    },
  },
];

/** Default params for an effect. */
export const defaults = (e) => Object.fromEntries(e.params.map((d) => [d.id, d.def]));
