// Looks (static states) and effects (animated loops).
// Every step only uses captured command types: mode, brightness, cct, hue, saturation.
// Values: bri 0-100 %, cct 3200-5600 K, hue 0-360° (5° resolution), sat 0-100 %.
//
// Effects take a live params object `p` (edited from the UI while running; each step reads
// the current values). Brightness params never go below 10 % (lowest level in the capture).
// Every step waits at least MIN_STEP_MS so the BLE link is not flooded.

export const MIN_STEP_MS = 200;
// Custom effects may go faster, down to one write per light every 60 ms: the minimum gap between writes, which is
// the fastest the official app was seen sending (FRAME_GAP_MS in ble.js enforces it). A step that changes several
// values needs one write per value, so it takes at least 60 ms per changed value whatever its hold time says.
export const FAST_STEP_MS = 60;

const lohi = (a, b) => [Math.min(a, b), Math.max(a, b)];

/** Hue sets for the Party effect (degrees). */
/** Base wait in ms divided by speed, never below MIN_STEP_MS. */
const t = (ms, p) => Math.max(MIN_STEP_MS, ms / (p.speed ?? 1));

// Shared param definitions.
// Default max brightness: fast effects (Cops, Party) 25–30 %, saturated colors (Fire, Candle) under 40 %, others 50 %.
// Default min brightness: 20 % for every effect.
const LEVEL = (def) => ({ id: 'level', label: 'Max brightness', min: 10, max: 100, step: 1, def, unit: '%', kind: 'bri' });
const FLOOR = (def, label = 'Min brightness') => ({ id: 'floor', label, min: 10, max: 100, step: 1, def, unit: '%', kind: 'bri' });
export const SPEED = (def = 1, max = 2.5) => ({ id: 'speed', label: 'Speed', min: 0.25, max, step: 0.05, def, unit: '×', kind: 'speed' });
const HUE = (id, label, def) => ({ id, label, min: 0, max: 360, step: 5, def, unit: '°', kind: 'hue' });
const SAT = (def, label = 'Saturation') => ({ id: 'sat', label, min: 0, max: 100, step: 1, def, unit: '%', kind: 'sat' });
/** Run time; 0 = until stopped. When it ends the lights return to the look from before the effect. */
export const DURATION = { id: 'duration', label: 'Run for', min: 0, max: 120, step: 1, def: 0, unit: 's', kind: 'plain' };

// Gel-style color presets: rough approximations of common theatre gel colors on this light (it can't
// reproduce a real gel's spectrum). Correction gels are expressed as color temperature, the rest as hue/saturation.
export const GELS = [
  { group: 'Correction (white)', id: 'cto-full', name: 'Full CTO', state: { mode: 'cct', cct: 3200 } },
  { group: 'Correction (white)', id: 'cto-34', name: '¾ CTO', state: { mode: 'cct', cct: 3500 } },
  { group: 'Correction (white)', id: 'cto-12', name: '½ CTO', state: { mode: 'cct', cct: 3800 } },
  { group: 'Correction (white)', id: 'cto-14', name: '¼ CTO', state: { mode: 'cct', cct: 4500 } },
  { group: 'Correction (white)', id: 'cto-18', name: '⅛ CTO', state: { mode: 'cct', cct: 4900 } },
  { group: 'Correction (white)', id: 'ctb-12', name: '½ CTB (on tungsten)', state: { mode: 'cct', cct: 4100 } },
  { group: 'Correction (white)', id: 'ctb-full', name: 'Full CTB (on tungsten)', state: { mode: 'cct', cct: 5600 } },
  { group: 'Warm', id: 'bastard-amber', name: 'Bastard Amber', state: { mode: 'hsi', hue: 25, sat: 40 } },
  { group: 'Warm', id: 'straw', name: 'Straw', state: { mode: 'hsi', hue: 45, sat: 45 } },
  { group: 'Warm', id: 'medium-amber', name: 'Medium Amber', state: { mode: 'hsi', hue: 30, sat: 75 } },
  { group: 'Warm', id: 'deep-orange', name: 'Deep Orange', state: { mode: 'hsi', hue: 20, sat: 100 } },
  { group: 'Warm', id: 'primary-red', name: 'Primary Red', state: { mode: 'hsi', hue: 0, sat: 100 } },
  { group: 'Pinks & lavenders', id: 'rose-pink', name: 'Rose Pink', state: { mode: 'hsi', hue: 330, sat: 60 } },
  { group: 'Pinks & lavenders', id: 'surprise-pink', name: 'Surprise Pink', state: { mode: 'hsi', hue: 285, sat: 25 } },
  { group: 'Pinks & lavenders', id: 'lavender', name: 'Lavender', state: { mode: 'hsi', hue: 265, sat: 40 } },
  { group: 'Cool', id: 'steel-blue', name: 'Steel Blue', state: { mode: 'hsi', hue: 205, sat: 30 } },
  { group: 'Cool', id: 'sky-blue', name: 'Sky Blue', state: { mode: 'hsi', hue: 200, sat: 60 } },
  { group: 'Cool', id: 'night-blue', name: 'Night Blue', state: { mode: 'hsi', hue: 225, sat: 75 } },
  { group: 'Cool', id: 'congo-blue', name: 'Congo Blue', state: { mode: 'hsi', hue: 250, sat: 100 } },
  { group: 'Cool', id: 'teal', name: 'Teal', state: { mode: 'hsi', hue: 175, sat: 70 } },
  { group: 'Cool', id: 'moss-green', name: 'Moss Green', state: { mode: 'hsi', hue: 95, sat: 55 } },
];

export const LOOKS = [
  { id: 'daylight',  name: 'Daylight',  swatch: '#f4f1ff', state: { mode: 'cct', cct: 5600, bri: 50 } },
  { id: 'tungsten',  name: 'Tungsten',  swatch: '#ffb46b', state: { mode: 'cct', cct: 3200, bri: 50 } },
  { id: 'sunset',    name: 'Sunset',    swatch: 'hsl(25 95% 55%)',  state: { mode: 'hsi', hue: 25, sat: 90, bri: 50 } },
  { id: 'moonlight', name: 'Moonlight', swatch: 'hsl(215 50% 60%)', state: { mode: 'hsi', hue: 215, sat: 45, bri: 25 } },
  { id: 'night',     name: 'Night',     swatch: 'hsl(235 100% 35%)', state: { mode: 'hsi', hue: 235, sat: 100, bri: 10 } },
  { id: 'romance',   name: 'Romance',   swatch: 'hsl(330 70% 55%)', state: { mode: 'hsi', hue: 330, sat: 70, bri: 40 } },
];

// Effects the app runs itself, step by step. The light's own built-in effects (BUILTIN, below) are the main ones;
// these cover what the built-ins don't. Cops, Television, Fire, Candle and Party were removed in favour of the
// light's Cop Car, TV, Fire, Candle and Party (cues that used them are moved over, see ALIASES).
export const EFFECTS = [
  {
    id: 'breathe', name: 'Breathe', swatch: 'radial-gradient(circle, #ffd9b3, #3a2a1a)',
    desc: 'Slow brightness pulse, keeps the current color',
    params: [LEVEL(50), FLOOR(20),
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

// ---------- built-in effects (the light's own Scene mode) ----------
// Started with mode 3 + the effect number (capture 2); the light then runs the effect by itself, so there is
// no per-step Bluetooth traffic. Each effect gets the settings the official app shows for it (screenshots,
// 2026-10-30): brightness (BRG) for all; some add color temperature, cycle time, or hue + saturation.
// Captured: effect numbers 2, 8, 20; brightness, hue, saturation and cycle (param 0x08) on Strobe II. Not
// captured: the other effect numbers (same command, number = position in the app's list), cycle on other
// effects (same param 0x08) and color temperature in Scene mode (param 0x03, as in CCT mode).
import { SCENES } from './gvm-protocol.js';

const FAST = new Set([1, 2, 5, 6, 7, 8, 9, 12, 13, 16, 17, 18, 19, 20]);
const WARM = new Set([3, 11]);
const SCENE_SWATCH = {
  1: 'linear-gradient(135deg, #223 40%, #eef 50%, #223 60%)', 2: 'linear-gradient(90deg, hsl(0 100% 50%) 50%, hsl(240 100% 55%) 50%)',
  3: 'hsl(32 100% 60%)', 4: 'hsl(210 35% 55%)', 5: 'linear-gradient(90deg, #ffd9a0 60%, #333 60%)',
  6: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)', 7: 'conic-gradient(magenta, cyan, yellow, magenta)',
  8: 'radial-gradient(circle, #fff 30%, #333 70%)', 9: 'radial-gradient(circle, #ffe08a 20%, #e0461a 60%, #222 80%)',
  10: 'radial-gradient(circle, #fff 10%, #555 80%)', 11: 'hsl(20 100% 50%)', 12: 'radial-gradient(circle, #ffd400 15%, #e03 45%, #22a 75%)',
  13: 'radial-gradient(circle, #bfe9ff 25%, #2a6 70%)', 14: 'linear-gradient(90deg, #ffb46b, #f4f1ff)',
  15: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)', 16: 'linear-gradient(90deg, #e22 50%, #fff 50%)',
  17: 'linear-gradient(90deg, #e22 50%, #f80 50%)', 18: 'repeating-linear-gradient(90deg, #fff 0 3px, #222 3px 6px)',
  19: 'repeating-linear-gradient(90deg, #fff 0 2px, #111 2px 6px)', 20: 'repeating-linear-gradient(90deg, hsl(280 100% 60%) 0 2px, #111 2px 6px)',
};
export const CYCLE = { id: 'cycle', label: 'Cycle', min: 0.1, max: 5, step: 0.1, def: 1, unit: 's', kind: 'plain' };
const SCENE_CCT = { id: 'cct', label: 'Color temperature', min: 3200, max: 5600, step: 100, def: 5600, unit: 'K', kind: 'cct' };
// Extra settings per effect number, as in the official app.
const SCENE_SETTINGS = {
  5: [SCENE_CCT], 9: [SCENE_CCT], 10: [SCENE_CCT], 12: [SCENE_CCT],         // Bad Bulb, Explosion, Pulsing, Fireworks
  6: [CYCLE], 7: [CYCLE], 14: [CYCLE], 15: [CYCLE],                        // Party, Disco, CCT Loop, Hue Loop
  19: [SCENE_CCT, CYCLE],                                                  // Strobe
  20: [CYCLE, HUE('hue', 'Color', 0), SAT(100)],                           // Strobe II
};

export const BUILTIN = SCENES.map((name, i) => {
  const n = i + 1;
  const level = FAST.has(n) ? 30 : WARM.has(n) ? 35 : 50;
  return {
    id: `scene:${n}`, name, scene: n, builtin: true,
    swatch: SCENE_SWATCH[n] ?? '#888',
    desc: `${name}: the light's own built-in effect (runs on the light, no Bluetooth traffic while it runs)`,
    params: [{ ...LEVEL(level), min: 0 }, ...(SCENE_SETTINGS[n] ?? []), DURATION],
  };
});

/** Removed app effects → the built-in effect that replaces them (old cues and settings are moved over). */
export const ALIASES = { cops: 'scene:2', tv: 'scene:4', fire: 'scene:11', candle: 'scene:3', party: 'scene:6' };
