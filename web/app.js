import { GVMProtocol as P } from './gvm-protocol.js';
import { LightConnection, parseHex, toHex, shortUuid, sleep } from './ble.js';
import { LOOKS, EFFECTS, defaults } from './effects.js';
import { APP_VERSION, detectEnv, blockReason, bluetoothSteps, explainProblem, LIGHT_STEPS, OS_NAME, BROWSER_NAME } from './setup.js';

const env = detectEnv();

const conn = new LightConnection();
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
  busy: false,         // blackout/restore in progress
  staged: null,        // while blacked out: {mode, cct, hue, sat, bri} revealed by Restore
  restoring: false,
};

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('gvm.ui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gvm.ui.' + k, JSON.stringify(v)); } catch {} },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
const isDark = () => conn.light.power === false;

function renderPreview() {
  const b = +$('bri').value / 100;
  if (ui.staged) {
    const st0 = ui.staged;
    $('readout').textContent = `DARK · next: ${st0.bri}% · ${st0.mode === 'hsi' ? `hue ${st0.hue}° sat ${st0.sat}%` : `${st0.cct}K`}`;
    const st = ui.staged;
    const rgb = st.mode === 'hsi' ? hsvToRgb(st.hue ?? 0, (st.sat ?? 100) / 100, (st.bri ?? 0) / 100)
                                  : kelvinToRgb(st.cct ?? 5600).map((x) => (x * (st.bri ?? 0)) / 100);
    $('preview').style.background = `rgb(${rgb.map(Math.round).join(',')})`;
    document.documentElement.style.setProperty('--sat-color', `hsl(${$('hue').value} 100% 50%)`);
    return;
  }
  const rgb = ui.mode === 'cct' ? kelvinToRgb(+$('cct').value).map((x) => x * b)
                                : hsvToRgb(+$('hue').value, +$('sat').value / 100, b);
  const on = conn.light.power !== false;
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

// ---------- connection status ----------

function renderConn() {
  const s = conn.status;
  $('connDot').className = 'dot ' + s;
  $('connText').textContent = {
    unsupported: 'Web Bluetooth unavailable',
    idle: conn.rememberedId ? 'Not connected' : 'No light paired',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  }[s];
  $('connSub').textContent = [lightName(), conn.statusDetail].filter(Boolean).join(' · ');
  const btn = $('connectBtn');
  btn.hidden = s === 'connected' || s === 'connecting' || s === 'unsupported';
  btn.textContent = s === 'reconnecting' ? 'Retry now' : conn.rememberedId ? 'Connect' : 'Pair light';
  const on = conn.connected;
  for (const el of document.querySelectorAll('#tab-show button, #tab-show input[type=range]')) {
    if (!el.closest('.fx-settings')) el.disabled = !on;   // effect settings stay editable offline
  }
  updateWakeLock();
  renderLight();
}

const lightName = () => prefs.get('lightName', '') || conn.deviceName;

async function onConnectClick() {
  if (conn.status === 'reconnecting' && conn.device) { conn.connect(conn.device); return; }
  if (conn.rememberedId && (await conn.restore())) return;
  conn.pair();
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
  const L = conn.light;
  const known = L.power != null;
  $('powerBtn').classList.toggle('on', L.power === true);
  $('powerState').textContent = !known ? '—' : L.power ? 'ON' : 'OFF';
  const dark = L.power === false;
  $('blackoutBtn').classList.toggle('restore', dark);
  $('blackoutLabel').textContent = dark ? 'RESTORE' : 'BLACKOUT';
  $('blackoutSub').textContent = dark && ui.staged ? 'reveals the look you set' : '';
  if (!known) { $('readout').textContent = '—'; return; }
  if (ui.staged) {
    const st = ui.staged;
    const c = st.mode === 'hsi' ? `hue ${st.hue}° sat ${st.sat}%` : `${st.cct}K`;
    $('readout').textContent = `DARK · next: ${st.bri}% · ${c}`;
  } else {
    const color = L.mode === 'hsi' ? `hue ${L.hue}° sat ${L.saturation}%` : `${L.cct}K`;
    $('readout').textContent = `${L.power ? 'ON' : 'OFF'} · ${L.brightness}% · ${color} · ${L.mode === 'hsi' ? 'COLOR' : 'WHITE'}`;
  }
  renderPreview();
}

function enterStaging() {
  const L = conn.light;
  ui.staged = { mode: L.mode ?? ui.mode, cct: L.cct ?? +$('cct').value, hue: L.hue ?? +$('hue').value,
                sat: L.saturation ?? +$('sat').value, bri: L.brightness ?? +$('bri').value };
  conn.logLine('STAGING on: changes are held until Restore');
  renderStaging();
}

function renderStaging() {
  const on = !!ui.staged;
  $('readoutLabel').textContent = on ? 'On Restore' : 'Light reports';
  document.body.classList.toggle('staging', on);
  $('stagingPill').hidden = !on;
  if (!on) return;
  const st = ui.staged;
  $('bri').value = st.bri; $('cct').value = st.cct; $('hue').value = st.hue; $('sat').value = st.sat;
  setMode(st.mode);
  renderValues();
}

function syncFromLight() {
  const L = conn.light;
  if (isDark() && !ui.staged && !ui.restoring) enterStaging();
  if (!isDark() && ui.staged && !ui.restoring) { ui.staged = null; renderStaging(); }
  if (ui.staged) { renderLight(); renderPreview(); return; }
  if (L.brightness != null && !ui.fading && ui.dragging !== 'bri') $('bri').value = L.brightness;
  if (L.cct != null && ui.dragging !== 'cct') $('cct').value = L.cct;
  if (L.hue != null && ui.dragging !== 'hue') $('hue').value = L.hue;
  if (L.saturation != null && ui.dragging !== 'sat') $('sat').value = L.saturation;
  if (L.mode && !ui.dragging) setMode(L.mode);
  renderValues();
  renderLight();
}

setInterval(() => {
  if (!conn.connected) { $('readoutAge').textContent = ''; return; }
  if (!conn.lastStatusAt) { $('readoutAge').textContent = 'waiting for first status…'; return; }
  const s = Math.round((Date.now() - conn.lastStatusAt) / 1000);
  $('readoutAge').textContent = s > 12 ? `no status for ${s}s` : `status ${s}s ago`;
}, 1000);

// ---------- sending ----------

async function ensureMode(m) {
  if (ui.staged) { ui.staged.mode = m; setMode(m); return; }
  if (conn.light.mode === m && ui.mode === m) return;
  setMode(m);
  conn.light.mode = m;
  await conn.sendFrames(P.mode(m), `mode ${m}`, { quiet: true });
}

const encoders = {
  bri: (v) => ({ frames: P.brightness(v), label: `brightness ${v}%` }),
  cct: (v) => ({ frames: P.cct(v), label: `cct ${v}K`, mode: 'cct' }),
  hue: (v) => ({ frames: P.hue(v), label: `hue ${v}°`, mode: 'hsi' }),
  sat: (v) => ({ frames: P.saturation(v), label: `saturation ${v}%`, mode: 'hsi' }),
};

const STAGE_KEY = { bri: 'bri', cct: 'cct', hue: 'hue', sat: 'sat' };

async function sendValue(id, v, { quiet = true } = {}) {
  const e = encoders[id](v);
  if (ui.staged) {
    if (e.mode) ui.staged.mode = e.mode;
    ui.staged[STAGE_KEY[id]] = v;
    setMode(ui.staged.mode);
    renderPreview();
    if (!quiet) conn.logLine(`STAGED ${e.label}`);
    return;
  }
  if (e.mode) await ensureMode(e.mode);
  await conn.sendFrames(e.frames, e.label, { quiet });
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
    conn.logLine(`${ui.staged ? 'STAGED' : 'SET'} ${encoders[id](+el.value).label}`);
    setTimeout(() => { if (ui.dragging === id) ui.dragging = null; }, 400);
  });
}

// ---------- fades, blackout ----------

function cancelFade() { ui.fadeToken++; ui.fading = false; $('fadeStatus').textContent = ''; }

/** Linear brightness fade. Returns false if cancelled. */
async function fadeBrightness(from, to, ms) {
  const token = ++ui.fadeToken;
  ui.fading = true;
  // Shorter fades use finer steps (writes are spaced ≥ 60 ms by the connection queue).
  const stepMs = ms <= 1500 ? 70 : 150;
  const steps = Math.max(1, Math.round(ms / stepMs));
  const start = performance.now();
  let lastV = from;
  conn.logLine(`FADE brightness ${from}% → ${to}% over ${ms / 1000}s`);
  for (let i = 1; i <= steps; i++) {
    if (token !== ui.fadeToken) { conn.logLine('FADE cancelled'); return false; }
    const v = Math.round(from + ((to - from) * i) / steps);
    if (v !== lastV) {
      $('bri').value = v;
      renderValues();
      await conn.sendFrames(P.brightness(v), 'fade', { quiet: true });
      lastV = v;
    }
    $('fadeStatus').textContent = `fading… ${Math.round((i / steps) * 100)}%`;
    const wait = start + (ms * i) / steps - performance.now();
    if (wait > 0) await sleep(wait);
  }
  ui.fading = false;
  $('fadeStatus').textContent = '';
  return true;
}

function setBusy(b) {
  ui.busy = b;
  $('blackoutBtn').classList.toggle('busy', b);
}

async function blackout() {
  const pre = conn.light.brightness ?? +$('bri').value;
  setBusy(true);
  try {
    if (ui.fadeMs > 0 && pre > 0 && !(await fadeBrightness(pre, 0, ui.fadeMs))) return;
    await conn.sendFrames(P.power(false), 'BLACKOUT');
    conn.light.power = false;
    enterStaging();
    ui.staged.bri = pre;           // Restore returns to the pre-blackout level unless changed
    renderStaging();
    renderLight();
  } finally { setBusy(false); }
}

/**
 * Frames that move the light from its last known state to `st` (mode first, brightness last).
 * Only differing params are included, so an unchanged look adds no delay.
 */
function diffFrames(st) {
  const L = conn.light, f = [];
  if (st.mode !== L.mode) f.push(...P.mode(st.mode));
  if (st.mode === 'hsi') {
    if (st.hue !== L.hue) f.push(...P.hue(st.hue));
    if (st.sat !== L.saturation) f.push(...P.saturation(st.sat));
  } else if (st.cct !== L.cct) f.push(...P.cct(st.cct));
  if (st.bri != null && st.bri !== L.brightness) f.push(...P.brightness(st.bri));
  return f;
}

/**
 * Reveals the staged look. The look is sent while still dark, then again right after power-on
 * (in case the light ignores changes while off), then brightness snaps or fades to the staged level.
 */
async function restore({ snap = false } = {}) {
  const st = ui.staged ?? { mode: ui.mode, cct: +$('cct').value, hue: +$('hue').value, sat: +$('sat').value, bri: conn.light.brightness ?? +$('bri').value };
  const target = st.bri;
  const fade = !snap && ui.fadeMs > 0 && target > 0;
  setBusy(true);
  ui.restoring = true;
  conn.logLine(`RESTORE → ${st.mode === 'hsi' ? `hue ${st.hue}° sat ${st.sat}%` : `${st.cct}K`} · ${target}%${fade ? ` (fade ${ui.fadeMs / 1000}s)` : ''}`);
  try {
    const pre = { ...st, bri: fade ? 0 : target };
    const frames = diffFrames(pre);
    if (frames.length) await conn.sendFrames(frames, 'restore: preload', { quiet: true });
    await conn.sendFrames(P.power(true), 'RESTORE');
    // Resend what changed, in case the light ignored changes while it was off.
    if (frames.length) await conn.sendFrames(frames, 'restore: confirm', { quiet: true });
    Object.assign(conn.light, { power: true, mode: pre.mode, cct: pre.cct, hue: pre.hue, saturation: pre.sat, brightness: pre.bri });
    ui.staged = null;
    renderStaging();
    syncFromLight();
    if (fade) await fadeBrightness(0, target, ui.fadeMs);
  } finally {
    ui.restoring = false;
    setBusy(false);
    syncFromLight();
  }
}

function toggleBlackout() {
  if (!conn.connected || ui.busy) return;
  stopEffect(false);
  if (conn.light.power === false) restore(); else blackout();
}

// ---------- looks & effects ----------

const LOOK_KEYS = ['1', '2', '3', '4', '5', '6'];
const EFFECT_KEYS = ['q', 'w', 'e', 'r', 't', 'y'];
const fx = { id: null, token: 0, snapshot: null, look: null, selected: null, params: {} };

// Live per-effect params (the running generator reads this same object every step).
for (const e of EFFECTS) {
  const saved = prefs.get('fx.' + e.id, {});
  fx.params[e.id] = { ...defaults(e) };
  for (const d of e.params) if (saved[d.id] != null) fx.params[e.id][d.id] = saved[d.id];
}
fx.selected = prefs.get('fx.selected', EFFECTS[0].id);
const FIELD = { bri: 'brightness', cct: 'cct', hue: 'hue', sat: 'saturation' };
const ENC = { cct: P.cct, hue: P.hue, sat: P.saturation, bri: P.brightness };

/** Sends only the params that differ from the light's known state: mode first, brightness last. */
async function applyState(s, { quiet = true, guard = () => true } = {}) {
  const L = conn.light;
  if (s.mode && L.mode !== s.mode) {
    if (!guard()) return;
    await conn.sendFrames(P.mode(s.mode), `mode ${s.mode}`, { quiet });
    L.mode = s.mode;
    setMode(s.mode);
  }
  for (const k of ['cct', 'hue', 'sat', 'bri']) {
    if (s[k] == null) continue;
    const v = k === 'hue' ? Math.round(s[k] / 5) * 5 : k === 'cct' ? Math.round(s[k] / 100) * 100 : Math.round(s[k]);
    if (L[FIELD[k]] === v) continue;
    if (!guard()) return;
    await conn.sendFrames(ENC[k](v), `${FIELD[k]} ${v}`, { quiet });
    L[FIELD[k]] = v;
  }
  syncFromLight();
}

function snapshotLight() {
  const L = conn.light;
  return { mode: L.mode, cct: L.cct, hue: L.hue, sat: L.saturation, bri: L.brightness };
}

async function applyLook(look) {
  if (!conn.connected) return;
  stopEffect(false);
  cancelFade();
  fx.look = look.id;
  renderPresets();
  conn.logLine(`LOOK ${look.name}`);
  if (ui.staged) {
    // Dark: stage the whole look; Restore reveals it.
    Object.assign(ui.staged, look.state);
    renderStaging();
    renderPreview();
  } else {
    await applyState(look.state);
  }
}

async function toggleEffect(e) {
  if (!conn.connected) return;
  if (fx.id === e.id) { stopEffect(true); return; }
  const snapshot = fx.id ? fx.snapshot : snapshotLight();
  stopEffect(false);
  cancelFade();
  const token = ++fx.token;
  fx.id = e.id;
  fx.snapshot = snapshot;
  selectEffect(e.id);
  fx.look = null;
  renderPresets();
  conn.logLine(`EFFECT ${e.name} start`);
  const guard = () => token === fx.token && conn.connected;
  if (isDark()) {
    ui.restoring = true;
    ui.staged = null;
    renderStaging();
    await conn.sendFrames(P.power(true), 'power on (effect)');
    conn.light.power = true;
    ui.restoring = false;
  }
  for (const step of e.steps(fx.params[e.id])) {
    if (!guard()) break;
    const t0 = performance.now();
    await applyState(step.state, { guard });
    const rest = step.wait - (performance.now() - t0);
    if (rest > 0) await sleep(rest);
  }
  if (fx.token === token) { fx.id = null; renderPresets(); }
}

/** Manual control: stop any effect without restoring, clear the active look highlight. */
function takeover() { stopEffect(false); if (fx.look) { fx.look = null; renderPresets(); } }

/** restore=true returns the light to the state captured when the effect started. */
async function stopEffect(restore) {
  if (!fx.id) return;
  const name = EFFECTS.find((x) => x.id === fx.id)?.name;
  const snap = fx.snapshot;
  fx.token++;
  fx.id = null;
  renderPresets();
  conn.logLine(`EFFECT ${name} stop${restore ? ' (restore previous look)' : ''}`);
  if (restore && snap && conn.connected) await applyState(snap, { quiet: false });
}

function tile(item, key, kind) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.dataset.id = item.id;
  b.title = item.desc ?? '';
  b.innerHTML = `<span class="sw"></span><span class="nm"></span><span class="key"></span>`;
  b.querySelector('.sw').style.setProperty('--sw', item.swatch);
  b.querySelector('.nm').textContent = item.name;
  if (kind === 'look') {
    const st = item.state;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = st.mode === 'cct' ? `${st.cct}K · ${st.bri}%` : `${st.hue}° · sat ${st.sat} · ${st.bri}%`;
    b.querySelector('.nm').appendChild(sub);
  }
  b.querySelector('.key').textContent = key.toUpperCase();
  b.addEventListener('click', () => (kind === 'look' ? applyLook(item) : toggleEffect(item)));
  return b;
}

function fmtParam(d, v) {
  if (d.kind === 'choice') return d.options.find((o) => o[0] === v)?.[1] ?? v;
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
      r.addEventListener('input', () => { p[d.id] = +r.value; val.textContent = fmtParam(d, p[d.id]); });
      r.addEventListener('change', () => { saveParams(e.id); conn.logLine(`FX ${e.name} ${d.label} = ${fmtParam(d, p[d.id])}`); });
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
  if (!looks.children.length) {
    LOOKS.forEach((l, i) => looks.appendChild(tile(l, LOOK_KEYS[i], 'look')));
    EFFECTS.forEach((e, i) => effects.appendChild(tile(e, EFFECT_KEYS[i], 'effect')));
  }
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
  const on = conn.connected;
  for (const b of document.querySelectorAll('.tile')) b.disabled = !on;
  if ($('fxSelect').options.length) $('fxRunning').textContent = fx.id && fx.id === fx.selected ? '● running' : '';
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
  if (t.matches?.('input[type=text], textarea, select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]') || !$('setup').hidden || !$('blocker').hidden) return;
  if (e.key === '?') { e.preventDefault(); openDialog('helpDlg'); return; }
  if ($('tab-show').hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); toggleBlackout(); }
  else if (k === 'escape') { e.preventDefault(); stopEffect(true); }
  else if (!ui.locked && LOOK_KEYS.includes(k)) { e.preventDefault(); applyLook(LOOKS[LOOK_KEYS.indexOf(k)]); }
  else if (!ui.locked && EFFECT_KEYS.includes(k)) { e.preventDefault(); toggleEffect(EFFECTS[EFFECT_KEYS.indexOf(k)]); }
  else if (k === 'l') { e.preventDefault(); setLocked(!ui.locked); }
  else if ((k === 'arrowup' || k === 'arrowdown') && !ui.locked && !t.matches?.('input[type=range]')) {
    e.preventDefault();
    nudgeBrightness((k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 1 : 5));
  }
});

let wakeLock = null;
async function updateWakeLock() {
  const want = $('wakeChk').checked && ['connected', 'connecting', 'reconnecting'].includes(conn.status)
    && document.visibilityState === 'visible';
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
  if (conn.connected && prefs.get('confirmClose', true)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- debug tab ----------

function renderWriteTargets() {
  const sel = $('writeTarget');
  const prev = sel.value;
  const writable = conn.chars.filter((c) => !c.ota && (c.props.includes('write') || c.props.includes('writeWithoutResponse')));
  sel.innerHTML = '';
  if (!writable.length) sel.add(new Option('— not connected —', ''));
  for (const c of writable) sel.add(new Option(`${shortUuid(c.uuid)} [${c.props.join(',')}]`, c.id));
  sel.value = writable.some((c) => c.id === prev) ? prev : (conn.ctrl?.id ?? writable[0]?.id ?? '');
}

function renderGatt() {
  if (!conn.chars.length) { $('gatt').textContent = '(not connected)'; return; }
  const lines = [];
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
  el.textContent = conn.log.join('\n');
  $('logTitle').textContent = `Log (${conn.log.length})`;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function parseServiceList(text) {
  const out = [];
  for (let tok of text.split(/[\s,]+/)) {
    if (!tok) continue;
    tok = tok.toLowerCase();
    const v = /^(0x)?[0-9a-f]{4}$|^(0x)?[0-9a-f]{8}$/.test(tok) ? parseInt(tok.replace(/^0x/, ''), 16) : tok;
    try { out.push(BluetoothUUID.getService(v)); } catch { conn.logLine(`ignored invalid service "${tok}"`); }
  }
  return out;
}

function copy(text) { navigator.clipboard.writeText(text).catch((e) => conn.logLine(`Copy failed: ${e.message}`)); }

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
  let wasConnected = false, hadLoss = false;
  conn.addEventListener('problem', (ev) => {
    const { code, error } = ev.detail;
    const m = explainProblem(code, error, env);
    if (!$('setup').hidden) { setupMessage(m); return; }
    if (code === 'lost') hadLoss = true;
    const actions = [];
    if (code === 'forgotten' || code === 'not-light') actions.push({ label: 'Pair light', primary: true, fn: () => conn.pair() });
    if (code === 'connect') actions.push({ label: 'Try again', primary: true, fn: onConnectClick });
    if (code === 'retrying') actions.push({ label: 'Retry now', primary: true, fn: onConnectClick });
    if (['adapter', 'connect', 'retrying', 'chooser'].includes(code)) actions.push({ label: 'Help', fn: () => openDialog('helpDlg') });
    toast({ ...m, actions });
  });
  conn.addEventListener('status', () => {
    if (conn.status === 'connected' && !wasConnected) {
      clearToast(explainProblem('lost', null, env).title);
      clearToast(explainProblem('retrying', null, env).title);
      toast({ level: 'ok', title: hadLoss ? 'Reconnected' : `Connected to ${lightName()}` });
      hadLoss = false;
      renderSettingsInfo();
    }
    wasConnected = conn.status === 'connected';
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
    conn.pair();
  });
  $('setupSkip').addEventListener('click', closeSetup);
  conn.addEventListener('status', () => {
    if ($('setup').hidden) return;
    if (conn.status === 'connecting') setupMessage({ level: 'info', title: 'Connecting…' });
    if (conn.status === 'connected') {
      $('chkPair').classList.add('ok');
      $('chkPair').querySelector('.mark').textContent = '';
      setupMessage({ level: 'ok', title: `Connected to ${lightName()}. You’re ready.`, body: 'Next time the app connects by itself.' });
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

async function forgetLight() {
  conn.disconnect();
  try { await conn.device?.forget?.(); } catch {}
  try { localStorage.removeItem('gvm.deviceId'); localStorage.removeItem('gvm.deviceName'); } catch {}
  conn.logLine('Forgot light');
  renderConn();
  renderSettingsInfo();
  toast({ level: 'info', title: 'Light forgotten', body: 'Press “Pair light” to choose it again.' });
}

function setDim(on) {
  document.body.classList.toggle('dim', on);
  $('dimBtn').classList.toggle('on', on);
  $('setDim').checked = on;
  prefs.set('dim', on);
}

function renderSettingsInfo() {
  $('setLightInfo').textContent = conn.rememberedId
    ? `Paired with ${conn.deviceName}. ${conn.connected ? 'Connected now.' : 'Not connected.'}`
    : 'No light paired yet.';
  $('setForget').disabled = !conn.rememberedId;
  $('setReconnect').disabled = !env.supported || conn.connected;
}

function syncSettingsForm() {
  $('setName').value = prefs.get('lightName', '');
  $('setName').placeholder = conn.deviceName;
  $('setAuto').checked = prefs.get('autoConnect', true);
  $('wakeChk').checked = prefs.get('wake', true);
  $('setConfirm').checked = prefs.get('confirmClose', true);
  $('setDim').checked = document.body.classList.contains('dim');
  $('setDebug').checked = prefs.get('showDebug', false);
  renderSettingsInfo();
}

function initSettings() {
  $('appVersion').textContent = APP_VERSION;
  $('envInfo').textContent = `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]}${env.supported ? '' : ' (no Web Bluetooth)'}`;
  $('settingsBtn').addEventListener('click', () => openDialog('settingsDlg'));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeDialog(b.closest('dialog')));

  $('setName').addEventListener('input', () => { prefs.set('lightName', $('setName').value.trim()); renderConn(); });
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
  $('setReconnect').addEventListener('click', () => { closeDialog($('settingsDlg')); onConnectClick(); });
  confirmButton($('setForget'), 'Click again to forget', forgetLight);
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
  conn.addEventListener('status', renderSettingsInfo);
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
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('tab-show').hidden = name !== 'show';
  $('tab-debug').hidden = name !== 'debug';
  prefs.set('tab', name);
  if (name === 'debug') renderLog();
}

function init() {
  for (const sel of ['#powerBtn', '#fadeCtl', '#bri', '#modeSeg', '#cctPanel', '#hsiPanel']) {
    document.querySelector(sel).classList.add('lockable');
  }

  conn.addEventListener('status', renderConn);
  conn.addEventListener('light', syncFromLight);
  conn.addEventListener('gatt', () => { renderGatt(); renderWriteTargets(); });
  conn.addEventListener('log', () => { if (!$('tab-debug').hidden) renderLog(); });

  $('connectBtn').addEventListener('click', onConnectClick);
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  $('lockBtn').addEventListener('click', () => setLocked(!ui.locked));
  $('dimBtn').addEventListener('click', () => setDim(!document.body.classList.contains('dim')));

  $('powerBtn').addEventListener('click', () => {
    takeover();
    cancelFade();
    if (isDark()) restore({ snap: true });
    else conn.sendFrames(P.power(false), 'power off');
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
      if (ui.staged) { ui.staged.mode = b.dataset.mode; setMode(b.dataset.mode); renderPreview(); return; }
      setMode(b.dataset.mode);
      conn.light.mode = b.dataset.mode;
      await conn.sendFrames(P.mode(b.dataset.mode), `mode ${b.dataset.mode}`);
    });
  }

  for (const id of ['bri', 'cct', 'hue', 'sat']) bindLiveSlider(id);

  for (const c of document.querySelectorAll('#cctPanel .chip')) {
    c.addEventListener('click', () => { takeover(); $('cct').value = c.dataset.k; renderValues(); sendValue('cct', +c.dataset.k, { quiet: false }); });
  }
  for (const s of document.querySelectorAll('.swatches button')) {
    s.addEventListener('click', () => { takeover(); $('hue').value = s.dataset.h; renderValues(); sendValue('hue', +s.dataset.h, { quiet: false }); });
  }


  // debug
  const sendHex = () => {
    const bytes = parseHex($('hexInput').value);
    if (!bytes) { conn.logLine(`Invalid hex input: "${$('hexInput').value}"`); return; }
    conn.write(conn.chars.find((c) => c.id === $('writeTarget').value), bytes, 'raw');
  };
  $('sendHexBtn').addEventListener('click', sendHex);
  $('hexInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendHex(); });
  $('handshakeBtn').addEventListener('click', () => conn.sendFrames(P.handshake(), 'handshake'));
  $('echoChk').addEventListener('change', () => { conn.echoStatus = $('echoChk').checked; });
  $('quietChk').addEventListener('change', () => { conn.quietStatus = $('quietChk').checked; });
  $('pairAnyBtn').addEventListener('click', () => conn.pair({ anyDevice: true, extraServices: parseServiceList($('extraServices').value) }));
  $('disconnectBtn').addEventListener('click', () => conn.disconnect());
  $('forgetBtn').addEventListener('click', forgetLight);
  $('copyGattBtn').addEventListener('click', () => copy($('gatt').textContent));
  $('copyLogBtn').addEventListener('click', () => copy(conn.log.join('\n')));
  $('clearLogBtn').addEventListener('click', () => { conn.clearLog(); });
  $('downloadLogBtn').addEventListener('click', () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.download = `gvm-session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`;
    a.href = URL.createObjectURL(new Blob([conn.full.join('\n') + '\n'], { type: 'text/plain' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  initFxSettings();
  renderPresets();
  conn.addEventListener('status', () => { if (!conn.connected && fx.id) { fx.token++; fx.id = null; renderPresets(); } });
  renderStaging();
  initSettings();
  initHelp();
  initProblems();
  setDim(prefs.get('dim', false));
  showTab(prefs.get('tab', 'show'));
  setMode('cct');
  renderValues();
  renderConn();
  renderWriteTargets();

  conn.logLine(`GVM Show Control ${APP_VERSION} · ${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]}`);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => conn.logLine(`Service worker: ${e.message}`));
  }

  const block = blockReason(env);
  if (block) { showBlocker(block); return; }
  if (!conn.rememberedId && !prefs.get('setupDone', false)) openSetup();
  else if (prefs.get('autoConnect', true)) conn.restore();
}

init();
