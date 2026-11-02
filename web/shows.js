// Several shows (productions) in one browser. A show = its looks, cues, Effects-tab effects and Show-tab board
// (which effects and looks the Show tab offers, in what order).
// The open show lives in the usual keys (gvm.looks, gvm.cues, gvm.customfx), so the rest of the app is unchanged;
// the others are parked in gvm.showdata.<id>. Effect settings, preferences, lights and groups are shared.

const INDEX = 'gvm.shows';
const DATA = 'gvm.showdata.';
export const SHOW_KEYS = { looks: 'gvm.looks', cues: 'gvm.cues', customfx: 'gvm.customfx', board: 'gvm.board' };

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const uid = () => Math.random().toString(36).slice(2, 10);

export class Shows {
  constructor(storage = globalThis.localStorage) {
    this.s = storage;
    const idx = parse(this.s.getItem(INDEX));
    if (idx && Array.isArray(idx.list) && idx.list.some((x) => x.id === idx.current)) this.idx = idx;
    else { this.idx = { current: 'main', list: [{ id: 'main', name: 'My show' }] }; this._save(); }
  }
  _save() { this.s.setItem(INDEX, JSON.stringify(this.idx)); }

  get list() { return this.idx.list; }
  get current() { return this.idx.list.find((x) => x.id === this.idx.current); }

  /** The open show's data, as stored. */
  snapshot() {
    const o = {};
    for (const [k, key] of Object.entries(SHOW_KEYS)) { const v = this.s.getItem(key); if (v != null) o[k] = v; }
    return o;
  }

  /** How many looks / cues / effects a show has (for the list). */
  counts(id) {
    const d = id === this.idx.current ? this.snapshot() : parse(this.s.getItem(DATA + id)) ?? {};
    const n = (k) => { const v = parse(d[k] ?? null); return Array.isArray(v) ? v.length : null; };
    return { looks: n('looks'), cues: n('cues') ?? 0, effects: n('customfx') ?? 0 };
  }

  rename(id, name) {
    const x = this.idx.list.find((y) => y.id === id);
    if (!x || !name.trim()) return;
    x.name = name.trim().slice(0, 40);
    this._save();
  }

  /** Makes `id` the open show: parks the current one, loads the other into the live keys. Reload after. */
  open(id) {
    if (id === this.idx.current || !this.idx.list.some((x) => x.id === id)) return false;
    this.s.setItem(DATA + this.idx.current, JSON.stringify(this.snapshot()));
    const d = parse(this.s.getItem(DATA + id)) ?? {};
    for (const [k, key] of Object.entries(SHOW_KEYS)) {
      if (d[k] != null) this.s.setItem(key, d[k]); else this.s.removeItem(key);   // missing → app defaults
    }
    this.s.removeItem(DATA + id);
    this.idx.current = id;
    this._save();
    return true;
  }

  /** Adds a show: empty (default looks, no cues, no effects), or a copy of `from` (an id). Returns its id. */
  create(name, { from = null } = {}) {
    const id = uid();
    let data = {};
    if (from === this.idx.current) data = this.snapshot();
    else if (from) data = parse(this.s.getItem(DATA + from)) ?? {};
    this.s.setItem(DATA + id, JSON.stringify(data));
    this.idx.list.push({ id, name: (name || `Show ${this.idx.list.length + 1}`).trim().slice(0, 40) });
    this._save();
    return id;
  }

  /** Deletes a show that isn't open. */
  remove(id) {
    if (id === this.idx.current) return false;
    this.idx.list = this.idx.list.filter((x) => x.id !== id);
    this.s.removeItem(DATA + id);
    this._save();
    return true;
  }
}
