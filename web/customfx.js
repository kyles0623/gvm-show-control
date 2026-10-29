// Custom effects built on the Effects tab: a looping list of steps, each a color + brightness held for a
// while, optionally faded into. Stored in this browser (localStorage 'gvm.customfx').
//   def  = { id, name, steps: [step] }
//   step = { mode: 'cct' | 'hsi', cct, hue, sat, bri, hold (s), fade (s),
//            briTo, holdTo, fadeTo }   ← optional: when set, a random value in [bri, briTo] etc. is picked each time
//                                        the step runs
// toEffect() turns a def into the same shape as the built-in EFFECTS, so the effect engine, cues and the
// settings panel treat both alike. The running effect reads the def live, so edits show up immediately.
import { MIN_STEP_MS, FAST_STEP_MS, SPEED, DURATION } from './effects.js';
import { normState, stateAt, uid } from './show.js';

const KEY = 'gvm.customfx';
const read = (d) => { try { const v = localStorage.getItem(KEY); return v == null ? d : JSON.parse(v); } catch { return d; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

export const PREFIX = 'custom:';
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

/** Range fields: [base, upper, lo, hi]. An upper bound turns the value into a random range. */
export const RANGES = { bri: ['bri', 'briTo', 0, 100], hold: ['hold', 'holdTo', FAST_STEP_MS / 1000, 600], fade: ['fade', 'fadeTo', 0, 60] };

export function normStep(s = {}) {
  const n = normState({ mode: s.mode, cct: s.cct, hue: s.hue, sat: s.sat, bri: s.bri ?? 50 });
  const out = { ...n, hold: clamp(s.hold, FAST_STEP_MS / 1000, 600, 1), fade: clamp(s.fade, 0, 60, 0) };
  for (const [base, to, lo, hi] of Object.values(RANGES)) {
    if (s[to] == null || !Number.isFinite(+s[to])) continue;
    const v = base === 'bri' ? Math.round(clamp(s[to], lo, hi, out[base])) : clamp(s[to], lo, hi, out[base]);
    // Keep base ≤ upper: a range entered backwards is swapped.
    if (v >= out[base]) out[to] = v; else { out[to] = out[base]; out[base] = v; }
  }
  return out;
}

/** The value this run of the step uses: fixed, or random within its range. */
export function pick(s, key, rnd = Math.random) {
  const [base, to] = RANGES[key];
  if (s[to] == null) return s[base];
  const v = s[base] + (s[to] - s[base]) * rnd();
  return key === 'bri' ? Math.round(v) : v;
}

function normDef(d) {
  return { id: String(d.id || uid()), name: String(d.name || 'Custom effect').slice(0, 40), steps: (Array.isArray(d.steps) ? d.steps : []).slice(0, 64).map(normStep) };
}

/** CSS color for a step (for swatches). */
export function stepColor(s) {
  if (s.mode === 'hsi') return `hsl(${s.hue} ${s.sat}% ${Math.round(85 - s.sat * 0.35)}%)`;
  const t = Math.min(1, Math.max(0, (s.cct - 3200) / 2400));   // 0 = 3200 K (warm) … 1 = 5600 K (cool white)
  const mix = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${mix(255, 244)} ${mix(180, 241)} ${mix(107, 255)})`;
}

export class CustomEffects extends EventTarget {
  constructor() {
    super();
    this.list = read([]).map(normDef);
  }
  _changed() { write(this.list); this.dispatchEvent(new Event('change')); }
  get(id) { return this.list.find((d) => d.id === id) ?? null; }
  add(name, steps) {
    const d = normDef({ name: name || this._uniqueName('My effect'), steps: steps ?? [
      { mode: 'hsi', hue: 0, sat: 100, bri: 40, hold: 1, fade: 0.5 },
      { mode: 'hsi', hue: 240, sat: 100, bri: 40, hold: 1, fade: 0.5 },
    ] });
    this.list.push(d);
    this._changed();
    return d;
  }
  duplicate(id) {
    const d = this.get(id);
    if (!d) return null;
    const c = normDef({ ...structuredClone(d), id: uid(), name: this._uniqueName(`${d.name} copy`) });
    this.list.splice(this.list.indexOf(d) + 1, 0, c);
    this._changed();
    return c;
  }
  rename(id, name) { const d = this.get(id); if (d) { d.name = String(name || d.name).slice(0, 40); this._changed(); } }
  setSteps(id, steps) { const d = this.get(id); if (d) { d.steps = steps.slice(0, 64).map(normStep); this._changed(); } }
  remove(id) { this.list = this.list.filter((d) => d.id !== id); this._changed(); }
  _uniqueName(base) {
    const used = new Set(this.list.map((d) => d.name));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }
  /** Effect objects for the engine, in list order. */
  effects() { return this.list.map((d) => toEffect(d, () => this.get(d.id))); }
}

/** Cycle length in seconds at speed 1. */
/** Cycle length in seconds at speed 1 (random holds/fades count at their average). */
export const cycleSeconds = (def) => def.steps.reduce((t, s) => t + (s.hold + (s.holdTo ?? s.hold)) / 2 + (s.fade + (s.fadeTo ?? s.fade)) / 2, 0);
export const hasRandom = (def) => def.steps.some((s) => s.briTo != null || s.holdTo != null || s.fadeTo != null);

/** Values a step changes compared with the step before it (each costs one write, at least 60 ms). */
export function changedValues(prev, s) {
  if (!prev) return s.mode === 'cct' ? 3 : 4;
  let n = 0;
  if (prev.mode !== s.mode) n++;
  if (s.mode === 'cct') { if (prev.cct !== s.cct || prev.mode !== s.mode) n++; }
  else { if (prev.hue !== s.hue || prev.mode !== s.mode) n++; if (prev.sat !== s.sat || prev.mode !== s.mode) n++; }
  if (prev.bri !== s.bri || s.briTo != null) n++;
  return n;
}

export function toEffect(def, live = () => def) {
  return {
    id: PREFIX + def.id,
    name: def.name,
    custom: true,
    perLight: false,
    swatch: def.steps.length > 1
      ? `linear-gradient(90deg, ${def.steps.slice(0, 6).map((s) => stepColor(s)).join(', ')})`
      : def.steps.length ? stepColor(def.steps[0]) : '#333',
    desc: `Custom: ${def.steps.length} step${def.steps.length === 1 ? '' : 's'}, ${hasRandom(def) ? '≈ ' : ''}${cycleSeconds(def).toFixed(1)} s per cycle`,
    params: [SPEED(1, 4), DURATION],
    *steps(p) {
      let prev = null;
      for (;;) {
        const d = live();                                 // re-read each cycle: edits apply while running
        if (!d || !d.steps.length) return;
        for (const s of d.steps) {
          const to = normState({ ...s, bri: pick(s, 'bri') });
          const fadeMs = (pick(s, 'fade') * 1000) / p.speed;
          const holdS = pick(s, 'hold');
          // Fade: intermediate steps of at least 250 ms (never faster than MIN_STEP_MS). White↔Color dips through dark.
          const n = prev ? Math.min(40, Math.floor(fadeMs / 250)) : 0;
          for (let k = 1; k < n; k++) yield { state: normState(stateAt({ from: prev, to }, k / n)), wait: fadeMs / n };
          yield { state: to, wait: Math.max(FAST_STEP_MS, (holdS * 1000) / p.speed + (n ? fadeMs / n : 0)) };
          prev = to;
        }
      }
    },
  };
}
