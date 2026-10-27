import { GVMProtocol as P } from './gvm-protocol.js';
import { parseHex, toHex, shortUuid, sleep } from './ble.js';
import { Rig } from './rig.js';
import { Show, describeState, normState, stateAt } from './show.js';
import { EFFECTS, defaults } from './effects.js';
import { APP_VERSION, detectEnv, blockReason, bluetoothSteps, explainProblem, LIGHT_STEPS, OS_NAME, BROWSER_NAME } from './setup.js';

const env = detectEnv();
const rig = new Rig();
const show = new Show();

const $ = (id) => document.getElementById(id);
const THROTTLE_MS = 150;   // live slider send interval (official app: ~300 ms while dragging)
const FADE_MAX_MS = 10000;

// Fade slider: quadratic so the left third covers 0-1 s (fine steps), the rest up to 10 s.
function fadePosToMs(p) {
  if (p <= 0) return 0;
  const ms = FADE_MAX_MS * (p / 100) ** 2;
  const q = ms < 1000 ? 50 : ms < 3000 ? 100 : 250;
  return Math.max(50, Math.round(ms / q) * q);
}
const fadeMsToPos = (ms) => Math.round(100 * Math.sqrt(Math.min(ms, FADE_MAX_MS) / FADE_MAX_MS));
const fadeLabel = (ms) => (ms === 0 ? ['Snap', ''] : [ms < 1000 ? (ms / 1000).toFixed(2) : (ms / 1000).toFixed(1).replace(/\.0$/, ''), 's']);

const ui = {
  fadeMs: 0,
  mode: 'cct',
  locked: false,
  dragging: null,      // id of slider being dragged
  fadeToken: 0,
  fading: false,
  fadeT: 0,            // progress of the running fade, 0..1
  busy: false,         // blackout/restore in progress
};

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('gvm.ui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gvm.ui.' + k, JSON.stringify(v)); } catch {} },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const each = (arr, fn) => Promise.all(arr.map(fn));

// ---------- light helpers ----------

const primary = () => rig.primary();
const PL = () => primary()?.conn.light ?? {};
const targets = () => rig.targets();
const isDarkLight = (l) => l.conn.light.power === false;
const allDark = () => rig.connected.length > 0 && rig.connected.every(isDarkLight);
const isDark = () => targets().length > 0 && targets().every(isDarkLight);

/** A light's current look, with defaults for anything not reported yet. */
function stateOf(l) {
  const x = l.conn.light;
  return { mode: x.mode ?? 'cct', cct: x.cct ?? 5600, hue: x.hue ?? 0, sat: x.saturation ?? 100, bri: x.brightness ?? 0 };
}

// ---------- color preview ----------

function kelvinToRgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  return [r, g, b].map((x) => clamp(x, 0, 255));
}
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
/** CSS color for a state (brightness applied unless full=true). */
function stateColor(s, { full = false } = {}) {
  if (!s || s.power === false) return '#000';
  const b = full ? 1 : Math.max(0.15, (s.bri ?? 100) / 100);
  const rgb = s.mode === 'hsi' ? hsvToRgb(s.hue ?? 0, (s.sat ?? 100) / 100, b) : kelvinToRgb(s.cct ?? 5600).map((x) => x * b);
  return `rgb(${rgb.map(Math.round).join(',')})`;
}

function renderPreview() {
  const b = +$('bri').value / 100;
  const rgb = ui.mode === 'cct' ? kelvinToRgb(+$('cct').value).map((x) => x * b)
                                : hsvToRgb(+$('hue').value, +$('sat').value / 100, b);
  const on = PL().power !== false;
  $('preview').style.background = on ? `rgb(${rgb.map(Math.round).join(',')})` : '#000';
  document.documentElement.style.setProperty('--sat-color', `hsl(${$('hue').value} 100% 50%)`);
}

function renderValues() {
  $('briVal').textContent = $('bri').value;
  $('cctVal').textContent = $('cct').value;
  $('hueVal').textContent = $('hue').value;
  $('satVal').textContent = $('sat').value;
  renderPreview();
}

// ---------- connection status & light chips ----------

const STATUS_TEXT = {
  unsupported: 'Web Bluetooth unavailable', idle: 'Not connected', connecting: 'Connecting…',
  connected: 'Connected', reconnecting: 'Reconnecting…', disconnected: 'Disconnected',
};

function aggregateStatus() {
  if (!rig.supported) return 'unsupported';
  const st = rig.lights.map((l) => l.conn.status);
  if (!st.length) return 'idle';
  if (st.every((s) => s === 'connected')) return 'connected';
  if (st.some((s) => s === 'reconnecting')) return 'reconnecting';
  if (st.some((s) => s === 'connecting')) return 'connecting';
  if (st.some((s) => s === 'connected')) return 'connected';
  return st.includes('disconnected') ? 'disconnected' : 'idle';
}

function renderConn() {
  const n = rig.lights.length, c = rig.connected.length;
  const s = aggregateStatus();
  const partial = n > 1 && c > 0 && c < n;
  $('connDot').className = 'dot ' + (partial ? 'reconnecting' : s);
  if (!rig.supported) $('connText').textContent = STATUS_TEXT.unsupported;
  else if (!n) $('connText').textContent = 'No light paired';
  else if (n === 1) $('connText').textContent = STATUS_TEXT[rig.lights[0].conn.status];
  else $('connText').textContent = `${c} of ${n} lights connected`;
  if (n === 1) $('connSub').textContent = [rig.lights[0].label, rig.lights[0].conn.statusDetail].filter(Boolean).join(' · ');
  else if (n > 1) {
    const down = rig.lights.filter((l) => !l.conn.connected).map((l) => `${l.label}: ${STATUS_TEXT[l.conn.status].toLowerCase().replace('…', '')}`);
    $('connSub').textContent = down.length ? down.join(' · ') : rig.lights.map((l) => l.label).join(' · ');
  } else $('connSub').textContent = '—';
  const btn = $('connectBtn');
  btn.hidden = !rig.supported || (n > 0 && c === n) || rig.lights.some((l) => l.conn.status === 'connecting');
  btn.textContent = !n ? 'Pair light' : rig.lights.some((l) => l.conn.status === 'reconnecting') ? 'Retry now' : 'Connect';
  const on = rig.anyConnected;
  for (const el of document.querySelectorAll('#tab-show button, #tab-show input[type=range]')) {
    if (el.closest('.fx-settings')) continue;          // effect settings stay editable offline
    el.disabled = !on;
  }
  renderChips();
  renderCueBar();
  updateWakeLock();
  renderLight();
}

function renderChips() {
  const bar = $('lightChips');
  bar.hidden = rig.lights.length < 2;
  bar.innerHTML = '';
  if (bar.hidden) return;
  const all = document.createElement('button');
  all.className = 'lchip' + (rig.selection ? '' : ' sel');
  all.textContent = 'All';
  all.title = 'Controls act on every light';
  all.addEventListener('click', () => rig.select(null));
  bar.appendChild(all);
  for (const l of rig.lights) {
    const b = document.createElement('button');
    b.className = 'lchip' + (rig.selection && rig.isSelected(l.id) ? ' sel' : '');
    b.dataset.id = l.id;
    b.title = `${l.label}: ${STATUS_TEXT[l.conn.status]}${l.conn.connected ? ` · ${describeState({ ...stateOf(l), power: l.conn.light.power })}` : ''}\nClick: control only this light · Shift/⌘-click: add or remove`;
    const dot = document.createElement('span'); dot.className = 'dot ' + l.conn.status;
    const sw = document.createElement('span'); sw.className = 'lsw'; sw.style.background = l.conn.connected ? stateColor({ ...stateOf(l), power: l.conn.light.power }) : '#222';
    b.append(dot, sw, l.label);
    b.addEventListener('click', (e) => rig.select(l.id, { add: e.shiftKey || e.metaKey || e.ctrlKey }));
    bar.appendChild(b);
  }
}

async function onConnectClick() {
  if (!rig.lights.length) { rig.pair(); return; }
  const retrying = rig.lights.filter((l) => l.conn.status === 'reconnecting' && l.conn.device);
  if (retrying.length) { retrying.forEach((l) => rig.reconnect(l)); return; }
  if (!(await rig.restoreAll())) rig.pair();
}

// ---------- light state → UI ----------

function setMode(m) {
  ui.mode = m;
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.mode === m);
  $('cctPanel').hidden = m !== 'cct';
  $('hsiPanel').hidden = m !== 'hsi';
  renderPreview();
}

function renderLight() {
  const L = PL();
  const known = L.power != null;
  const tOn = targets().some((l) => l.conn.light.power === true);
  $('powerBtn').classList.toggle('on', tOn);
  $('powerState').textContent = !known ? '—' : tOn ? 'ON' : 'OFF';
  const dark = allDark();
  $('blackoutBtn').classList.toggle('restore', dark);
  $('blackoutLabel').textContent = dark ? 'RESTORE' : 'BLACKOUT';
  if (!known) { $('readout').textContent = '—'; return; }
  const color = L.mode === 'hsi' ? `hue ${L.hue}° sat ${L.saturation}%` : `${L.cct}K`;
  const who = rig.lights.length > 1 ? `${primary().label}: ` : '';
  $('readout').textContent = `${who}${L.power ? 'ON' : 'OFF'} · ${L.brightness}% · ${color} · ${L.mode === 'hsi' ? 'COLOR' : 'WHITE'}`;
  renderPreview();
}

/** Sliders follow the primary light (first selected). */
function syncFromLight(ev) {
  const p = primary();
  if (ev?.detail?.light && p && ev.detail.light !== p) { renderChipsSoon(); renderLight(); return; }
  const L = PL();
  if (L.brightness != null && !ui.fading && ui.dragging !== 'bri') $('bri').value = L.brightness;
  if (L.cct != null && ui.dragging !== 'cct') $('cct').value = L.cct;
  if (L.hue != null && ui.dragging !== 'hue') $('hue').value = L.hue;
  if (L.saturation != null && ui.dragging !== 'sat') $('sat').value = L.saturation;
  if (L.mode && !ui.dragging) setMode(L.mode);
  renderValues();
  renderLight();
  renderChipsSoon();
}

let chipsTimer = null;
function renderChipsSoon() { if (!chipsTimer) chipsTimer = setTimeout(() => { chipsTimer = null; renderChips(); }, 200); }

setInterval(() => {
  const p = primary();
  if (!p?.conn.connected) { $('readoutAge').textContent = ''; return; }
  if (!p.conn.lastStatusAt) { $('readoutAge').textContent = 'waiting for first status…'; return; }
  const s = Math.round((Date.now() - p.conn.lastStatusAt) / 1000);
  $('readoutAge').textContent = s > 12 ? `no status for ${s}s` : `status ${s}s ago`;
}, 1000);

// ---------- sending ----------

const FIELD = { bri: 'brightness', cct: 'cct', hue: 'hue', sat: 'saturation' };
const ENC = { cct: P.cct, hue: P.hue, sat: P.saturation, bri: P.brightness };

const encoders = {
  bri: (v) => ({ frames: P.brightness(v), label: `brightness ${v}%` }),
  cct: (v) => ({ frames: P.cct(v), label: `cct ${v}K`, mode: 'cct' }),
  hue: (v) => ({ frames: P.hue(v), label: `hue ${v}°`, mode: 'hsi' }),
  sat: (v) => ({ frames: P.saturation(v), label: `saturation ${v}%`, mode: 'hsi' }),
};

async function ensureModeOn(l, m, quiet = true) {
  if (l.conn.light.mode === m) return;
  l.conn.light.mode = m;
  await l.conn.sendFrames(P.mode(m), `mode ${m}`, { quiet });
}

/** Sends one control value to every target light. */
async function sendValue(id, v, { quiet = true } = {}) {
  const e = encoders[id](v);
  if (e.mode) setMode(e.mode);
  await each(targets(), async (l) => {
    if (id === 'bri' && isDarkLight(l)) l.blackoutPre = null;   // a level set while dark is what Restore returns to
    if (e.mode) await ensureModeOn(l, e.mode);
    await l.conn.sendFrames(e.frames, e.label, { quiet });
  });
}

/** Sends only the params that differ from the light's known state: mode first, brightness last. */
async function applyStateTo(l, s, { quiet = true, guard = () => true } = {}) {
  const L = l.conn.light;
  if (s.mode && L.mode !== s.mode) {
    if (!guard()) return;
    await l.conn.sendFrames(P.mode(s.mode), `mode ${s.mode}`, { quiet });
    L.mode = s.mode;
  }
  for (const k of ['cct', 'hue', 'sat', 'bri']) {
    if (s[k] == null) continue;
    if (k === 'cct' && (s.mode ?? L.mode) === 'hsi') continue;          // color of the other mode is irrelevant
    if ((k === 'hue' || k === 'sat') && (s.mode ?? L.mode) === 'cct') continue;
    const v = k === 'hue' ? clamp(Math.round(s[k] / 5) * 5, 0, 360) : k === 'cct' ? clamp(Math.round(s[k] / 100) * 100, 3200, 5600) : clamp(Math.round(s[k]), 0, 100);
    if (L[FIELD[k]] === v) continue;
    if (!guard()) return;
    if (k === 'bri' && isDarkLight(l)) l.blackoutPre = null;
    await l.conn.sendFrames(ENC[k](v), `${FIELD[k]} ${v}`, { quiet });
    L[FIELD[k]] = v;
  }
}

/** Live slider: throttled sends while dragging, final send + one log line on release. */
function bindLiveSlider(id) {
  const el = $(id);
  let last = 0, trailing = null, lastSent = null;
  const fire = () => {
    const v = +el.value;
    if (v === lastSent) return;
    lastSent = v;
    sendValue(id, v);
  };
  el.addEventListener('pointerdown', () => { takeover(); ui.dragging = id; lastSent = null; if (id === 'bri') cancelFade(); });
  el.addEventListener('input', () => {
    renderValues();
    const now = performance.now();
    clearTimeout(trailing);
    if (now - last >= THROTTLE_MS) { last = now; fire(); }
    else trailing = setTimeout(() => { last = performance.now(); fire(); }, THROTTLE_MS - (now - last));
  });
  el.addEventListener('change', () => {
    clearTimeout(trailing);
    fire();
    rig.logLine(`SET ${encoders[id](+el.value).label}${rig.lights.length > 1 ? ` → ${targets().map((l) => l.label).join(', ')}` : ''}`);
    setTimeout(() => { if (ui.dragging === id) ui.dragging = null; }, 400);
  });
}

// ---------- crossfades ----------

function cancelFade() { ui.fadeToken++; ui.fading = false; ui.fadeT = 0; $('fadeStatus').textContent = ''; }

/**
 * Fades each light from its current look to `to` (partial looks keep the other values) over `ms`.
 * Returns false if cancelled by another fade, blackout, or manual control.
 */
async function crossfade(jobs, ms, { label = 'FADE' } = {}) {
  const token = ++ui.fadeToken;
  const guard = () => token === ui.fadeToken;
  const plans = jobs.filter((j) => j.light.conn.connected).map(({ light, to }) => {
    const from = stateOf(light);
    return { light, from, to: { ...from, ...to } };
  });
  if (!plans.length) return true;
  if (ms <= 0) {
    await each(plans, (p) => applyStateTo(p.light, p.to, { guard }));
    syncFromLight();
    return guard();
  }
  rig.logLine(`${label}: ${ms / 1000}s · ${plans.map((p) => `${p.light.label} → ${describeState(normState(p.to))}`).join(' · ')}`);
  ui.fading = true;
  const stepMs = ms <= 1500 ? 70 : 120;
  const start = performance.now();
  for (;;) {
    if (!guard()) { rig.logLine(`${label} cancelled`); return false; }
    const t = Math.min(1, (performance.now() - start) / ms);
    ui.fadeT = t;
    await each(plans, (p) => applyStateTo(p.light, stateAt(p, t), { guard }));
    const pl = plans.find((p) => p.light === primary());
    if (pl) { $('bri').value = Math.round(stateAt(pl, t).bri); renderValues(); }
    $('fadeStatus').textContent = `fading… ${Math.round(t * 100)}%`;
    if (t >= 1) break;
    await sleep(stepMs);
  }
  if (!guard()) return false;
  ui.fading = false;
  ui.fadeT = 0;
  $('fadeStatus').textContent = '';
  syncFromLight();
  return true;
}

// ---------- blackout (always all lights) ----------

function setBusy(b) {
  ui.busy = b;
  $('blackoutBtn').classList.toggle('busy', b);
}

async function blackout() {
  const lights = rig.connected.filter((l) => !isDarkLight(l));
  for (const l of lights) l.blackoutPre = l.conn.light.brightness ?? +$('bri').value;
  setBusy(true);
  try {
    if (ui.fadeMs > 0 && !(await crossfade(lights.map((l) => ({ light: l, to: { bri: 0 } })), ui.fadeMs, { label: 'BLACKOUT fade' }))) return;
    await each(lights, (l) => l.conn.sendFrames(P.power(false), 'BLACKOUT'));
  } finally { setBusy(false); }
}

/** Powers dark lights back on and returns each to its pre-blackout brightness (fading if a fade time is set). */
async function restore() {
  const lights = rig.connected.filter(isDarkLight);
  const fade = ui.fadeMs > 0;
  setBusy(true);
  try {
    const target = new Map(lights.map((l) => [l, l.blackoutPre ?? l.conn.light.brightness ?? +$('bri').value]));
    await each(lights, async (l) => {
      if (fade && l.conn.light.brightness !== 0) await l.conn.sendFrames(P.brightness(0), 'restore prep', { quiet: true });
      await l.conn.sendFrames(P.power(true), 'RESTORE');
      if (fade) l.conn.light.brightness = 0;
      else if (l.conn.light.brightness !== target.get(l)) await l.conn.sendFrames(P.brightness(target.get(l)), 'restore level');
    });
    if (fade && !(await crossfade(lights.map((l) => ({ light: l, to: { bri: target.get(l) } })), ui.fadeMs, { label: 'RESTORE fade' }))) return;
    for (const l of lights) l.blackoutPre = null;
  } finally { setBusy(false); }
}

function toggleBlackout() {
  if (!rig.anyConnected || ui.busy) return;
  clearFollow();
  stopEffect(false);
  cancelFade();
  if (allDark()) restore(); else blackout();
}

// ---------- looks ----------

const LOOK_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const EFFECT_KEYS = ['q', 'w', 'e', 'r', 't', 'y'];

async function applyLook(look, { fadeMs = ui.fadeMs } = {}) {
  const lights = targets();
  if (!lights.length) return;
  stopEffect(false);
  clearFollow();
  fx.look = look.id;
  renderPresets();
  rig.logLine(`LOOK ${look.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: look.state })), fadeMs, { label: `LOOK ${look.name}` });
}

function saveCurrentLook() {
  const p = primary();
  if (!p?.conn.connected) return;
  const look = show.addLook(stateOf(p));
  fx.look = look.id;
  renderPresets();
  toast({ level: 'ok', title: `Saved “${look.name}”`, body: 'Rename, reorder or delete it on the Cues tab.', actions: [{ label: 'Open Cues tab', fn: () => showTab('cues') }] });
}

// ---------- effects ----------

const fx = { id: null, token: 0, snapshot: null, look: null, selected: null, params: {}, lights: [], deadline: 0 };

// Live per-effect params (the running generator reads this same object every step).
for (const e of EFFECTS) {
  const saved = prefs.get('fx.' + e.id, {});
  fx.params[e.id] = { ...defaults(e) };
  for (const d of e.params) if (saved[d.id] != null) fx.params[e.id][d.id] = saved[d.id];
}
fx.selected = prefs.get('fx.selected', EFFECTS[0].id);
if (!EFFECTS.some((e) => e.id === fx.selected)) fx.selected = EFFECTS[0].id;

/**
 * Starts an effect on `lights` (default: selected lights), or stops it if it is running.
 * Random effects (perLight) run an independent pattern on each light; others stay in sync,
 * and steps with `alt` give every other light the alternate color when params.multi = 'alternate'.
 */
async function toggleEffect(e, { params = fx.params[e.id], lights = targets(), fromCue = false } = {}) {
  if (!lights.length) return;
  if (fx.id === e.id && !fromCue) { stopEffect(true); return; }
  const snapshot = fx.id ? fx.snapshot : new Map(lights.map((l) => [l.id, stateOf(l)]));
  stopEffect(false);
  cancelFade();
  if (!fromCue) clearFollow();
  const token = ++fx.token;
  Object.assign(fx, { id: e.id, snapshot, lights, look: null, deadline: params.duration > 0 ? performance.now() + params.duration * 1000 : Infinity });
  selectEffect(e.id);
  renderPresets();
  rig.logLine(`EFFECT ${e.name} start on ${lights.map((l) => l.label).join(', ')}${params.duration > 0 ? ` for ${params.duration}s` : ''}`);
  const guard = () => token === fx.token;
  await each(lights.filter(isDarkLight), (l) => { l.blackoutPre = null; return l.conn.sendFrames(P.power(true), 'power on (effect)'); });

  const run = async (gen, group) => {
    for (const step of gen) {
      if (!guard() || performance.now() >= fx.deadline) break;
      const t0 = performance.now();
      await each(group, (l) => {
        if (!l.conn.connected) return null;
        const alt = step.alt && params.multi === 'alternate' && lights.indexOf(l) % 2 === 1;
        return applyStateTo(l, alt ? step.alt : step.state, { guard });
      });
      if (group.includes(primary())) syncFromLight();
      const rest = Math.min(step.wait - (performance.now() - t0), fx.deadline - performance.now());
      if (rest > 0) await sleep(rest);
    }
  };
  if (e.perLight) await each(lights, (l) => run(e.steps(params), [l]));
  else await run(e.steps(params), lights);

  if (fx.token !== token) return;
  if (performance.now() >= fx.deadline) {
    rig.logLine(`EFFECT ${e.name} finished after ${params.duration}s`);
    await stopEffect(true);
  } else { fx.id = null; renderPresets(); }
}

/** Manual control: stop any effect without restoring, clear the active look highlight. */
function takeover() { stopEffect(false); clearFollow(); if (fx.look) { fx.look = null; renderPresets(); } }

/** restore=true returns each light to the look it had when the effect started. */
async function stopEffect(restore) {
  if (!fx.id) return;
  const name = EFFECTS.find((x) => x.id === fx.id)?.name;
  const snap = fx.snapshot, lights = fx.lights;
  fx.token++;
  fx.id = null;
  renderPresets();
  rig.logLine(`EFFECT ${name} stop${restore ? ' (restore previous look)' : ''}`);
  if (restore && snap) {
    await each(lights.filter((l) => l.conn.connected && snap.has(l.id)), (l) => applyStateTo(l, snap.get(l.id), { quiet: false }));
    syncFromLight();
  }
}

function tile(item, key, kind) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.dataset.id = item.id;
  b.title = item.desc ?? '';
  b.innerHTML = `<span class="sw"></span><span class="nm"></span><span class="key"></span>`;
  b.querySelector('.sw').style.setProperty('--sw', kind === 'look' ? stateColor(item.state, { full: true }) : item.swatch);
  b.querySelector('.nm').textContent = item.name;
  if (kind === 'look') {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = describeState(item.state);
    b.querySelector('.nm').appendChild(sub);
  }
  b.querySelector('.key').textContent = key ? key.toUpperCase() : '';
  if (!key) b.querySelector('.key').remove();
  b.addEventListener('click', () => (kind === 'look' ? applyLook(item) : toggleEffect(item)));
  return b;
}

function fmtParam(d, v) {
  if (d.kind === 'choice') return d.options.find((o) => o[0] === v)?.[1] ?? v;
  if (d.id === 'duration') return v > 0 ? `${v} s` : 'until stopped';
  if (d.unit === '×') return v.toFixed(2).replace(/0$/, '') + '×';
  if (d.unit === 's') return v.toFixed(1).replace(/\.0$/, '') + ' s';
  return `${v}${d.unit}`;
}

function saveParams(id) { prefs.set('fx.' + id, fx.params[id]); }

function selectEffect(id) {
  fx.selected = id;
  prefs.set('fx.selected', id);
  $('fxSelect').value = id;
  renderFxParams();
}

function renderFxParams() {
  const e = EFFECTS.find((x) => x.id === fx.selected);
  const p = fx.params[e.id];
  const box = $('fxParams');
  box.innerHTML = '';
  $('fxRunning').textContent = fx.id === e.id ? '● running' : '';
  for (const d of e.params) {
    if (d.id === 'multi' && rig.lights.length < 2) continue;      // only meaningful with several lights
    const wrap = document.createElement('div');
    wrap.className = 'fx-param';
    const head = document.createElement('div');
    head.className = 'row-between';
    head.innerHTML = '<div class="label"></div><div class="val"></div>';
    head.firstChild.textContent = d.label;
    const val = head.lastChild;
    val.textContent = fmtParam(d, p[d.id]);
    wrap.appendChild(head);
    if (d.kind === 'choice') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [v, label] of d.options) {
        const b = document.createElement('button');
        b.textContent = label;
        b.classList.toggle('active', p[d.id] === v);
        b.addEventListener('click', () => {
          p[d.id] = v; saveParams(e.id);
          for (const x of seg.children) x.classList.toggle('active', x === b);
          val.textContent = fmtParam(d, v);
        });
        seg.appendChild(b);
      }
      wrap.appendChild(seg);
    } else {
      const r = document.createElement('input');
      r.type = 'range';
      r.className = 'range ' + d.kind;
      Object.assign(r, { min: d.min, max: d.max, step: d.step });
      r.value = p[d.id];
      r.setAttribute('aria-label', `${e.name} ${d.label}`);
      r.addEventListener('input', () => {
        p[d.id] = +r.value;
        val.textContent = fmtParam(d, p[d.id]);
        if (d.id === 'duration' && fx.id === e.id) fx.deadline = p.duration > 0 ? performance.now() + p.duration * 1000 : Infinity;
      });
      r.addEventListener('change', () => { saveParams(e.id); rig.logLine(`FX ${e.name} ${d.label} = ${fmtParam(d, p[d.id])}`); });
      wrap.appendChild(r);
    }
    box.appendChild(wrap);
  }
}

function initFxSettings() {
  for (const e of EFFECTS) $('fxSelect').add(new Option(e.name, e.id));
  $('fxSelect').addEventListener('change', () => selectEffect($('fxSelect').value));
  $('fxReset').addEventListener('click', () => {
    // Mutate in place so a running effect sees the reset values.
    Object.assign(fx.params[fx.selected], defaults(EFFECTS.find((x) => x.id === fx.selected)));
    saveParams(fx.selected);
    renderFxParams();
  });
  selectEffect(fx.selected);
}

function renderPresets() {
  const looks = $('looks'), effects = $('effects');
  looks.innerHTML = '';
  show.looks.slice(0, LOOK_KEYS.length).forEach((l, i) => looks.appendChild(tile(l, LOOK_KEYS[i], 'look')));
  if (!effects.children.length) EFFECTS.forEach((e, i) => effects.appendChild(tile(e, EFFECT_KEYS[i], 'effect')));
  for (const b of looks.children) b.classList.toggle('active', b.dataset.id === fx.look);
  for (const b of effects.children) {
    const running = b.dataset.id === fx.id;
    b.classList.toggle('running', running);
    const nm = b.querySelector('.nm');
    const item = EFFECTS.find((x) => x.id === b.dataset.id);
    nm.innerHTML = '';
    nm.append(item.name);
    if (running) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = 'running · tap to stop'; nm.append(s); }
  }
  const on = rig.anyConnected;
  for (const b of document.querySelectorAll('#tab-show .tile')) b.disabled = !on;
  $('saveLookBtn').disabled = !on;
  if ($('fxSelect').options.length) $('fxRunning').textContent = fx.id && fx.id === fx.selected ? '● running' : '';
}

// ---------- cues ----------

const cue = { index: -1, token: 0, followTimer: null, followAt: 0, followTotal: 0, selected: null };

/**
 * Every connected light's current look, for recording a cue. Lights running an effect are recorded
 * with the look they had before the effect, so the cue's base look isn't a random mid-effect frame.
 */
function snapshotRig() {
  const lights = {};
  for (const l of rig.connected) {
    const base = fx.id && fx.snapshot?.has(l.id) ? { ...fx.snapshot.get(l.id), power: true } : { ...stateOf(l), power: l.conn.light.power !== false };
    lights[l.id] = normState(base);
  }
  return lights;
}

function clearFollow() {
  if (cue.followTimer) { clearTimeout(cue.followTimer); cue.followTimer = null; rig.logLine('auto-GO cancelled'); }
  renderCueBar();
}

function scheduleFollow(i, seconds) {
  cue.followTotal = seconds * 1000;
  cue.followAt = performance.now() + cue.followTotal;
  cue.followTimer = setTimeout(() => {
    cue.followTimer = null;
    if (cue.index === i && i + 1 < show.cues.length) goCue(i + 1);
    else renderCueBar();
  }, cue.followTotal);
}

/**
 * Runs cue i: lights that should be on but are dark are powered on at 0 and faded in; every light
 * in the cue crossfades to its recorded look; lights recorded as off fade out and power off.
 * Then the cue's effect (if any) starts, and auto-follow schedules the next cue.
 */
async function goCue(i, { fade } = {}) {
  const c = show.cues[i];
  if (!c || !rig.anyConnected) return;
  if (cue.followTimer) { clearTimeout(cue.followTimer); cue.followTimer = null; }
  stopEffect(false);
  cancelFade();
  const token = ++cue.token;
  cue.index = i;
  cue.selected = c.id;
  fx.look = null;
  renderPresets();
  rig.logLine(`GO cue ${i + 1}${c.name ? ` · ${c.name}` : ''}`);
  if (c.follow != null && c.follow !== '') scheduleFollow(i, +c.follow);
  renderCueBar();
  renderCueList();

  const fadeMs = Math.max(0, (fade ?? c.fade ?? 0) * 1000);
  const entries = Object.entries(c.lights).map(([id, st]) => [rig.get(id), st]).filter(([l]) => l?.conn.connected);
  const missing = Object.keys(c.lights).filter((id) => !rig.get(id)?.conn.connected);
  if (missing.length) rig.logLine(`cue ${i + 1}: ${missing.length} light(s) not connected, skipped`);

  await each(entries.filter(([l, st]) => st.power !== false && isDarkLight(l)), async ([l]) => {
    l.blackoutPre = null;
    if (fadeMs > 0) await l.conn.sendFrames(P.brightness(0), 'cue prep', { quiet: true });
    await l.conn.sendFrames(P.power(true), `cue ${i + 1} power on`);
    if (fadeMs > 0) l.conn.light.brightness = 0;
  });
  const jobs = entries.filter(([l, st]) => !(st.power === false && isDarkLight(l)))
    .map(([l, st]) => ({ light: l, to: st.power === false ? { bri: 0 } : st }));
  const ok = await crossfade(jobs, fadeMs, { label: `CUE ${i + 1}` });
  if (!ok || token !== cue.token) return;
  await each(entries.filter(([l, st]) => st.power === false && !isDarkLight(l)), ([l, st]) => {
    l.blackoutPre = st.bri || null;
    return l.conn.sendFrames(P.power(false), `cue ${i + 1} power off`);
  });
  if (c.effect?.id) {
    const e = EFFECTS.find((x) => x.id === c.effect.id);
    const ls = (c.effect.lightIds?.length ? c.effect.lightIds : Object.keys(c.lights)).map((id) => rig.get(id)).filter((l) => l?.conn.connected);
    if (e && ls.length && token === cue.token) toggleEffect(e, { params: { ...defaults(e), ...c.effect.params }, lights: ls, fromCue: true });
  }
}

function goNext() {
  const i = cue.index + 1;
  if (i < show.cues.length) goCue(i);
}
function goBack() { if (cue.index > 0) goCue(cue.index - 1); }

const cueTitle = (i) => (i >= 0 && show.cues[i] ? `${i + 1}${show.cues[i].name ? ` · ${show.cues[i].name}` : ''}` : '—');

function renderCueBar() {
  const n = show.cues.length;
  const atEnd = cue.index >= n - 1;
  $('cueNow').textContent = n ? (cue.index >= 0 ? cueTitle(cue.index) : 'Ready — press GO for cue 1') : 'No cues yet';
  $('cueNext').textContent = n ? (cue.index + 1 < n ? cueTitle(cue.index + 1) : 'End of list') : 'Record cues on the Cues tab';
  $('cueGo').disabled = !n || !rig.anyConnected || (atEnd && cue.index >= 0);
  $('cueBack').disabled = cue.index <= 0 || !rig.anyConnected;
  updateCueProgress();
}

function updateCueProgress() {
  let pct = 0, text = '';
  if (cue.followTimer) {
    const left = Math.max(0, cue.followAt - performance.now());
    pct = 100 * (1 - left / cue.followTotal);
    text = `auto-GO in ${(left / 1000).toFixed(1)} s`;
  } else if (ui.fading) {
    pct = ui.fadeT * 100;
    text = `fading ${Math.round(pct)}%`;
  } else if (fx.id && fx.deadline !== Infinity) {
    text = `${EFFECTS.find((e) => e.id === fx.id)?.name}: ${Math.max(0, (fx.deadline - performance.now()) / 1000).toFixed(0)} s left`;
  }
  $('cueProg').style.width = `${pct}%`;
  $('cueState').textContent = text;
}
setInterval(updateCueProgress, 100);

// ----- Cues tab: cue list editor -----

function lightsSummary(lightsMap) {
  const wrap = document.createElement('span');
  wrap.className = 'cue-lights';
  for (const [id, st] of Object.entries(lightsMap)) {
    const sw = document.createElement('span');
    sw.className = 'lsw';
    sw.style.background = stateColor(st);
    sw.title = `${rig.get(id)?.label ?? 'unknown light'}: ${describeState(st)}`;
    wrap.appendChild(sw);
  }
  return wrap;
}

function numInput(value, { min = 0, max = 600, step = 0.1, placeholder = '' }, onChange) {
  const i = document.createElement('input');
  i.type = 'number';
  Object.assign(i, { min, max, step, placeholder });
  i.value = value ?? '';
  i.addEventListener('change', () => onChange(i.value === '' ? null : clamp(+i.value, min, max)));
  return i;
}

function renderCueList() {
  const list = $('cueList');
  list.innerHTML = '';
  if (!show.cues.length) {
    const p = document.createElement('p');
    p.className = 'hint empty';
    p.textContent = rig.anyConnected
      ? 'No cues yet. Set the lights how you want them, then press “Record new cue”.'
      : 'No cues yet. Connect your light(s), set a look, then press “Record new cue”.';
    list.appendChild(p);
  }
  show.cues.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cue-row' + (c.id === cue.selected ? ' sel' : '') + (i === cue.index ? ' live' : '');
    row.dataset.id = c.id;
    row.addEventListener('click', (e) => { if (e.target === row || e.target.classList.contains('cue-num')) { cue.selected = c.id; renderCueList(); } });

    const num = document.createElement('span'); num.className = 'cue-num'; num.textContent = i + 1;
    const name = document.createElement('input');
    name.type = 'text'; name.value = c.name; name.placeholder = `Cue ${i + 1}`; name.className = 'cue-name';
    name.addEventListener('focus', () => { if (cue.selected !== c.id) { cue.selected = c.id; markSelected(); } });
    name.addEventListener('change', () => { show.updateCue(c.id, { name: name.value.trim() }); renderCueBar(); });
    const fade = numInput(c.fade, { min: 0, max: 60, step: 0.5 }, (v) => show.updateCue(c.id, { fade: v ?? 0 }));
    fade.title = 'Fade time (s)';
    const follow = numInput(c.follow, { min: 0, max: 600, step: 0.5, placeholder: 'manual' }, (v) => show.updateCue(c.id, { follow: v }));
    follow.title = 'Auto-GO the next cue this many seconds after this cue starts (blank = wait for GO)';

    const effSel = document.createElement('select');
    effSel.className = 'cue-fx';
    effSel.add(new Option('No effect', ''));
    for (const e of EFFECTS) effSel.add(new Option(e.name, e.id));
    effSel.value = c.effect?.id ?? '';
    const dur = numInput(c.effect?.params?.duration ?? 0, { min: 0, max: 600, step: 1, placeholder: '∞' }, (v) => {
      if (!c.effect) return;
      show.updateCue(c.id, { effect: { ...c.effect, params: { ...c.effect.params, duration: v ?? 0 } } });
    });
    dur.title = 'Effect run time in seconds (0 = until the next cue)';
    dur.disabled = !c.effect;
    effSel.addEventListener('change', () => {
      const id = effSel.value;
      show.updateCue(c.id, { effect: id ? { id, params: { ...fx.params[id] }, lightIds: Object.keys(c.lights) } : null });
      renderCueList();
    });

    const go = document.createElement('button');
    go.className = 'btn sm'; go.textContent = 'GO'; go.title = 'Run this cue now';
    go.disabled = !rig.anyConnected;
    go.addEventListener('click', () => goCue(i));

    const cell = (label, el) => { const w = document.createElement('label'); w.className = 'cue-cell'; const s = document.createElement('span'); s.textContent = label; w.append(s, el); return w; };
    row.append(num, name, cell('Fade s', fade), cell('Auto-GO s', follow), cell('Effect', effSel), cell('Run s', dur), lightsSummary(c.lights), go);
    list.appendChild(row);
  });
  const sel = show.cues.find((c) => c.id === cue.selected);
  for (const id of ['cueUpdate', 'cueDelete', 'cueUp', 'cueDown']) $(id).disabled = !sel;
  $('cueRecord').disabled = !rig.anyConnected;
  $('cueUpdate').disabled = !sel || !rig.anyConnected;
}

function markSelected() {
  for (const r of $('cueList').children) r.classList?.toggle('sel', r.dataset.id === cue.selected);
  const sel = !!show.cues.find((c) => c.id === cue.selected);
  for (const id of ['cueDelete', 'cueUp', 'cueDown']) $(id).disabled = !sel;
  $('cueUpdate').disabled = !sel || !rig.anyConnected;
}

function runningEffectForCue() {
  if (!fx.id) return null;
  return { id: fx.id, params: { ...fx.params[fx.id] }, lightIds: fx.lights.map((l) => l.id) };
}

function initCues() {
  $('cueGo').addEventListener('click', goNext);
  $('cueBack').addEventListener('click', goBack);
  $('cueRecord').addEventListener('click', () => {
    if (!rig.anyConnected) return;
    const after = cue.selected ? show.cueIndex(cue.selected) : null;
    const c = show.addCue({ lights: snapshotRig(), effect: runningEffectForCue(), fade: 2 }, after);
    cue.selected = c.id;
    rig.logLine(`RECORD cue ${show.cueIndex(c.id) + 1}`);
    toast({ level: 'ok', title: `Recorded cue ${show.cueIndex(c.id) + 1}`, body: `${Object.keys(c.lights).length} light(s)${c.effect ? ` + ${EFFECTS.find((e) => e.id === c.effect.id).name}` : ''}` });
  });
  $('cueUpdate').addEventListener('click', () => {
    const c = show.cues.find((x) => x.id === cue.selected);
    if (!c || !rig.anyConnected) return;
    show.updateCue(c.id, { lights: { ...c.lights, ...snapshotRig() } });
    toast({ level: 'ok', title: `Updated cue ${show.cueIndex(c.id) + 1}`, body: 'Saved the current look of the connected lights.' });
  });
  confirmButton($('cueDelete'), 'Click again to delete', () => {
    const i = show.cueIndex(cue.selected);
    if (i < 0) return;
    show.removeCue(cue.selected);
    if (cue.index >= i) cue.index = Math.max(-1, cue.index - 1);
    cue.selected = show.cues[Math.min(i, show.cues.length - 1)]?.id ?? null;
  });
  $('cueUp').addEventListener('click', () => { if (cue.selected) show.moveCue(cue.selected, -1); });
  $('cueDown').addEventListener('click', () => { if (cue.selected) show.moveCue(cue.selected, 1); });
  $('cueReset').addEventListener('click', () => { clearFollow(); cue.index = -1; renderCueBar(); renderCueList(); });
  show.addEventListener('change', (e) => {
    if (e.detail.what === 'cues') { renderCueList(); renderCueBar(); }
    else { renderPresets(); renderLookList(); }
  });
  renderCueList();
  renderCueBar();
}

// ----- Cues tab: looks library -----

function renderLookList() {
  const list = $('lookList');
  list.innerHTML = '';
  show.looks.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'look-row';
    const sw = document.createElement('span'); sw.className = 'lsw big'; sw.style.background = stateColor(l.state, { full: true });
    const key = document.createElement('span'); key.className = 'look-key'; key.textContent = LOOK_KEYS[i] ?? '';
    const name = document.createElement('input');
    name.type = 'text'; name.value = l.name; name.className = 'cue-name';
    name.addEventListener('change', () => show.updateLook(l.id, { name: name.value }));
    const desc = document.createElement('span'); desc.className = 'hint look-desc'; desc.textContent = describeState(l.state);
    const mk = (txt, title, fn, dis = false) => { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = txt; b.title = title; b.disabled = dis; b.addEventListener('click', fn); return b; };
    const btns = document.createElement('span'); btns.className = 'row look-btns';
    btns.append(
      mk('Apply', 'Send to the selected light(s)', () => applyLook(l), !rig.anyConnected),
      mk('Update', 'Replace with the selected light’s current look', () => { const p = primary(); if (p?.conn.connected) { show.updateLook(l.id, { state: stateOf(p) }); toast({ level: 'ok', title: `Updated “${l.name}”` }); } }, !rig.anyConnected),
      mk('↑', 'Move up', () => show.moveLook(l.id, -1), i === 0),
      mk('↓', 'Move down', () => show.moveLook(l.id, 1), i === show.looks.length - 1),
    );
    const del = mk('Delete', 'Delete this look', () => {});
    del.classList.add('danger');
    confirmButton(del, 'Sure?', () => show.removeLook(l.id));
    btns.append(del);
    row.append(sw, key, name, desc, btns);
    list.appendChild(row);
  });
  $('lookSave').disabled = !rig.anyConnected;
}

function initLookLibrary() {
  $('lookSave').addEventListener('click', saveCurrentLook);
  $('saveLookBtn').addEventListener('click', saveCurrentLook);
  confirmButton($('lookReset'), 'Click again to restore defaults', () => { show.resetLooks(); toast({ level: 'ok', title: 'Default looks restored' }); });
  renderLookList();
}

// ---------- lock, keyboard, wake lock ----------

function setLocked(on) {
  ui.locked = on;
  document.body.classList.toggle('locked', on);
  $('lockBtn').classList.toggle('on', on);
  $('lockBtn').textContent = on ? 'Locked' : 'Lock';
}

let nudgeTimer = null;
function nudgeBrightness(delta) {
  const el = $('bri');
  if (el.disabled) return;
  takeover();
  cancelFade();
  el.value = clamp(+el.value + delta, 0, 100);
  el.dispatchEvent(new Event('input'));
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => el.dispatchEvent(new Event('change')), 350);
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.matches?.('input:not([type=range]):not([type=checkbox]), textarea, select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]') || !$('setup').hidden || !$('blocker').hidden) return;
  if (e.key === '?') { e.preventDefault(); openDialog('helpDlg'); return; }
  if (!$('tab-debug').hidden) return;
  const k = e.key.toLowerCase();
  // Show-running keys work on the Show and Cues tabs, and while locked.
  if (k === ' ' || e.code === 'Space') { e.preventDefault(); if (e.shiftKey) goBack(); else if (!$('cueGo').disabled) goNext(); return; }
  if (k === 'b') { e.preventDefault(); toggleBlackout(); return; }
  if (k === 'escape') { e.preventDefault(); clearFollow(); cancelFade(); stopEffect(true); return; }
  if (k === 'l') { e.preventDefault(); setLocked(!ui.locked); return; }
  if ($('tab-show').hidden || ui.locked) return;
  if (LOOK_KEYS.includes(k)) { const look = show.looks[LOOK_KEYS.indexOf(k)]; if (look) { e.preventDefault(); applyLook(look); } }
  else if (EFFECT_KEYS.includes(k)) { e.preventDefault(); toggleEffect(EFFECTS[EFFECT_KEYS.indexOf(k)]); }
  else if ((k === 'arrowup' || k === 'arrowdown') && !t.matches?.('input[type=range]')) {
    e.preventDefault();
    nudgeBrightness((k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 1 : 5));
  }
});

let wakeLock = null;
async function updateWakeLock() {
  const want = $('wakeChk').checked && rig.anyActive && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', updateWakeLock);

window.addEventListener('beforeunload', (e) => {
  if (rig.anyConnected && prefs.get('confirmClose', true)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- debug tab (acts on the primary light) ----------

function renderWriteTargets() {
  const sel = $('writeTarget');
  const prev = sel.value;
  const conn = primary()?.conn;
  const writable = (conn?.chars ?? []).filter((c) => !c.ota && (c.props.includes('write') || c.props.includes('writeWithoutResponse')));
  sel.innerHTML = '';
  if (!writable.length) sel.add(new Option('— not connected —', ''));
  for (const c of writable) sel.add(new Option(`${rig.lights.length > 1 ? `${primary().label}: ` : ''}${shortUuid(c.uuid)} [${c.props.join(',')}]`, c.id));
  sel.value = writable.some((c) => c.id === prev) ? prev : (conn?.ctrl?.id ?? writable[0]?.id ?? '');
}

function renderGatt() {
  const conn = primary()?.conn;
  if (!conn?.chars.length) { $('gatt').textContent = '(not connected)'; return; }
  const lines = rig.lights.length > 1 ? [`LIGHT ${primary().label}`] : [];
  let last = null;
  for (const c of conn.chars) {
    if (c.svc !== last) { lines.push(`SERVICE ${shortUuid(c.svc)}`); last = c.svc; }
    lines.push(`  CHAR ${shortUuid(c.uuid)} [${c.props.join(', ')}]${c.userDesc ? ` "${c.userDesc}"` : ''}${c.ota ? ' [OTA-like: blocked]' : ''}${c === conn.ctrl ? ' [control]' : ''}`);
    if (c.last) lines.push(`      last=${toHex(c.last)}`);
  }
  $('gatt').textContent = lines.join('\n');
}

function renderLog() {
  const el = $('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent = rig.log.join('\n');
  $('logTitle').textContent = `Log (${rig.log.length})`;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function parseServiceList(text) {
  const out = [];
  for (let tok of text.split(/[\s,]+/)) {
    if (!tok) continue;
    tok = tok.toLowerCase();
    const v = /^(0x)?[0-9a-f]{4}$|^(0x)?[0-9a-f]{8}$/.test(tok) ? parseInt(tok.replace(/^0x/, ''), 16) : tok;
    try { out.push(BluetoothUUID.getService(v)); } catch { rig.logLine(`ignored invalid service "${tok}"`); }
  }
  return out;
}

function copy(text) { navigator.clipboard.writeText(text).catch((e) => rig.logLine(`Copy failed: ${e.message}`)); }

// ---------- toasts ----------

/** {level, title, body, steps[], actions[{label, fn, primary}], timeout} → toast element. Same title replaces. */
function toast({ level = 'info', title, body = '', steps = [], actions = [], timeout }) {
  for (const old of $('toasts').children) if (old.dataset.title === title) old.remove();
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.dataset.title = title;
  el.setAttribute('role', level === 'error' ? 'alert' : 'status');
  const b = document.createElement('b'); b.textContent = title; el.appendChild(b);
  if (body) { const p = document.createElement('p'); p.textContent = body; el.appendChild(p); }
  if (steps.length) {
    const ul = document.createElement('ul');
    for (const s of steps) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); }
    el.appendChild(ul);
  }
  if (actions.length) {
    const row = document.createElement('div'); row.className = 'row';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn sm' + (a.primary ? ' primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', () => { el.remove(); a.fn(); });
      row.appendChild(btn);
    }
    el.appendChild(row);
  }
  const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Dismiss';
  x.addEventListener('click', () => el.remove());
  el.appendChild(x);
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  const ms = timeout ?? (level === 'error' ? 0 : level === 'warn' ? 8000 : 5000);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

function clearToast(title) { for (const t of [...$('toasts').children]) if (t.dataset.title === title) t.remove(); }

// ---------- problems → messages ----------

function initProblems() {
  const was = new Map(), hadLoss = new Set();
  const named = (light, title) => (light && rig.lights.length > 1 ? `${light.label}: ${title}` : title);
  rig.addEventListener('problem', (ev) => {
    const { code, error, light } = ev.detail;
    const m = explainProblem(code, error, env);
    if (!$('setup').hidden) { setupMessage(m); return; }
    if (code === 'lost' && light) hadLoss.add(light.id);
    const actions = [];
    if (code === 'forgotten' || code === 'not-light') actions.push({ label: 'Pair light', primary: true, fn: () => rig.pair() });
    if (code === 'connect' && light) actions.push({ label: 'Try again', primary: true, fn: () => rig.reconnect(light) });
    if (code === 'retrying' && light) actions.push({ label: 'Retry now', primary: true, fn: () => rig.reconnect(light) });
    if (['adapter', 'connect', 'retrying', 'chooser'].includes(code)) actions.push({ label: 'Help', fn: () => openDialog('helpDlg') });
    toast({ ...m, title: named(light, m.title), actions });
  });
  rig.addEventListener('status', (ev) => {
    const l = ev.detail.light;
    const now = l.conn.status === 'connected';
    if (now && !was.get(l.id)) {
      clearToast(named(l, explainProblem('lost', null, env).title));
      clearToast(named(l, explainProblem('retrying', null, env).title));
      toast({ level: 'ok', title: hadLoss.has(l.id) ? named(l, 'Reconnected') : `Connected to ${l.label}` });
      hadLoss.delete(l.id);
    }
    was.set(l.id, now);
  });
}

// ---------- unsupported browser ----------

function showBlocker(r) {
  $('blockTitle').textContent = r.title;
  $('blockBody').textContent = r.body;
  $('blockSteps').innerHTML = '';
  for (const s of r.steps) { const li = document.createElement('li'); li.textContent = s; $('blockSteps').appendChild(li); }
  $('blocker').hidden = false;
  $('connText').textContent = 'Bluetooth unavailable';
  $('connSub').textContent = `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]}`;
  $('connectBtn').hidden = true;
  $('copyLinkBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('copyLinkBtn').textContent = 'Link copied'; }
    catch { $('copyLinkBtn').textContent = location.href; }
  });
  $('blockDismiss').addEventListener('click', () => {
    $('blocker').hidden = true;
    toast({ level: 'warn', title: 'View only', body: 'Controls stay disabled because this browser can’t use Bluetooth.', timeout: 0 });
  });
}

// ---------- first-run setup ----------

function setChk(id, state, content) {
  const li = $(id);
  li.classList.remove('ok', 'bad', 'wait');
  if (state) li.classList.add(state);
  li.querySelector('.mark').textContent = '';
  const body = li.querySelector('.chk-body');
  body.innerHTML = '';
  if (typeof content === 'string') body.textContent = content;
  else {
    const p = document.createElement('p'); p.textContent = content.text; body.appendChild(p);
    if (content.steps) {
      const ul = document.createElement('ul'); ul.className = 'steps';
      for (const s of content.steps) { const li2 = document.createElement('li'); li2.textContent = s; ul.appendChild(li2); }
      body.appendChild(ul);
    }
  }
}

async function checkBluetooth() {
  if (!navigator.bluetooth?.getAvailability) { setChk('chkBt', 'wait', 'Will be checked when you pair.'); return; }
  setChk('chkBt', 'wait', 'Checking…');
  let ok = true;
  try { ok = await navigator.bluetooth.getAvailability(); } catch {}
  if (ok) setChk('chkBt', 'ok', 'Bluetooth is on and available to the browser.');
  else setChk('chkBt', 'bad', { text: 'The browser can’t reach Bluetooth yet:', steps: bluetoothSteps(env) });
}

function setupMessage(m) {
  const el = $('setupMsg');
  el.className = 'setup-msg ' + (m.level === 'ok' ? 'ok' : m.level === 'info' ? '' : 'err');
  el.innerHTML = '';
  const b = document.createElement('b'); b.textContent = m.title; el.appendChild(b);
  if (m.body) { const p = document.createElement('p'); p.textContent = m.body; el.appendChild(p); }
  if (m.steps?.length) {
    const ul = document.createElement('ul'); ul.className = 'steps';
    for (const s of m.steps) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); }
    el.appendChild(ul);
  }
}

function openSetup() {
  setChk('chkBrowser', 'ok', `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]} supports Bluetooth.`);
  const ul = $('chkLight').querySelector('.chk-body');
  ul.innerHTML = '';
  for (const s of LIGHT_STEPS) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); }
  $('chkPair').classList.remove('ok');
  $('chkPair').querySelector('.mark').textContent = '4';
  $('setupMsg').textContent = '';
  $('setupMsg').className = 'setup-msg';
  $('setup').hidden = false;
  checkBluetooth();
}

function closeSetup() {
  $('setup').hidden = true;
  prefs.set('setupDone', true);
}

function initSetup() {
  navigator.bluetooth?.addEventListener?.('availabilitychanged', () => { if (!$('setup').hidden) checkBluetooth(); });
  $('setupPairBtn').addEventListener('click', () => {
    $('setupMsg').className = 'setup-msg';
    $('setupMsg').textContent = 'Waiting for you to choose the light…';
    rig.pair();
  });
  $('setupSkip').addEventListener('click', closeSetup);
  rig.addEventListener('status', (ev) => {
    if ($('setup').hidden) return;
    const l = ev.detail.light;
    if (l.conn.status === 'connecting') setupMessage({ level: 'info', title: 'Connecting…' });
    if (l.conn.status === 'connected') {
      $('chkPair').classList.add('ok');
      $('chkPair').querySelector('.mark').textContent = '';
      setupMessage({ level: 'ok', title: `Connected to ${l.label}. You’re ready.`, body: 'Next time the app connects by itself. Add more lights in Settings.' });
      setTimeout(closeSetup, 1600);
    }
  });
}

// ---------- dialogs: settings & help ----------

function openDialog(id) {
  const d = $(id);
  if (d.open) return;
  if (id === 'settingsDlg') syncSettingsForm();
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}

function closeDialog(d) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }

/** Two-click confirm for destructive buttons. */
function confirmButton(btn, label, fn) {
  let armed = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      const orig = btn.textContent;
      btn.textContent = label;
      btn.classList.add('confirm');
      armed = setTimeout(() => { btn.textContent = orig; btn.classList.remove('confirm'); armed = null; }, 4000);
      btn.dataset.orig = orig;
      return;
    }
    clearTimeout(armed); armed = null;
    btn.textContent = btn.dataset.orig; btn.classList.remove('confirm');
    fn();
  });
}

async function forgetLight(light) {
  if (!light) return;
  await rig.forget(light.id);
  toast({ level: 'info', title: `${light.label} forgotten`, body: rig.lights.length ? '' : 'Press “Pair light” to choose a light again.' });
}

function setDim(on) {
  document.body.classList.toggle('dim', on);
  $('dimBtn').classList.toggle('on', on);
  $('setDim').checked = on;
  prefs.set('dim', on);
}

/** Settings → Lights: one row per light (name, status, reconnect, forget). */
function renderSettingsLights() {
  const box = $('setLights');
  box.innerHTML = '';
  if (!rig.lights.length) {
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No light paired yet.';
    box.appendChild(p);
  }
  for (const l of rig.lights) {
    const row = document.createElement('div');
    row.className = 'light-row';
    row.dataset.id = l.id;
    const dot = document.createElement('span'); dot.className = 'dot ' + l.conn.status;
    const name = document.createElement('input');
    name.type = 'text'; name.maxLength = 24; name.value = l.label; name.placeholder = l.name; name.className = 'light-name';
    name.setAttribute('aria-label', 'Light name');
    name.addEventListener('change', () => { rig.rename(l.id, name.value); renderConn(); });
    const st = document.createElement('span'); st.className = 'hint'; st.textContent = STATUS_TEXT[l.conn.status];
    const rc = document.createElement('button'); rc.className = 'btn sm'; rc.textContent = 'Reconnect';
    rc.disabled = !env.supported || l.conn.connected;
    rc.addEventListener('click', () => rig.reconnect(l));
    const fg = document.createElement('button'); fg.className = 'btn sm danger'; fg.textContent = 'Forget';
    confirmButton(fg, 'Click again', () => forgetLight(l));
    row.append(dot, name, st, rc, fg);
    box.appendChild(row);
  }
  $('setAddLight').textContent = rig.lights.length ? 'Add another light' : 'Pair a light';
  $('setAddLight').disabled = !env.supported;
}

function syncSettingsForm() {
  $('setAuto').checked = prefs.get('autoConnect', true);
  $('wakeChk').checked = prefs.get('wake', true);
  $('setConfirm').checked = prefs.get('confirmClose', true);
  $('setDim').checked = document.body.classList.contains('dim');
  $('setDebug').checked = prefs.get('showDebug', false);
  renderSettingsLights();
}

function initSettings() {
  $('appVersion').textContent = APP_VERSION;
  $('envInfo').textContent = `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]}${env.supported ? '' : ' (no Web Bluetooth)'}`;
  $('settingsBtn').addEventListener('click', () => openDialog('settingsDlg'));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeDialog(b.closest('dialog')));

  $('setAddLight').addEventListener('click', () => rig.pair());
  $('setAuto').addEventListener('change', () => prefs.set('autoConnect', $('setAuto').checked));
  $('wakeChk').checked = prefs.get('wake', true);
  $('wakeChk').addEventListener('change', () => { prefs.set('wake', $('wakeChk').checked); updateWakeLock(); });
  $('setConfirm').addEventListener('change', () => prefs.set('confirmClose', $('setConfirm').checked));
  $('setDim').addEventListener('change', () => setDim($('setDim').checked));
  $('setDebug').addEventListener('change', () => {
    prefs.set('showDebug', $('setDebug').checked);
    $('debugTabBtn').hidden = !$('setDebug').checked;
    if (!$('setDebug').checked) showTab('show');
  });
  $('debugTabBtn').hidden = !prefs.get('showDebug', false);
  confirmButton($('setResetFx'), 'Click again to reset effects', () => {
    for (const e of EFFECTS) { Object.assign(fx.params[e.id], defaults(e)); saveParams(e.id); }
    renderFxParams();
    toast({ level: 'ok', title: 'Effect settings reset' });
  });
  confirmButton($('setResetAll'), 'Click again to reset everything', () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('gvm.ui.')) localStorage.removeItem(k);
    } catch {}
    prefs.set('setupDone', true);
    location.reload();
  });
  rig.addEventListener('status', () => { if ($('settingsDlg').open) renderSettingsLights(); });
  rig.addEventListener('lights', () => { if ($('settingsDlg').open) renderSettingsLights(); });
  initSetup();
}

function initHelp() {
  $('helpBtn').addEventListener('click', () => openDialog('helpDlg'));
  for (const [id, steps] of [['helpLight', LIGHT_STEPS], ['helpBt', bluetoothSteps(env)]]) {
    for (const s of steps) { const li = document.createElement('li'); li.textContent = s; $(id).appendChild(li); }
  }
  $('helpSetupBtn').addEventListener('click', () => { closeDialog($('helpDlg')); openSetup(); });
}

// ---------- wiring ----------

function showTab(name) {
  if (name === 'debug' && !prefs.get('showDebug', false)) name = 'show';
  if (!['show', 'cues', 'debug'].includes(name)) name = 'show';
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('tab-show').hidden = name !== 'show';
  $('tab-cues').hidden = name !== 'cues';
  $('tab-debug').hidden = name !== 'debug';
  prefs.set('tab', name);
  if (name === 'debug') { renderLog(); renderGatt(); renderWriteTargets(); }
  if (name === 'cues') { renderCueList(); renderLookList(); }
}

function init() {
  for (const sel of ['#powerBtn', '#fadeCtl', '#bri', '#modeSeg', '#cctPanel', '#hsiPanel']) {
    document.querySelector(sel).classList.add('lockable');
  }

  rig.addEventListener('status', renderConn);
  rig.addEventListener('lights', () => { renderConn(); syncFromLight(); renderFxParams(); renderCueList(); });
  rig.addEventListener('light', syncFromLight);
  rig.addEventListener('gatt', () => { renderGatt(); renderWriteTargets(); });
  rig.addEventListener('log', () => { if (!$('tab-debug').hidden) renderLog(); });
  rig.addEventListener('status', () => {
    if (!rig.anyConnected && fx.id) { fx.token++; fx.id = null; renderPresets(); }
    renderPresets();
    if (!$('tab-cues').hidden) { renderCueList(); renderLookList(); }
  });

  $('connectBtn').addEventListener('click', onConnectClick);
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  $('lockBtn').addEventListener('click', () => setLocked(!ui.locked));
  $('dimBtn').addEventListener('click', () => setDim(!document.body.classList.contains('dim')));

  $('powerBtn').addEventListener('click', () => {
    takeover();
    cancelFade();
    const turnOn = isDark();
    each(targets(), (l) => { l.blackoutPre = null; return l.conn.sendFrames(P.power(turnOn), turnOn ? 'power on' : 'power off'); });
  });
  $('blackoutBtn').addEventListener('click', toggleBlackout);

  const setFade = (ms, { fromSlider = false } = {}) => {
    ui.fadeMs = ms;
    prefs.set('fadeMs', ms);
    if (!fromSlider) $('fadeSlider').value = fadeMsToPos(ms);
    const [v, unit] = fadeLabel(ms);
    $('fadeVal').textContent = v;
    $('fadeUnit').textContent = unit;
    for (const c of document.querySelectorAll('#fadeCtl .chip')) c.classList.toggle('active', +c.dataset.ms === ms);
  };
  $('fadeSlider').addEventListener('input', () => setFade(fadePosToMs(+$('fadeSlider').value), { fromSlider: true }));
  for (const c of document.querySelectorAll('#fadeCtl .chip')) c.addEventListener('click', () => setFade(+c.dataset.ms));
  setFade(prefs.get('fadeMs', 0));

  for (const b of $('modeSeg').children) {
    b.addEventListener('click', async () => {
      takeover();
      setMode(b.dataset.mode);
      await each(targets(), (l) => ensureModeOn(l, b.dataset.mode, false));
    });
  }

  for (const id of ['bri', 'cct', 'hue', 'sat']) bindLiveSlider(id);

  for (const c of document.querySelectorAll('#cctPanel .chip')) {
    c.addEventListener('click', () => { takeover(); $('cct').value = c.dataset.k; renderValues(); sendValue('cct', +c.dataset.k, { quiet: false }); });
  }
  for (const s of document.querySelectorAll('.swatches button')) {
    s.addEventListener('click', () => { takeover(); $('hue').value = s.dataset.h; renderValues(); sendValue('hue', +s.dataset.h, { quiet: false }); });
  }

  // debug (primary light)
  const sendHex = () => {
    const bytes = parseHex($('hexInput').value);
    if (!bytes) { rig.logLine(`Invalid hex input: "${$('hexInput').value}"`); return; }
    const conn = primary()?.conn;
    conn?.write(conn.chars.find((c) => c.id === $('writeTarget').value), bytes, 'raw');
  };
  $('sendHexBtn').addEventListener('click', sendHex);
  $('hexInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendHex(); });
  $('handshakeBtn').addEventListener('click', () => primary()?.conn.sendFrames(P.handshake(), 'handshake'));
  $('echoChk').addEventListener('change', () => { for (const l of rig.lights) l.conn.echoStatus = $('echoChk').checked; });
  $('quietChk').addEventListener('change', () => { for (const l of rig.lights) l.conn.quietStatus = $('quietChk').checked; });
  $('pairAnyBtn').addEventListener('click', () => rig.pair({ anyDevice: true, extraServices: parseServiceList($('extraServices').value) }));
  $('disconnectBtn').addEventListener('click', () => rig.disconnectAll());
  $('forgetBtn').addEventListener('click', () => forgetLight(primary()));
  $('copyGattBtn').addEventListener('click', () => copy($('gatt').textContent));
  $('copyLogBtn').addEventListener('click', () => copy(rig.log.join('\n')));
  $('clearLogBtn').addEventListener('click', () => { rig.clearLog(); });
  $('downloadLogBtn').addEventListener('click', () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.download = `gvm-session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`;
    a.href = URL.createObjectURL(new Blob([rig.full.join('\n') + '\n'], { type: 'text/plain' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  initFxSettings();
  renderPresets();
  initCues();
  initLookLibrary();
  initSettings();
  initHelp();
  initProblems();
  setDim(prefs.get('dim', false));
  showTab(prefs.get('tab', 'show'));
  setMode('cct');
  renderValues();
  renderConn();
  renderWriteTargets();

  rig.logLine(`GVM Show Control ${APP_VERSION} · ${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]} · ${rig.lights.length} light(s) remembered`);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => rig.logLine(`Service worker: ${e.message}`));
  }

  const block = blockReason(env);
  if (block) { showBlocker(block); return; }
  if (!rig.lights.length && !prefs.get('setupDone', false)) openSetup();
  else if (rig.lights.length && prefs.get('autoConnect', true)) rig.restoreAll();
}

init();
