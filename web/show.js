// Show data kept in this browser: the looks library and the cue list.
//   look  = { id, name, state: {mode, cct, hue, sat, bri} }
//   cue   = { id, name, fade (s), follow (s | null), effect: null | {id, params, lightIds},
//             effects: null | [{id, params, lightIds}]   (several effects on different lights),
//             lights: { [lightId]: {power, mode, cct, hue, sat, bri} } }
import { LOOKS as DEFAULT_LOOKS } from './effects.js';

const LOOKS_KEY = 'gvm.looks';
const CUES_KEY = 'gvm.cues';

const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
export const uid = () => Math.random().toString(36).slice(2, 10);

/** Rounds a state to what the light can show. */
export function normState(s) {
  const out = { mode: s.mode === 'hsi' ? 'hsi' : 'cct' };
  out.cct = Math.min(5600, Math.max(3200, Math.round((s.cct ?? 5600) / 100) * 100));
  out.hue = Math.min(360, Math.max(0, Math.round((s.hue ?? 0) / 5) * 5));
  out.sat = Math.min(100, Math.max(0, Math.round(s.sat ?? 100)));
  out.bri = Math.min(100, Math.max(0, Math.round(s.bri ?? 50)));
  if (s.power != null) out.power = !!s.power;
  return out;
}

/** Interpolates two looks in the same mode; hue takes the shorter way round the color wheel. */
export function lerpState(a, b, t) {
  const d = ((((b.hue - a.hue) % 360) + 540) % 360) - 180;
  return {
    mode: b.mode,
    cct: a.cct + (b.cct - a.cct) * t,
    hue: (((a.hue + d * t) % 360) + 360) % 360,
    sat: a.sat + (b.sat - a.sat) * t,
    bri: a.bri + (b.bri - a.bri) * t,
  };
}

/** Look at progress t. White↔Color changes can't be blended, so they dip through dark at the midpoint. */
export function stateAt(plan, t) {
  const { from, to } = plan;
  if (from.mode === to.mode) return lerpState(from, to, t);
  if (t < 0.5) return { ...from, bri: from.bri * (1 - t * 2) };
  return { ...to, bri: to.bri * (t * 2 - 1) };
}

export function describeState(s) {
  if (!s) return '—';
  if (s.power === false) return 'off';
  return s.mode === 'hsi' ? `${s.hue}° · sat ${s.sat} · ${s.bri}%` : `${s.cct}K · ${s.bri}%`;
}

export class Show extends EventTarget {
  constructor() {
    super();
    const looks = read(LOOKS_KEY, null);
    this.looks = Array.isArray(looks) ? looks : DEFAULT_LOOKS.map((l) => ({ id: l.id, name: l.name, state: normState(l.state) }));
    const cues = read(CUES_KEY, []);
    this.cues = Array.isArray(cues) ? cues : [];
  }

  _changed(what) {
    write(what === 'looks' ? LOOKS_KEY : CUES_KEY, what === 'looks' ? this.looks : this.cues);
    this.dispatchEvent(new CustomEvent('change', { detail: { what } }));
  }

  // ---------- looks ----------
  addLook(state, name) {
    const n = this.looks.length + 1;
    const look = { id: uid(), name: name || `Look ${n}`, state: normState(state) };
    this.looks.push(look);
    this._changed('looks');
    return look;
  }
  updateLook(id, patch) {
    const l = this.looks.find((x) => x.id === id);
    if (!l) return;
    if (patch.name != null) l.name = patch.name.trim() || l.name;
    if (patch.state) l.state = normState(patch.state);
    this._changed('looks');
  }
  removeLook(id) { this.looks = this.looks.filter((l) => l.id !== id); this._changed('looks'); }
  moveLook(id, delta) { move(this.looks, id, delta); this._changed('looks'); }
  resetLooks() {
    this.looks = DEFAULT_LOOKS.map((l) => ({ id: l.id, name: l.name, state: normState(l.state) }));
    this._changed('looks');
  }

  // ---------- cues ----------
  /** Inserts a cue after index `after` (-1 = at start, null = at end). */
  addCue({ lights, effect = null, effects = null, fade = 2, follow = null, name }, after = null) {
    const cue = { id: uid(), name: name || '', fade, follow, effect, lights };
    if (effects?.length) cue.effects = effects;
    const at = after == null ? this.cues.length : after + 1;
    this.cues.splice(at, 0, cue);
    this._changed('cues');
    return cue;
  }
  updateCue(id, patch) {
    const c = this.cues.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    this._changed('cues');
  }
  removeCue(id) { this.cues = this.cues.filter((c) => c.id !== id); this._changed('cues'); }
  moveCue(id, delta) { move(this.cues, id, delta); this._changed('cues'); }
  cueIndex(id) { return this.cues.findIndex((c) => c.id === id); }
}

function move(arr, id, delta) {
  const i = arr.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
