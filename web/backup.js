// Backup file: looks, cues, the Effects-tab effects, effect settings and app preferences, as one JSON file.
// Everything else the app keeps lives only in this browser (localStorage), so this is the way to move a show
// to another computer or keep it safe if the browser's site data is cleared.
//
// Light ids are made by the browser per paired light, so the same light has a different id in another browser.
// Cues store settings per light id; on import they're moved onto the lights picked in the light map.

export const FORMAT = 1;
const APP = 'gvm-show-control';

// localStorage keys in each part of the backup.
const K = { looks: 'gvm.looks', cues: 'gvm.cues', customfx: 'gvm.customfx', lights: 'gvm.lights' };
const PREF = 'gvm.ui.';
// Preferences that belong to this browser, not to the show.
const LOCAL_PREFS = new Set(['setupDone', 'lastVersion', 'lightName', 'tab', 'cuePanel']);

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };

/** Reads the backup out of a Storage (localStorage). */
export function buildBackup(storage, version) {
  const prefs = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k?.startsWith(PREF)) continue;
    const name = k.slice(PREF.length);
    if (LOCAL_PREFS.has(name)) continue;
    const v = parse(storage.getItem(k));
    if (v !== null) prefs[name] = v;
  }
  const arr = (k) => { const v = parse(storage.getItem(k)); return Array.isArray(v) ? v : null; };
  return {
    app: APP, format: FORMAT, version, exported: new Date().toISOString(),
    looks: arr(K.looks), cues: arr(K.cues), customEffects: arr(K.customfx),
    lights: (arr(K.lights) ?? []).map(({ id, label, name }) => ({ id, label, name })),
    prefs,
  };
}

/** Checks a file's text. Returns { backup } or { error }. */
export function parseBackup(text) {
  const b = parse(text);
  if (!b || typeof b !== 'object' || b.app !== APP) return { error: 'This isn’t a GVM Show Control backup file.' };
  if (!(b.format <= FORMAT)) return { error: `This backup is from a newer version of the app (${b.version ?? '?'}). Update the app first.` };
  for (const k of ['looks', 'cues', 'customEffects']) if (b[k] != null && !Array.isArray(b[k])) return { error: `The backup's ${k} are damaged.` };
  if (b.prefs != null && typeof b.prefs !== 'object') return { error: 'The backup’s settings are damaged.' };
  return { backup: { ...b, lights: Array.isArray(b.lights) ? b.lights : [], prefs: b.prefs ?? {} } };
}

/** What a backup holds, for the import dialog. */
export function summarize(b) {
  return {
    looks: b.looks?.length ?? 0, cues: b.cues?.length ?? 0, customEffects: b.customEffects?.length ?? 0,
    prefs: Object.keys(b.prefs).length, lights: b.lights.length,
  };
}

/** Starting light map: backup light id → current light id (or ''): same id, else same name, else same position. */
export function defaultLightMap(backupLights, current) {
  const map = {}, used = new Set();
  const take = (bl, cl) => { map[bl.id] = cl.id; used.add(cl.id); };
  for (const bl of backupLights) { const c = current.find((l) => l.id === bl.id); if (c) take(bl, c); }
  for (const bl of backupLights) {
    if (map[bl.id]) continue;
    const c = current.find((l) => !used.has(l.id) && l.label && l.label === bl.label);
    if (c) take(bl, c);
  }
  backupLights.forEach((bl, i) => {
    if (map[bl.id]) return;
    const c = current[i] && !used.has(current[i].id) ? current[i] : null;
    if (c) take(bl, c); else map[bl.id] = '';
  });
  return map;
}

/** A cue with its light ids moved through the map; lights mapped to '' (or not in the backup) are dropped. */
function remapCue(cue, map) {
  const to = (id) => (id in map ? map[id] : id);
  const lights = {};
  for (const [id, st] of Object.entries(cue.lights ?? {})) { const n = to(id); if (n) lights[n] = st; }
  const fx = (e) => (e ? { ...e, lightIds: e.lightIds ? e.lightIds.map(to).filter(Boolean) : e.lightIds } : e);
  return { ...cue, lights, effect: fx(cue.effect), effects: Array.isArray(cue.effects) ? cue.effects.map(fx) : cue.effects };
}

/** Joins two lists by id: items in `add` replace the same id in `base`, new ones go on the end. */
function mergeById(base, add) {
  const out = [...(base ?? [])];
  for (const x of add) {
    const i = out.findIndex((y) => y.id === x.id);
    if (i >= 0) out[i] = x; else out.push(x);
  }
  return out;
}

/**
 * Writes the chosen parts into a Storage.
 *   parts: { looks, cues, customEffects, prefs, lightNames } (booleans)
 *   mode:  'replace' (what's here goes) | 'merge' (adds to what's here; same id → the backup's)
 *   map:   backup light id → current light id or ''
 * Returns the number of items written per part.
 */
export function applyBackup(storage, b, { parts, mode = 'replace', map = {} }) {
  const done = {};
  const list = (key, items) => {
    const cur = parse(storage.getItem(key));
    const next = mode === 'merge' ? mergeById(Array.isArray(cur) ? cur : [], items) : items;
    storage.setItem(key, JSON.stringify(next));
    return items.length;
  };
  if (parts.looks && b.looks) done.looks = list(K.looks, b.looks);
  if (parts.customEffects && b.customEffects) done.customEffects = list(K.customfx, b.customEffects);
  if (parts.cues && b.cues) done.cues = list(K.cues, b.cues.map((c) => remapCue(c, map)));
  if (parts.prefs) {
    if (mode === 'replace') {
      const drop = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(PREF) && !LOCAL_PREFS.has(k.slice(PREF.length))) drop.push(k);
      }
      for (const k of drop) storage.removeItem(k);
    }
    let n = 0;
    for (const [name, v] of Object.entries(b.prefs)) {
      if (LOCAL_PREFS.has(name)) continue;
      storage.setItem(PREF + name, JSON.stringify(v)); n++;
    }
    done.prefs = n;
  }
  if (parts.lightNames) {
    const cur = parse(storage.getItem(K.lights));
    if (Array.isArray(cur)) {
      let n = 0;
      for (const bl of b.lights) {
        const l = cur.find((x) => x.id === map[bl.id]);
        if (l && bl.label) { l.label = bl.label; n++; }
      }
      storage.setItem(K.lights, JSON.stringify(cur));
      done.lightNames = n;
    }
  }
  return done;
}

export function backupFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `gvm-show-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}
