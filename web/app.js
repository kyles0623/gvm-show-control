import { GVMProtocol as P } from './gvm-protocol.js';
import { parseHex, toHex, shortUuid, sleep } from './ble.js';
import { Rig } from './rig.js';
import { Show, describeState, normState, stateAt } from './show.js';
import { EFFECTS, GELS, defaults } from './effects.js';
import { CustomEffects, PREFIX as CUSTOM, stepColor, normStep, cycleSeconds } from './customfx.js';
import { APP_VERSION, repoUrl, detectEnv, blockReason, bluetoothSteps, explainProblem, LIGHT_STEPS, OS_NAME, BROWSER_NAME } from './setup.js';

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
  $('connSub').title = n === 1 ? 'Double-click to rename the light' : '';
  const btn = $('connectBtn');
  btn.hidden = !rig.supported || (n > 0 && c === n) || rig.lights.some((l) => l.conn.status === 'connecting');
  btn.textContent = !n ? 'Pair light' : rig.lights.some((l) => l.conn.status === 'reconnecting') ? 'Retry now' : 'Connect';
  const on = rig.anyConnected;
  for (const el of document.querySelectorAll('#tab-show button, #tab-show input[type=range], #gelSel')) {
    if (el.closest('.fx-settings')) continue;          // effect settings stay editable offline
    el.disabled = !on;
  }
  renderChips();
  renderCueBar();
  updateWakeLock();
  renderLight();
}

/** Replaces `el` with a text box to rename light `l`; Enter/blur saves, Esc cancels. */
function startRename(el, l) {
  if (!l || ui.renaming) return;
  ui.renaming = l.id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = l.label;
  input.maxLength = 24;
  input.setAttribute('aria-label', `Name for ${l.label}`);
  const done = (save) => {
    if (ui.renaming !== l.id) return;
    ui.renaming = null;
    if (save && input.value.trim() && input.value.trim() !== l.label) {
      rig.rename(l.id, input.value);
      toast({ level: 'ok', title: `Renamed to “${l.label}”` });
    }
    $('lightChips').dataset.ids = '';
    renderConn();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => done(true));
  el.replaceWith(input);
  input.focus();
  input.select();
}

function renderChips() {
  if (ui.renaming) return;                     // don't touch the chips under an open rename box
  const bar = $('lightChips');
  // No lights: the header's "Pair light" button covers it. One light: only "+ Add light".
  // Two or more: All, one chip per light, then "+".
  bar.hidden = !rig.lights.length || !env.supported;
  if (bar.hidden) { bar.innerHTML = ''; bar.dataset.ids = ''; return; }
  const multi = rig.lights.length > 1;
  // Build the chips only when the set of lights changes; otherwise update them in place, so a
  // double-click (rename) isn't broken by the re-render that the first click's selection causes.
  const ids = multi ? ['all', ...rig.lights.map((l) => l.id), 'add'].join('|') : 'add';
  if (bar.dataset.ids !== ids) {
    bar.dataset.ids = ids;
    bar.innerHTML = '';
    if (!multi) { bar.appendChild(addLightChip(false)); updateAddChip(); return; }
    const all = document.createElement('button');
    all.className = 'lchip';
    all.textContent = 'All';
    all.title = 'Controls act on every light (Tab cycles)';
    all.addEventListener('click', () => rig.select(null));
    bar.appendChild(all);
    for (const l of rig.lights) {
      const b = document.createElement('button');
      b.className = 'lchip';
      b.dataset.id = l.id;
      const dot = document.createElement('span');
      const sw = document.createElement('span'); sw.className = 'lsw';
      const name = document.createElement('span'); name.className = 'lchip-name';
      b.append(dot, sw, name);
      b.addEventListener('click', (e) => rig.select(l.id, { add: e.shiftKey || e.metaKey || e.ctrlKey }));
      b.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(b, rig.get(l.id)); });
      bar.appendChild(b);
    }
    bar.appendChild(addLightChip(true));
  }
  updateAddChip();
  if (!multi) return;
  bar.firstChild.classList.toggle('sel', !rig.selection);
  for (const b of [...bar.children].slice(1)) {
    const l = rig.get(b.dataset.id);
    if (!l) continue;
    b.classList.toggle('sel', !!rig.selection && rig.isSelected(l.id));
    b.title = `${l.label}: ${STATUS_TEXT[l.conn.status]}${l.conn.connected ? ` · ${describeState({ ...stateOf(l), power: l.conn.light.power })}` : ''}\nClick: control only this light · Shift/⌘-click: add or remove · Double-click: rename`;
    b.children[0].className = 'dot ' + l.conn.status;
    b.children[1].style.background = l.conn.connected ? stateColor({ ...stateOf(l), power: l.conn.light.power }) : '#222';
    b.children[2].textContent = l.label;
  }
}

/** "+ Add light" at the end of the chips: opens the Bluetooth chooser to pair one more light. */
function addLightChip(compact) {
  const b = document.createElement('button');
  b.className = 'ladd';
  b.id = 'chipAddLight';
  b.textContent = compact ? '+' : '+ Add light';
  b.setAttribute('aria-label', 'Add a light');
  b.title = 'Pair another light: opens the Bluetooth device list (choose BT_LED)';
  b.addEventListener('click', addLight);
  return b;
}
function updateAddChip() {
  const b = $('chipAddLight');
  if (b) b.disabled = ui.pairing || !env.supported;
}
async function addLight() {
  if (ui.pairing) return;
  ui.pairing = true; updateAddChip();
  try {
    const before = rig.lights.length;
    const l = await rig.pair();
    if (l && rig.lights.length > before) toast({ level: 'ok', title: `Added ${l.label}`, body: 'Double-click its chip to rename it. Tab switches between lights.' });
  } finally { ui.pairing = false; updateAddChip(); }
}

/** Tab / Shift+Tab: All → first light → second light → … → All. */
function cycleLights(dir) {
  const order = [null, ...rig.lights.map((l) => l.id)];
  const cur = rig.selection && rig.selection.size === 1 ? order.indexOf([...rig.selection][0]) : 0;
  const next = order[(Math.max(0, cur) + dir + order.length) % order.length];
  rig.select(next);
  const chip = document.querySelector(next ? `.lchip[data-id="${next}"]` : '.lchip:not([data-id])');
  chip?.classList.add('flash');
  setTimeout(() => chip?.classList.remove('flash'), 400);
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
  renderLightBlackouts();
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
  if (rig.lights.length > 1) renderLightBlackouts();
  const p = primary();
  if (!p?.conn.connected) { $('readoutAge').textContent = ''; return; }
  if (p.conn.noReply) { $('readoutAge').textContent = 'no reply from the light'; return; }
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

/** Cancels every running fade (all lights). */
function cancelFade() {
  ui.fadeToken++;
  for (const l of rig.lights) l.fadeTok = null;
  ui.fading = false; ui.fadeT = 0; $('fadeStatus').textContent = '';
}

/**
 * Fades each light from its current look to `to` (partial looks keep the other values) over `ms`.
 * Returns false if cancelled by another fade, blackout, or manual control.
 */
async function crossfade(jobs, ms, { label = 'FADE' } = {}) {
  // Each light belongs to the newest fade that includes it, so fading one light (e.g. its own blackout)
  // doesn't stop a fade running on the others.
  const token = ++ui.fadeToken;
  const tok = {};
  const plans = jobs.filter((j) => j.light.conn.connected).map(({ light, to }) => {
    const from = stateOf(light);
    light.fadeTok = tok;
    return { light, from, to: { ...from, ...to } };
  });
  if (!plans.length) return true;
  const live = (p) => p.light.fadeTok === tok;
  if (ms <= 0) {
    await each(plans, (p) => applyStateTo(p.light, p.to, { guard: () => live(p) }));
    for (const p of plans) if (live(p)) p.light.fadeTok = null;
    syncFromLight();
    return plans.every(live) || plans.every((p) => p.light.fadeTok === null);
  }
  rig.logLine(`${label}: ${ms / 1000}s · ${plans.map((p) => `${p.light.label} → ${describeState(normState(p.to))}`).join(' · ')}`);
  ui.fading = true;
  const stepMs = ms <= 1500 ? 70 : 120;
  const start = performance.now();
  for (;;) {
    const active = plans.filter(live);
    if (!active.length) { rig.logLine(`${label} cancelled`); return false; }
    const t = Math.min(1, (performance.now() - start) / ms);
    if (token === ui.fadeToken) ui.fadeT = t;
    await each(active, (p) => applyStateTo(p.light, stateAt(p, t), { guard: () => live(p) }));
    const pl = active.find((p) => p.light === primary());
    if (pl) { $('bri').value = Math.round(stateAt(pl, t).bri); renderValues(); }
    if (token === ui.fadeToken) $('fadeStatus').textContent = `fading… ${Math.round(t * 100)}%`;
    if (t >= 1) break;
    await sleep(stepMs);
  }
  const complete = plans.every(live);
  for (const p of plans) if (live(p)) p.light.fadeTok = null;
  if (token === ui.fadeToken) { ui.fading = false; ui.fadeT = 0; $('fadeStatus').textContent = ''; }
  syncFromLight();
  return complete;
}

// ---------- blackout: master (all lights) and per light ----------

function setBusy(b) {
  ui.busy = b;
  $('blackoutBtn').classList.toggle('busy', b);
}

/** Fades (if a fade time is set) and powers off `lights`; each remembers its level for Restore. */
async function blackout(lights = rig.connected, { label = 'BLACKOUT' } = {}) {
  lights = lights.filter((l) => l.conn.connected && !isDarkLight(l));
  if (!lights.length) return;
  for (const l of lights) { l.blackoutPre = l.conn.light.brightness ?? +$('bri').value; l.busy = true; }
  renderLightBlackouts();
  try {
    if (ui.fadeMs > 0 && !(await crossfade(lights.map((l) => ({ light: l, to: { bri: 0 } })), ui.fadeMs, { label: `${label} fade` }))) return;
    await each(lights, (l) => l.conn.sendFrames(P.power(false), label));
  } finally { for (const l of lights) l.busy = false; renderLightBlackouts(); }
}

/** Powers dark `lights` back on and returns each to its pre-blackout brightness (fading if a fade time is set). */
async function restore(lights = rig.connected, { label = 'RESTORE' } = {}) {
  lights = lights.filter((l) => l.conn.connected && isDarkLight(l));
  if (!lights.length) return;
  const fade = ui.fadeMs > 0;
  const target = new Map(lights.map((l) => [l, l.blackoutPre ?? l.conn.light.brightness ?? +$('bri').value]));
  for (const l of lights) l.busy = true;
  renderLightBlackouts();
  try {
    await each(lights, async (l) => {
      if (fade && l.conn.light.brightness !== 0) await l.conn.sendFrames(P.brightness(0), 'restore prep', { quiet: true });
      await l.conn.sendFrames(P.power(true), label);
      if (fade) l.conn.light.brightness = 0;
      else if (l.conn.light.brightness !== target.get(l)) await l.conn.sendFrames(P.brightness(target.get(l)), 'restore level');
    });
    if (fade && !(await crossfade(lights.map((l) => ({ light: l, to: { bri: target.get(l) } })), ui.fadeMs, { label: `${label} fade` }))) return;
    for (const l of lights) l.blackoutPre = null;
  } finally { for (const l of lights) l.busy = false; renderLightBlackouts(); }
}

// ---------- pre-show check ----------

let checking = false;

async function runPreShowCheck() {
  if (checking) return;
  checking = true;
  $('checkRun').disabled = true;
  const list = $('checkList');
  list.innerHTML = '';
  $('checkSummary').textContent = 'Checking…';
  const row = (level, name, text) => {
    const li = document.createElement('li');
    li.className = `check-${level}`;
    li.innerHTML = '<span class="check-mark"></span><b></b> <span></span>';
    li.querySelector('.check-mark').textContent = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
    li.querySelector('b').textContent = name;
    li.querySelector('span:last-child').textContent = text;
    list.appendChild(li);
    return li;
  };
  let bad = 0, warn = 0;
  if (!rig.lights.length) { row('bad', 'No lights', 'pair a light first'); bad++; }
  for (const l of rig.lights) {
    const c = l.conn;
    if (!c.connected) { row('bad', l.label, STATUS_TEXT[c.status].toLowerCase().replace('…', '')); bad++; continue; }
    const age = (Date.now() - (c.lastRxAt || 0)) / 1000;
    if (isDarkLight(l) || runOf(l) || l.busy) {
      const why = isDarkLight(l) ? 'off (not flashed)' : runOf(l) ? `running ${runOf(l).e.name} (not flashed)` : 'fading (not flashed)';
      if (age < 7 && !c.noReply) row('ok', l.label, `${why}, answered ${age < 1 ? 'just now' : `${Math.round(age)} s ago`}`);
      else { row('bad', l.label, `${why}, no answer for ${Math.round(age)} s`); bad++; }
      continue;
    }
    // Flash: dip brightness and wait for the light's acknowledgement, then put it back.
    const li = row('warn', l.label, 'flashing…');
    const chip = document.querySelector(`.lchip[data-id="${CSS.escape(l.id)}"]`);
    chip?.classList.add('flash');
    // The dip must differ from what the light itself last reported, or it won't acknowledge it.
    const reported = c.confirmed[2] ?? c.light.brightness ?? 50;
    const cur = c.wanted.brightness ?? reported;
    const dip = reported > 25 ? 10 : Math.min(100, reported + 40);
    const t0 = performance.now();
    const acked = c.waitAck(2, 1500);
    await c.sendFrames(P.brightness(dip), 'check: flash', { quiet: true });
    const ok = await acked;
    const ms = Math.round(performance.now() - t0);
    await sleep(350);
    await c.sendFrames(P.brightness(cur), 'check: back', { quiet: true });
    chip?.classList.remove('flash');
    li.remove();
    if (ok) row(ms > 400 ? 'warn' : 'ok', l.label, `answered in ${ms} ms${ms > 400 ? ' (slow: check distance)' : ''}`);
    else row('bad', l.label, 'flashed, but no answer: check the light is on and in range');
    if (!ok) bad++; else if (ms > 400) warn++;
  }
  // Cues that use lights that aren't here or aren't connected.
  show.cues.forEach((cu, i) => {
    const ids = [...new Set([...Object.keys(cu.lights), ...cueEffects(cu).flatMap((e) => e.lightIds ?? [])])];
    const gone = ids.filter((id) => !rig.get(id));
    const off = ids.filter((id) => rig.get(id) && !rig.get(id).conn.connected).map((id) => rig.get(id).label);
    if (gone.length) { row('warn', `Cue ${i + 1}`, `uses ${gone.length} light(s) that are no longer paired: they'll be skipped`); warn++; }
    if (off.length) { row('warn', `Cue ${i + 1}`, `uses ${off.join(', ')} (not connected)`); warn++; }
  });
  $('checkSummary').textContent = bad ? `${bad} problem${bad > 1 ? 's' : ''} found` : warn ? `Ready, with ${warn} warning${warn > 1 ? 's' : ''}` : `All ${rig.lights.length} light${rig.lights.length > 1 ? 's' : ''} ready`;
  $('checkSummary').className = 'check-summary ' + (bad ? 'check-bad' : warn ? 'check-warn' : 'check-ok');
  rig.logLine(`CHECK: ${$('checkSummary').textContent}`);
  checking = false;
  $('checkRun').disabled = false;
}

// ---------- custom effect builder (Effects tab) ----------

const fxb = { sel: prefs.get('fxb.sel', null) };

function initEffectEditor() {
  customFx.addEventListener('change', onCustomFxChange);
  $('fxbNew').addEventListener('click', () => {
    const d = customFx.add();
    fxb.sel = d.id; prefs.set('fxb.sel', d.id);
    renderEffectEditor();
    $('fxbEdit').querySelector('.fxb-name')?.select();
  });
}

function renderEffectEditor() {
  if ($('tab-effects').hidden) return;
  const listEl = $('fxbList'), ed = $('fxbEdit');
  const keep = document.activeElement && ed.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  if (!customFx.get(fxb.sel)) fxb.sel = customFx.list[0]?.id ?? null;
  listEl.innerHTML = '';
  if (!customFx.list.length) {
    const p = document.createElement('p'); p.className = 'hint empty'; p.textContent = 'No custom effects yet. Press + New effect.';
    listEl.appendChild(p);
  }
  for (const d of customFx.list) {
    const e = findEffect(CUSTOM + d.id);
    const b = document.createElement('button');
    b.className = 'fxb-item' + (d.id === fxb.sel ? ' sel' : '');
    b.innerHTML = '<span class="cfx-sw"></span><span class="fxb-item-name"></span><span class="hint"></span>';
    b.querySelector('.cfx-sw').style.background = e.swatch;
    b.querySelector('.fxb-item-name').textContent = d.name;
    b.querySelector('.hint').textContent = `${d.steps.length} step${d.steps.length === 1 ? '' : 's'} · ${cycleSeconds(d).toFixed(1)} s`;
    b.addEventListener('click', () => { fxb.sel = d.id; prefs.set('fxb.sel', d.id); renderEffectEditor(); });
    listEl.appendChild(b);
  }
  ed.innerHTML = '';
  const d = customFx.get(fxb.sel);
  if (!d) return;
  const id = CUSTOM + d.id;
  const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const btn = (text, cls, title, fn) => { const b = mk('button', 'btn sm ' + (cls ?? ''), text); b.title = title; b.addEventListener('click', fn); return b; };

  // Head: name, preview, duplicate, delete
  const head = mk('div', 'fxb-head');
  const name = mk('input', 'fxb-name');
  name.type = 'text'; name.value = d.name; name.maxLength = 40; name.dataset.focus = 'name'; name.setAttribute('aria-label', 'Effect name');
  name.addEventListener('change', () => customFx.rename(d.id, name.value.trim()));
  const st = effectState(id);
  const play = btn(st === 'all' ? '■ Stop' : '▶ Preview', 'primary', 'Start / stop it on the selected light(s)', () => { const e = findEffect(id); if (e) toggleEffect(e); setTimeout(renderEffectEditor, 50); });
  play.disabled = !rig.anyConnected;
  const dup = btn('Duplicate', '', 'Make a copy', () => { const c = customFx.duplicate(d.id); if (c) { fxb.sel = c.id; prefs.set('fxb.sel', c.id); renderEffectEditor(); } });
  const del = btn('Delete', 'danger', 'Delete this effect', () => {});
  confirmButton(del, 'Sure?', () => { customFx.remove(d.id); toast({ level: 'ok', title: `Deleted “${d.name}”` }); });
  head.append(name, play, dup, del);
  const info = mk('p', 'hint fxb-info', `${d.steps.length} step${d.steps.length === 1 ? '' : 's'} · ${cycleSeconds(d).toFixed(1)} s per cycle at speed 1× · loops until stopped (or its Run for time). Speed and Run for are in the Effects settings on the Show tab.`);

  // Steps
  const table = mk('div', 'fxb-steps');
  const hdr = mk('div', 'fxb-row fxb-hdr');
  for (const h of ['#', '', 'Color', 'Value', 'Level %', 'Hold s', 'Fade s', 'Gel', '']) hdr.append(mk('span', '', h));
  table.append(hdr);
  const set = (i, patch) => { const steps = d.steps.map((s) => ({ ...s })); Object.assign(steps[i], patch); customFx.setSteps(d.id, steps); };
  const move = (i, k) => { const steps = d.steps.map((s) => ({ ...s })); const j = i + k; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; customFx.setSteps(d.id, steps); };
  d.steps.forEach((s, i) => {
    const row = mk('div', 'fxb-row');
    const sw = mk('span', 'cfx-sw'); sw.style.background = stepColor(s);
    const mode = mk('select', 'fxb-mode');
    mode.add(new Option('White', 'cct')); mode.add(new Option('Color', 'hsi'));
    mode.value = s.mode; mode.dataset.focus = `${i}:mode`;
    mode.addEventListener('change', () => set(i, { mode: mode.value }));
    const val = mk('span', 'fxb-val');
    const n = (v, o, f, key) => { const x = numInput(document, v, o, (nv) => { if (nv != null) f(nv); }); x.dataset.focus = `${i}:${key}`; return x; };
    if (s.mode === 'cct') {
      val.append(n(s.cct, { min: 3200, max: 5600, step: 100 }, (v) => set(i, { cct: v }), 'cct'), mk('small', '', 'K'));
    } else {
      val.append(n(s.hue, { min: 0, max: 360, step: 5 }, (v) => set(i, { hue: v }), 'hue'), mk('small', '', '°'),
        n(s.sat, { min: 0, max: 100, step: 1 }, (v) => set(i, { sat: v }), 'sat'), mk('small', '', '%'));
    }
    const bri = n(s.bri, { min: 0, max: 100, step: 1 }, (v) => set(i, { bri: v }), 'bri');
    const hold = n(s.hold, { min: 0.2, max: 600, step: 0.1 }, (v) => set(i, { hold: v }), 'hold');
    const fade = n(s.fade, { min: 0, max: 60, step: 0.1 }, (v) => set(i, { fade: v }), 'fade');
    const gel = mk('select', 'fxb-gel');
    gel.add(new Option('—', ''));
    for (const g of GELS) gel.add(new Option(g.name, g.id));
    gel.dataset.focus = `${i}:gel`;
    gel.addEventListener('change', () => { const g = GELS.find((x) => x.id === gel.value); if (g) set(i, { ...g.state }); });
    const tools = mk('span', 'fxb-tools');
    tools.append(btn('↑', '', 'Move up', () => move(i, -1)), btn('↓', '', 'Move down', () => move(i, 1)),
      btn('✕', 'danger', 'Remove this step', () => customFx.setSteps(d.id, d.steps.filter((_, k) => k !== i))));
    row.append(mk('span', 'fxb-num', String(i + 1)), sw, mode, val, bri, hold, fade, gel, tools);
    table.append(row);
  });

  // Add steps
  const add = mk('div', 'row fxb-add');
  const last = d.steps.at(-1) ?? { mode: 'hsi', hue: 0, sat: 100, bri: 40, hold: 1, fade: 0 };
  add.append(
    btn('+ Add step', '', 'Add a step (copy of the last one)', () => customFx.setSteps(d.id, [...d.steps, { ...last }])),
    btn('+ Add the light’s current color', '', 'Add a step with the selected light’s current color and brightness', () => {
      const p = primary();
      if (!p?.conn.connected) { toast({ level: 'info', title: 'Connect a light first' }); return; }
      customFx.setSteps(d.id, [...d.steps, normStep({ ...stateOf(p), hold: last.hold, fade: last.fade })]);
    }),
  );
  if (d.steps.length >= 64) for (const b of add.querySelectorAll('button')) b.disabled = true;
  ed.append(head, info, table, add);
  if (keep) ed.querySelector(`[data-focus="${keep}"]`)?.focus();
}

// ---------- links: changelog, issues ----------

function issueUrl(template) {
  const chrome = /(?:Chrome|Edg|CriOS)\/(\d+)/.exec(navigator.userAgent)?.[1];
  const q = new URLSearchParams({ template, version: APP_VERSION });
  if (template === 'bug_report.yml') {
    q.set('environment', `${BROWSER_NAME[env.browser]}${chrome ? ' ' + chrome : ''} on ${OS_NAME[env.os]}`);
    if (rig.lights.length) q.set('lights', `${rig.lights.length} light${rig.lights.length > 1 ? 's' : ''}`);
  }
  return `${repoUrl()}/issues/new?${q}`;
}

function initLinks() {
  const base = repoUrl();
  const set = (cls, href) => { for (const a of document.querySelectorAll(cls)) a.href = href; };
  set('.lnk-changelog', `${base}/blob/main/CHANGELOG.md`);
  set('.lnk-idea', issueUrl('feature_request.yml'));
  set('.lnk-light', issueUrl('light_report.yml'));
  set('.lnk-repo', base);
  $('versionBadge').href = `${base}/blob/main/CHANGELOG.md`;
  // The bug link carries the current number of lights, so fill it when clicked.
  for (const a of document.querySelectorAll('.lnk-bug')) {
    a.href = issueUrl('bug_report.yml');
    a.addEventListener('click', () => { a.href = issueUrl('bug_report.yml'); });
  }
  // One notice after an update (not on first run).
  const last = prefs.get('lastVersion', null);
  if (last && last !== APP_VERSION) {
    toast({ level: 'ok', title: `Updated to v${APP_VERSION}`, body: `You were on v${last}.`, actions: [{ label: 'What’s new', fn: () => window.open(`${base}/blob/main/CHANGELOG.md`, '_blank', 'noopener') }] });
  }
  prefs.set('lastVersion', APP_VERSION);
}

// ---------- gels ----------

function initGels() {
  const sel = $('gelSel');
  sel.add(new Option('Gel… (approximate)', ''));
  let og = null;
  for (const g of GELS) {
    if (og?.label !== g.group) { og = document.createElement('optgroup'); og.label = g.group; sel.appendChild(og); }
    const desc = g.state.mode === 'cct' ? `${g.state.cct} K` : `${g.state.hue}°, ${g.state.sat}%`;
    og.appendChild(new Option(`${g.name}  ·  ${desc}`, g.id));
  }
  sel.addEventListener('change', () => {
    const g = GELS.find((x) => x.id === sel.value);
    sel.value = '';
    sel.blur();
    if (g) applyGel(g);
  });
}

/** Changes only the color of the selected lights (brightness stays), fading with the Fade time. */
async function applyGel(g, { fadeMs = ui.fadeMs } = {}) {
  const lights = targets();
  if (!lights.length) return;
  takeover();
  rig.logLine(`GEL ${g.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}${rig.lights.length > 1 ? ` → ${lights.map((l) => l.label).join(', ')}` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: { ...stateOf(l), ...g.state } })), fadeMs, { label: `GEL ${g.name}` });
  syncFromLight();
}

// ---------- restore after reconnect ----------

/**
 * When a light's link drops, remember what the app last had it doing (the app's model includes
 * commands that were sent but may never have arrived). When it reconnects, put it back.
 */
function trackLink(l) {
  if (!l) return;
  const st = l.conn.status;
  if (st === 'connected') {
    if (l.linkUp === false && l.intended) restoreAfterReconnect(l);
    l.linkUp = true;
  } else if (st === 'reconnecting' && l.linkUp) {
    l.linkUp = false;
    const w = l.conn.wanted;
    l.intended = { mode: w.mode ?? 'cct', cct: w.cct ?? 5600, hue: w.hue ?? 0, sat: w.saturation ?? 100, bri: w.brightness ?? 0, power: w.power !== false };
  }
}

async function restoreAfterReconnect(l) {
  const want = l.intended;
  l.intended = null;
  const t0 = Date.now();
  // The first status frame after the handshake tells us what the light actually has now.
  while (Date.now() - t0 < 2000 && (l.conn.lastStatusAt ?? 0) < t0) await sleep(100);
  if (!l.conn.connected) return;
  const on = l.conn.light.power !== false;
  if (want.power === false) {
    if (on) await l.conn.sendFrames(P.power(false), 'restore after reconnect: off');
  } else {
    if (!on) await l.conn.sendFrames(P.power(true), 'restore after reconnect: on');
    // A light running an effect is picked up by the effect itself; otherwise resend its look.
    if (!runOf(l)) await applyStateTo(l, want, { quiet: false });
  }
  rig.logLine(`${l.label}: restored after reconnect → ${want.power === false ? 'off' : describeState(want)}${runOf(l) ? ` (${runOf(l).e.name} resumes)` : ''}`);
  syncFromLight();
}

/** Master button: blacks out every light that is on; if all are dark, restores all of them. */
async function toggleBlackout() {
  if (!rig.anyConnected || ui.busy) return;
  clearFollow();
  cancelFade();                          // a running effect pauses while dark and resumes on Restore (Esc stops it)
  setBusy(true);
  try {
    if (allDark()) await restore(); else await blackout();
  } finally { setBusy(false); }
}

/** Per-light button: blackout / restore just this light. Leaves cues, effects and other lights alone. */
function toggleLightBlackout(l) {
  if (!l?.conn.connected || l.busy || ui.busy) return;
  rig.logLine(`${isDarkLight(l) ? 'RESTORE' : 'BLACKOUT'} ${l.label} only`);
  if (isDarkLight(l)) restore([l], { label: `RESTORE ${l.label}` });
  else blackout([l], { label: `BLACKOUT ${l.label}` });
}

/** One button per light under the master Blackout (only with 2+ lights). */
function renderLightBlackouts() {
  const box = $('lightBlackouts');
  const show = rig.lights.length > 1;
  box.hidden = !show;
  if (!show) { box.innerHTML = ''; return; }
  if (box.children.length !== rig.lights.length || [...box.children].some((b, i) => b.dataset.id !== rig.lights[i].id)) {
    box.innerHTML = '';
    for (const l of rig.lights) {
      const b = document.createElement('button');
      b.className = 'lbo';
      b.dataset.id = l.id;
      b.innerHTML = '<span class="lbo-name"></span><span class="lbo-state"></span>';
      b.addEventListener('click', () => toggleLightBlackout(rig.get(b.dataset.id)));
      box.appendChild(b);
    }
  }
  for (const b of box.children) {
    const l = rig.get(b.dataset.id);
    const dark = isDarkLight(l);
    // No reply: a command went unanswered (even after a resend), or a 5 s status was missed.
    const silent = l.conn.connected && (l.conn.noReply || Date.now() - (l.conn.lastRxAt || Date.now()) > 7000);
    b.querySelector('.lbo-name').textContent = l.label;
    b.querySelector('.lbo-state').textContent = !l.conn.connected ? (l.conn.status === 'reconnecting' ? 'reconnecting' : 'offline') : silent ? 'no reply' : l.busy ? '…' : dark ? 'OUT' : 'ON';
    b.classList.toggle('silent', silent);
    b.classList.toggle('dark', dark && l.conn.connected);
    b.classList.toggle('busy', !!l.busy);
    b.disabled = !l.conn.connected;
    b.title = `${dark ? 'Restore' : 'Black out'} only ${l.label}${ui.fadeMs ? ` (fade ${ui.fadeMs / 1000}s)` : ''}`;
  }
}

// ---------- looks ----------

const LOOK_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const EFFECT_KEYS = ['q', 'w', 'e', 'r', 't', 'y'];

async function applyLook(look, { fadeMs = ui.fadeMs } = {}) {
  const lights = targets();
  if (!lights.length) return;
  releaseFromEffect(lights);
  clearFollow();
  for (const l of lights) l.look = look.id;
  renderPresets();
  rig.logLine(`LOOK ${look.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}${rig.lights.length > 1 ? ` → ${lights.map((l) => l.label).join(', ')}` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: look.state })), fadeMs, { label: `LOOK ${look.name}` });
}

function saveCurrentLook() {
  const p = primary();
  if (!p?.conn.connected) return;
  const look = show.addLook(stateOf(p));
  p.look = look.id;
  renderPresets();
  toast({ level: 'ok', title: `Saved “${look.name}”`, body: 'Rename, reorder or delete it on the Looks tab.', actions: [{ label: 'Open Looks tab', fn: () => showTab('looks') }] });
}

// ---------- effects ----------
//
// Every light runs its own effect independently. A "run" is one started effect on one or more lights
// (several lights started together stay in sync, e.g. Cops alternating A/B). Each light belongs to at
// most one run; starting an effect on a light takes it out of whatever it was running before.
//   run = { e, params, lights[], snapshot: Map(lightId → look before the effect), deadline, dead }

const fx = { runs: [], selected: null, params: {} };

// Built-in effects plus the ones built on the Effects tab.
const customFx = new CustomEffects();
let customList = customFx.effects();
const allEffects = () => [...EFFECTS, ...customList];
const findEffect = (id) => allEffects().find((x) => x.id === id) ?? null;

// Saved settings per effect: the starting values for new runs (each run gets its own copy).
function ensureParams() {
  for (const e of allEffects()) {
    if (fx.params[e.id]) continue;
    const saved = prefs.get('fx.' + e.id, {});
    fx.params[e.id] = { ...defaults(e) };
    for (const d of e.params) if (saved[d.id] != null) fx.params[e.id][d.id] = saved[d.id];
  }
}
ensureParams();
fx.selected = prefs.get('fx.selected', EFFECTS[0].id);
if (!findEffect(fx.selected)) fx.selected = EFFECTS[0].id;

const runOf = (l) => fx.runs.find((r) => r.lights.includes(l)) ?? null;
const fxName = (id) => findEffect(id)?.name ?? (id.startsWith(CUSTOM) ? 'deleted effect' : id);
/** 'all' | 'some' | 'none': how many of `lights` (default: the selected lights) are running effect `id`. */
function effectState(id, lights = targets()) {
  const n = lights.filter((l) => runOf(l)?.e.id === id).length;
  return !lights.length || !n ? 'none' : n === lights.length ? 'all' : 'some';
}

/**
 * Starts effect `e` on `lights` (default: selected lights), or, if all of them are already running it,
 * stops it on them and returns them to their look from before. Other lights are not touched.
 * Random effects (perLight) run an independent pattern on each light; others stay in sync,
 * and steps with `alt` give every other light the alternate color when params.multi = 'alternate'.
 */
async function toggleEffect(e, { params = null, lights = targets(), fromCue = false } = {}) {
  if (!lights.length) return;
  if (!fromCue && effectState(e.id, lights) === 'all') { stopEffectOn(lights, { restore: true }); return; }
  // Each light's "before" look: if it was running another effect, the look from before that one.
  const snapshot = new Map(lights.map((l) => [l.id, runOf(l)?.snapshot.get(l.id) ?? stateOf(l)]));
  stopEffectOn(lights, { restore: false, quietLog: true });
  for (const l of lights) { l.fadeTok = null; l.look = null; }   // stop fades on these lights only
  if (!fromCue) clearFollow();
  params = { ...(params ?? fx.params[e.id]) };
  const run = { e, params, lights: [...lights], snapshot, deadline: params.duration > 0 ? performance.now() + params.duration * 1000 : Infinity, dead: false };
  fx.runs.push(run);
  selectEffect(e.id);
  renderPresets();
  rig.logLine(`EFFECT ${e.name} start on ${lights.map((l) => l.label).join(', ')}${params.duration > 0 ? ` for ${params.duration}s` : ''}`);
  const guard = () => !run.dead;
  const inRun = (l) => run.lights.includes(l);   // a light leaves the run when it is edited by hand or given another effect
  // While a light is off or mid blackout/restore fade, the effect skips it (the light ignores
  // changes while off) and picks up again at the current step once it is back on.
  const paused = (l) => isDarkLight(l) || !!l.busy;
  await each(lights.filter(isDarkLight), (l) => { l.blackoutPre = null; return l.conn.sendFrames(P.power(true), 'power on (effect)'); });

  const loop = async (gen, group) => {
    for (const step of gen) {
      if (!guard() || performance.now() >= run.deadline || !group.some(inRun)) break;
      const t0 = performance.now();
      await each(group, (l) => {
        if (!l.conn.connected || !inRun(l) || paused(l)) return null;
        const alt = step.alt && params.multi === 'alternate' && lights.indexOf(l) % 2 === 1;
        return applyStateTo(l, alt ? step.alt : step.state, { guard: () => guard() && inRun(l) && !paused(l) });
      });
      if (group.includes(primary())) syncFromLight();
      const rest = Math.min(step.wait - (performance.now() - t0), run.deadline - performance.now());
      if (rest > 0) await sleep(rest);
    }
  };
  if (e.perLight) await each(lights, (l) => loop(e.steps(params), [l]));
  else await loop(e.steps(params), lights);

  if (run.dead) return;
  if (performance.now() >= run.deadline) {
    rig.logLine(`EFFECT ${e.name} finished after ${params.duration}s on ${run.lights.map((l) => l.label).join(', ')}`);
    await stopEffectOn([...run.lights], { restore: true });
  } else endRun(run);
}

function endRun(run) {
  run.dead = true;
  fx.runs = fx.runs.filter((r) => r !== run);
  renderPresets();
  renderFxParams();
}

/**
 * Stops whatever effect each of `lights` is running. Other lights in the same run keep going.
 * restore=true returns each light to the look it had before its effect started.
 */
async function stopEffectOn(lights, { restore = false, quietLog = false } = {}) {
  const back = [];
  for (const run of [...fx.runs]) {
    const gone = run.lights.filter((l) => lights.includes(l));
    if (!gone.length) continue;
    run.lights = run.lights.filter((l) => !gone.includes(l));
    if (!quietLog) {
      rig.logLine(`EFFECT ${run.e.name} stop on ${gone.map((l) => l.label).join(', ')}${restore ? ' (restore previous look)' : ''}${run.lights.length ? `; still running on ${run.lights.map((l) => l.label).join(', ')}` : ''}`);
    }
    if (restore) for (const l of gone) if (run.snapshot.has(l.id)) back.push([l, run.snapshot.get(l.id)]);
    if (!run.lights.length) run.dead = true;
  }
  if (fx.runs.some((r) => r.dead)) fx.runs = fx.runs.filter((r) => !r.dead);
  renderPresets();
  renderFxParams();
  if (back.length) {
    await each(back.filter(([l]) => l.conn.connected && !isDarkLight(l)), ([l, st]) => applyStateTo(l, st, { quiet: false }));
    syncFromLight();
  }
}

/** Stops every running effect (Esc, GO). */
function stopAllEffects(restore) { return stopEffectOn(fx.runs.flatMap((r) => r.lights), { restore }); }

/** Manual control: takes the selected lights out of their effects (they stay where they are), clears their look highlight. */
function takeover() { releaseFromEffect(targets()); clearFollow(); clearLookMark(targets()); }

function clearLookMark(lights) {
  if (!lights.some((l) => l.look)) return;
  for (const l of lights) l.look = null;
  renderPresets();
}

/** Takes `lights` out of their effects without restoring. */
function releaseFromEffect(lights) { if (lights.some(runOf)) stopEffectOn(lights, { restore: false }); }

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

/** Runs of effect `id` on the selected lights: the settings panel edits these live. */
const selectedRuns = (id) => [...new Set(targets().map(runOf).filter((r) => r?.e.id === id))];

function fxRunningText(id) {
  const st = effectState(id);
  if (st === 'none') return '';
  if (st === 'all') return '● running';
  return `● running on ${targets().filter((l) => runOf(l)?.e.id === id).map((l) => l.label).join(', ')}`;
}

function renderFxParams() {
  if (!$('fxSelect').options.length) return;
  const e = findEffect(fx.selected) ?? EFFECTS[0];
  // Show the values of the selected light's own run if it is running this effect, else the saved settings.
  const runs = selectedRuns(e.id);
  const p = runs[0]?.params ?? fx.params[e.id];
  // An edit goes to the saved settings (for next time) and to the runs on the selected lights.
  const setP = (k, v) => {
    fx.params[e.id][k] = v;
    for (const r of runs) {
      r.params[k] = v;
      if (k === 'duration') r.deadline = v > 0 ? performance.now() + v * 1000 : Infinity;
    }
  };
  const box = $('fxParams');
  box.innerHTML = '';
  $('fxRunning').textContent = fxRunningText(e.id);
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
          setP(d.id, v); saveParams(e.id);
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
        setP(d.id, +r.value);
        val.textContent = fmtParam(d, p[d.id]);
      });
      r.addEventListener('change', () => { saveParams(e.id); rig.logLine(`FX ${e.name} ${d.label} = ${fmtParam(d, p[d.id])}`); });
      wrap.appendChild(r);
    }
    box.appendChild(wrap);
  }
}

function fillFxSelect() {
  const sel = $('fxSelect');
  sel.innerHTML = '';
  for (const e of EFFECTS) sel.add(new Option(e.name, e.id));
  if (customList.length) {
    const og = document.createElement('optgroup');
    og.label = 'Custom';
    for (const e of customList) og.appendChild(new Option(e.name, e.id));
    sel.appendChild(og);
  }
  if (!findEffect(fx.selected)) fx.selected = EFFECTS[0].id;
  sel.value = fx.selected;
}

function initFxSettings() {
  fillFxSelect();
  $('fxSelect').addEventListener('change', () => selectEffect($('fxSelect').value));
  $('fxReset').addEventListener('click', () => {
    // Saved settings and the runs on the selected lights go back to defaults.
    const def = defaults(findEffect(fx.selected));
    Object.assign(fx.params[fx.selected], def);
    for (const r of selectedRuns(fx.selected)) {
      Object.assign(r.params, def);
      r.deadline = def.duration > 0 ? performance.now() + def.duration * 1000 : Infinity;
    }
    saveParams(fx.selected);
    renderFxParams();
  });
  selectEffect(fx.selected);
}

/** Custom effects as a compact row of chips under the built-in tiles (keeps the Show tab on one screen). */
function renderCustomChips() {
  const box = $('customFx');
  const key = customList.map((e) => e.id + e.name + e.swatch).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    box.hidden = !customList.length;
    if (customList.length) {
      const h = document.createElement('span'); h.className = 'hint'; h.textContent = 'Custom';
      box.appendChild(h);
    }
    for (const e of customList) {
      const b = document.createElement('button');
      b.className = 'chip cfx';
      b.dataset.id = e.id;
      b.title = `${e.desc}\nTap to start / stop on the selected light(s). Edit it on the Effects tab.`;
      b.innerHTML = '<span class="cfx-sw"></span><span class="cfx-nm"></span>';
      b.querySelector('.cfx-sw').style.background = e.swatch;
      b.querySelector('.cfx-nm').textContent = e.name;
      b.addEventListener('click', () => { const x = findEffect(e.id); if (x) toggleEffect(x); });
      box.appendChild(b);
    }
  }
  const sel = targets();
  for (const b of box.querySelectorAll('.cfx')) {
    const st = effectState(b.dataset.id, sel);
    b.classList.toggle('running', st === 'all');
    b.classList.toggle('partial', st === 'some');
    b.disabled = !rig.anyConnected;
  }
}

/** Effect chips in the cue panel's strip (built-in and custom). */
function fillCueFxStrip(strip, d) {
  strip.innerHTML = '';
  const hint = d.createElement('span'); hint.className = 'hint'; hint.textContent = 'Effects';
  strip.append(hint);
  for (const e of allEffects()) {
    const b = d.createElement('button');
    b.className = 'chip';
    b.textContent = e.name;
    b.dataset.id = e.id;
    b.title = `Start / stop ${e.name} on the selected light(s). Settings are in the Effects column.`;
    b.addEventListener('click', () => { const x = findEffect(e.id); if (x) toggleEffect(x); });
    strip.append(b);
  }
}

/** Custom effects changed (Effects tab): refresh every place that lists effects. */
function onCustomFxChange() {
  customList = customFx.effects();
  ensureParams();
  // Running custom effects: point their runs at the new effect object (same id), drop deleted ones.
  for (const r of fx.runs) {
    if (!r.e.custom) continue;
    const e = findEffect(r.e.id);
    if (e) r.e = e;
  }
  const gone = fx.runs.filter((r) => r.e.custom && !findEffect(r.e.id));
  if (gone.length) stopEffectOn(gone.flatMap((r) => r.lights), { restore: true });
  fillFxSelect();
  renderFxParams();
  renderPresets();
  for (const h of [cuePanel.hosts.panel, cuePanel.hosts.pop]) if (h) fillCueFxStrip(h.strip, h.d);
  renderCueList();
  renderEffectEditor();
}

function renderPresets() {
  const looks = $('looks'), effects = $('effects');
  looks.innerHTML = '';
  show.looks.slice(0, LOOK_KEYS.length).forEach((l, i) => looks.appendChild(tile(l, LOOK_KEYS[i], 'look')));
  if (!effects.children.length) EFFECTS.forEach((e, i) => effects.appendChild(tile(e, EFFECT_KEYS[i], 'effect')));
  renderCustomChips();
  // The board shows the selected light(s): a tile is lit when every selected light has it,
  // half-lit ("partial") when only some do.
  const sel = targets();
  for (const b of looks.children) {
    const n = sel.filter((l) => l.look === b.dataset.id).length;
    b.classList.toggle('active', !!sel.length && n === sel.length);
    b.classList.toggle('partial', n > 0 && n < sel.length);
  }
  for (const b of effects.children) {
    const st = effectState(b.dataset.id, sel);
    b.classList.toggle('running', st === 'all');
    b.classList.toggle('partial', st === 'some');
    const nm = b.querySelector('.nm');
    const item = findEffect(b.dataset.id);
    nm.innerHTML = '';
    nm.append(item.name);
    if (st !== 'none') {
      const s = document.createElement('span'); s.className = 'sub';
      s.textContent = st === 'all' ? 'running · tap to stop' : `on ${sel.filter((l) => runOf(l)?.e.id === item.id).map((l) => l.label).join(', ')} · tap for all`;
      nm.append(s);
    }
  }
  const on = rig.anyConnected;
  for (const b of document.querySelectorAll('#tab-show .tile')) b.disabled = !on;
  $('saveLookBtn').disabled = !on;
  if ($('fxSelect').options.length) $('fxRunning').textContent = fxRunningText(fx.selected);
  if (cuePanel.hosts.panel) updateCueTools();
  const pb = document.querySelector('#fxbEdit .fxb-head .btn.primary');
  if (pb && fxb.sel) pb.textContent = effectState(CUSTOM + fxb.sel) === 'all' ? '■ Stop' : '▶ Preview';
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
    const before = runOf(l)?.snapshot.get(l.id);
    const base = before ? { ...before, power: !isDarkLight(l) } : { ...stateOf(l), power: l.conn.light.power !== false };
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
  stopAllEffects(false);
  cancelFade();
  const token = ++cue.token;
  cue.index = i;
  cue.selected = c.id;
  for (const l of rig.lights) l.look = null;
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
  for (const ce of cueEffects(c)) {
    const e = findEffect(ce.id);
    const ls = (ce.lightIds?.length ? ce.lightIds : Object.keys(c.lights)).map((id) => rig.get(id)).filter((l) => l?.conn.connected);
    if (e && ls.length && token === cue.token) toggleEffect(e, { params: { ...defaults(e), ...ce.params }, lights: ls, fromCue: true });
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
  } else {
    // Timed effect on the selected lights (else on any light) that ends soonest.
    const timed = (rs) => rs.filter((r) => r.deadline !== Infinity).sort((a, b) => a.deadline - b.deadline)[0];
    const r = timed([...new Set(targets().map(runOf).filter(Boolean))]) ?? timed(fx.runs);
    if (r) text = `${r.e.name}: ${Math.max(0, (r.deadline - performance.now()) / 1000).toFixed(0)} s left`;
  }
  $('cueProg').style.width = `${pct}%`;
  $('cueState').textContent = text;
}
setInterval(updateCueProgress, 100);

// ----- Cue list: panel on the Show tab (replaces the Effects column) or its own window -----

const cuePanel = { open: false, win: null, hosts: { panel: null, pop: null } };

const isPopped = () => !!(cuePanel.win && !cuePanel.win.closed && cuePanel.hosts.pop);
/** Where the cue list is drawn right now (pop-out window wins over the panel). */
function cueHost() { return isPopped() ? cuePanel.hosts.pop : cuePanel.open ? cuePanel.hosts.panel : null; }

/** Builds the cue editor (header, toolbar, effect buttons, list) inside `root` of document `d`. */
function buildCueEditor(root, d, { popped = false } = {}) {
  const mk = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  root.innerHTML = '';
  const head = mk('div', 'row-between');
  const title = mk('div', 'label', 'Cue list');
  const hb = mk('div', 'row cue-head-btns');
  const popBtn = mk('button', 'btn sm', popped ? 'Dock in main window' : 'Pop out ⧉');
  popBtn.title = popped ? 'Close this window and show the list in the main window' : 'Open the cue list in its own window (e.g. on a second screen)';
  popBtn.addEventListener('click', () => (popped ? dockCueList() : popOutCueList()));
  hb.append(popBtn);
  if (!popped) {
    const back = mk('button', 'btn sm', 'Effects ▸');
    back.title = 'Show the Effects column again (C)';
    back.addEventListener('click', () => setCuePanel(false));
    hb.append(back);
  }
  head.append(title, hb);

  const tools = mk('div', 'row cue-tools');
  const btn = (txt, cls, tip, fn) => { const b = mk('button', 'btn sm ' + cls, txt); b.title = tip; b.addEventListener('click', fn); tools.append(b); return b; };
  const rec = btn('● Record', 'primary', 'Save every connected light’s current look as a new cue after the selected one', recordCue);
  const upd = btn('Update', '', 'Replace the selected cue with the lights’ current looks', updateSelectedCue);
  const up = btn('↑', '', 'Move the selected cue up', () => cue.selected && show.moveCue(cue.selected, -1));
  const down = btn('↓', '', 'Move the selected cue down', () => cue.selected && show.moveCue(cue.selected, 1));
  const del = btn('Delete', 'danger', 'Delete the selected cue', () => {});
  confirmButton(del, 'Sure?', deleteSelectedCue);
  const top = btn('Top', '', 'Next GO runs cue 1', () => { clearFollow(); cue.index = -1; renderCueBar(); renderCueList(); });

  const strip = mk('div', 'cue-fx-strip');
  fillCueFxStrip(strip, d);
  const hint = mk('p', 'hint cue-hint', 'Set the lights (sliders, looks, an effect), then Record. A cue saves every connected light, a fade, an optional effect with a run time, and an optional auto-GO.');
  const list = mk('div', 'cue-list' + (popped ? ' wide' : ''));
  root.append(head, tools, strip, hint, list);
  return { d, root, list, rec, upd, up, down, del, top, strip, popped };
}

function setCuePanel(open) {
  if (open && isPopped()) { cuePanel.win.focus(); return; }
  cuePanel.open = open;
  prefs.set('cuePanel', open);
  $('effectsCard').hidden = open;
  $('cuePanel').hidden = !open;
  $('cueListBtn').classList.toggle('on', open || isPopped());
  $('cueListBtn').textContent = isPopped() ? '☰ Cue list ⧉' : open ? '☰ Cue list ✓' : '☰ Cue list';
  renderCueList();
}

function popOutCueList() {
  const w = window.open('', 'gvm-cue-list', 'width=820,height=860');
  if (!w) { toast({ level: 'warn', title: 'Pop-out blocked', body: 'Allow pop-ups for this page in the address bar, then try again.' }); return; }
  const css = new URL('styles.css', location.href).href;
  w.document.open();
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cue list · GVM Show Control</title><link rel="stylesheet" href="${css}"></head><body class="popout"><main class="cue-pop"><section id="popCues" class="group cue-panel"></section></main></body></html>`);
  w.document.close();
  cuePanel.win = w;
  cuePanel.hosts.pop = buildCueEditor(w.document.getElementById('popCues'), w.document, { popped: true });
  w.addEventListener('keydown', onKeyDown);
  w.addEventListener('pagehide', () => setTimeout(() => { if (w.closed && cuePanel.win === w) dockCueList({ closeWin: false }); }, 50));
  rig.logLine('Cue list popped out');
  setCuePanel(false);
  w.focus();
}

function dockCueList({ closeWin = true } = {}) {
  const w = cuePanel.win;
  cuePanel.win = null;
  cuePanel.hosts.pop = null;
  if (closeWin && w && !w.closed) w.close();
  setCuePanel(true);
}
window.addEventListener('pagehide', () => { if (cuePanel.win && !cuePanel.win.closed) cuePanel.win.close(); });

function recordCue() {
  if (!rig.anyConnected) return;
  const after = cue.selected ? show.cueIndex(cue.selected) : null;
  const effs = runningEffectsForCue();
  const c = show.addCue({ lights: snapshotRig(), effect: effs.length === 1 ? effs[0] : null, effects: effs.length > 1 ? effs : null, fade: 2 }, after);
  cue.selected = c.id;
  rig.logLine(`RECORD cue ${show.cueIndex(c.id) + 1}`);
  renderCueList();
  toast({ level: 'ok', title: `Recorded cue ${show.cueIndex(c.id) + 1}`, body: `${Object.keys(c.lights).length} light(s)${effs.length ? ` + ${cueEffectsLabel(effs)}` : ''}` });
}

function updateSelectedCue() {
  const c = show.cues.find((x) => x.id === cue.selected);
  if (!c || !rig.anyConnected) return;
  show.updateCue(c.id, { lights: { ...c.lights, ...snapshotRig() } });
  toast({ level: 'ok', title: `Updated cue ${show.cueIndex(c.id) + 1}`, body: 'Saved the current look of the connected lights.' });
}

function deleteSelectedCue() {
  const i = show.cueIndex(cue.selected);
  if (i < 0) return;
  show.removeCue(cue.selected);
  if (cue.index >= i) cue.index = Math.max(-1, cue.index - 1);
  cue.selected = show.cues[Math.min(i, show.cues.length - 1)]?.id ?? null;
  renderCueList();
  renderCueBar();
}

function lightsSummary(d, lightsMap) {
  const wrap = d.createElement('span');
  wrap.className = 'cue-lights';
  for (const [id, st] of Object.entries(lightsMap)) {
    const sw = d.createElement('span');
    sw.className = 'lsw';
    sw.style.background = stateColor(st);
    sw.title = `${rig.get(id)?.label ?? 'light not paired'}: ${describeState(st)}`;
    wrap.appendChild(sw);
  }
  return wrap;
}

function numInput(d, value, { min = 0, max = 600, step = 0.1, placeholder = '' }, onChange) {
  const i = d.createElement('input');
  i.type = 'number';
  Object.assign(i, { min, max, step, placeholder });
  i.value = value ?? '';
  i.addEventListener('change', () => onChange(i.value === '' ? null : clamp(+i.value, min, max)));
  return i;
}

function renderCueList() {
  const h = cueHost();
  if (!h) return;
  const { d, list } = h;
  const keep = d.activeElement && list.contains(d.activeElement) ? d.activeElement.dataset.focus : null;
  list.innerHTML = '';
  if (!show.cues.length) {
    const p = d.createElement('p');
    p.className = 'hint empty';
    p.textContent = rig.anyConnected
      ? 'No cues yet. Set the lights how you want them, then press Record.'
      : 'No cues yet. Connect your light(s), set a look, then press Record.';
    list.appendChild(p);
  }
  show.cues.forEach((c, i) => {
    const row = d.createElement('div');
    row.className = 'cue-row' + (c.id === cue.selected ? ' sel' : '') + (i === cue.index ? ' live' : '');
    row.dataset.id = c.id;
    row.addEventListener('mousedown', () => { if (cue.selected !== c.id) { cue.selected = c.id; markSelected(); } });

    const num = d.createElement('span'); num.className = 'cue-num'; num.textContent = i + 1;
    const name = d.createElement('input');
    name.type = 'text'; name.value = c.name; name.placeholder = `Cue ${i + 1}`; name.className = 'cue-name';
    name.dataset.focus = `${c.id}:name`;
    name.addEventListener('change', () => { show.updateCue(c.id, { name: name.value.trim() }); renderCueBar(); });
    const fade = numInput(d, c.fade, { min: 0, max: 60, step: 0.5 }, (v) => show.updateCue(c.id, { fade: v ?? 0 }));
    fade.title = 'Fade time (s)';
    const follow = numInput(d, c.follow, { min: 0, max: 600, step: 0.5, placeholder: '—' }, (v) => show.updateCue(c.id, { follow: v }));
    follow.title = 'Auto-GO: run the next cue this many seconds after this one starts (blank = wait for GO)';

    const effSel = d.createElement('select');
    effSel.className = 'cue-fx';
    effSel.add(new (d.defaultView.Option)('No effect', ''));
    for (const e of allEffects()) effSel.add(new (d.defaultView.Option)(e.custom ? `${e.name} (custom)` : e.name, e.id));
    for (const ce of cueEffects(c)) if (!findEffect(ce.id)) effSel.add(new (d.defaultView.Option)('(deleted effect)', ce.id));
    const effs = cueEffects(c);
    if (effs.length > 1) {
      // Recorded with different effects on different lights: keep them unless the user picks one for all.
      const o = new (d.defaultView.Option)(cueEffectsLabel(effs), '__multi');
      effSel.add(o, 1);
      effSel.value = '__multi';
      effSel.title = effs.map((ce) => `${fxName(ce.id)}: ${ce.lightIds.map((id) => rig.get(id)?.label ?? id).join(', ')}`).join('\n');
    } else effSel.value = effs[0]?.id ?? '';
    const dur = numInput(d, effs[0]?.params?.duration ?? 0, { min: 0, max: 600, step: 1, placeholder: '∞' }, (v) => {
      const list = cueEffects(c);
      if (!list.length) return;
      const upd = list.map((ce) => ({ ...ce, params: { ...ce.params, duration: v ?? 0 } }));
      show.updateCue(c.id, upd.length > 1 ? { effects: upd, effect: null } : { effect: upd[0], effects: null });
    });
    dur.title = 'Effect run time in seconds (0 = until the next cue)';
    dur.disabled = !effs.length;
    effSel.addEventListener('change', () => {
      const id = effSel.value;
      if (id === '__multi') return;
      show.updateCue(c.id, { effect: id ? { id, params: { ...fx.params[id] }, lightIds: Object.keys(c.lights) } : null, effects: null });
    });

    const go = d.createElement('button');
    go.className = 'btn sm cue-go'; go.textContent = 'GO'; go.title = 'Run this cue now';
    go.disabled = !rig.anyConnected;
    go.addEventListener('click', () => goCue(i));

    const cell = (label, el, cls) => { const w = d.createElement('label'); w.className = 'cue-cell ' + (cls ?? ''); const s = d.createElement('span'); s.textContent = label; w.append(s, el); return w; };
    const line1 = d.createElement('div'); line1.className = 'cue-line1';
    line1.append(num, name, lightsSummary(d, c.lights), go);
    const line2 = d.createElement('div'); line2.className = 'cue-line2';
    line2.append(cell('Fade s', fade), cell('Auto-GO s', follow), cell('Effect', effSel, 'grow'), cell('Run s', dur));
    row.append(line1, line2);
    list.appendChild(row);
  });
  if (keep) list.querySelector(`[data-focus="${keep}"]`)?.focus();
  updateCueTools();
}

function updateCueTools() {
  const h = cueHost();
  if (!h) return;
  const sel = !!show.cues.find((c) => c.id === cue.selected);
  h.rec.disabled = !rig.anyConnected;
  h.upd.disabled = !sel || !rig.anyConnected;
  h.up.disabled = h.down.disabled = h.del.disabled = !sel;
  for (const b of h.strip.querySelectorAll('.chip')) {
    b.disabled = !rig.anyConnected;
    const st = effectState(b.dataset.id);
    b.classList.toggle('running', st === 'all');
    b.classList.toggle('partial', st === 'some');
  }
}

function markSelected() {
  const h = cueHost();
  if (!h) return;
  for (const r of h.list.children) r.classList?.toggle('sel', r.dataset.id === cue.selected);
  updateCueTools();
}

/** Every running effect, for recording a cue: [{id, params, lightIds}]. */
function runningEffectsForCue() {
  return fx.runs.filter((r) => r.lights.some((l) => l.conn.connected))
    .map((r) => ({ id: r.e.id, params: { ...r.params }, lightIds: r.lights.filter((l) => l.conn.connected).map((l) => l.id) }));
}

/** A cue's effects. Older cues and single-effect cues use `effect`; cues with several use `effects`. */
function cueEffects(c) { return c.effects?.length ? c.effects : c.effect ? [c.effect] : []; }
function cueEffectsLabel(effs) { return effs.map((ce) => fxName(ce.id)).join(' + '); }

function initCues() {
  $('cueGo').addEventListener('click', goNext);
  $('cueBack').addEventListener('click', goBack);
  $('cueListBtn').addEventListener('click', () => setCuePanel(!cuePanel.open));
  cuePanel.hosts.panel = buildCueEditor($('cuePanel'), document);
  show.addEventListener('change', (e) => {
    if (e.detail.what === 'cues') { renderCueList(); renderCueBar(); }
    else { renderPresets(); renderLookList(); }
  });
  setCuePanel(prefs.get('cuePanel', false));
  renderCueBar();
}

// ----- Looks tab: looks library -----

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

function onKeyDown(e) {
  const t = e.target;
  if (t.matches?.('input:not([type=range]):not([type=checkbox]), textarea, select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]') || !$('setup').hidden || !$('blocker').hidden) return;
  if (e.key === '?') { e.preventDefault(); openDialog('helpDlg'); return; }
  if (!$('tab-debug').hidden) return;
  if (e.key === 'Tab' && rig.lights.length > 1) { e.preventDefault(); cycleLights(e.shiftKey ? -1 : 1); return; }
  const k = e.key.toLowerCase();
  // Show-running keys work on the Show and Cues tabs, and while locked.
  if (k === ' ' || e.code === 'Space') { e.preventDefault(); if (e.shiftKey) goBack(); else if (!$('cueGo').disabled) goNext(); return; }
  if (k === 'b') { e.preventDefault(); toggleBlackout(); return; }
  if (k === 'escape') { e.preventDefault(); clearFollow(); cancelFade(); stopAllEffects(true); return; }
  if (k === 'l') { e.preventDefault(); setLocked(!ui.locked); return; }
  if (k === 'c') { e.preventDefault(); if (isPopped()) cuePanel.win.focus(); else { if ($('tab-show').hidden) showTab('show'); setCuePanel(!cuePanel.open); } return; }
  if ($('tab-show').hidden || ui.locked) return;
  if (LOOK_KEYS.includes(k)) { const look = show.looks[LOOK_KEYS.indexOf(k)]; if (look) { e.preventDefault(); applyLook(look); } }
  else if (EFFECT_KEYS.includes(k)) { e.preventDefault(); toggleEffect(EFFECTS[EFFECT_KEYS.indexOf(k)]); }
  else if ((k === 'arrowup' || k === 'arrowdown') && !t.matches?.('input[type=range]')) {
    e.preventDefault();
    nudgeBrightness((k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 1 : 5));
  }
}
document.addEventListener('keydown', onKeyDown);

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
  $('versionBadge').textContent = `v${APP_VERSION}`;
  initLinks();
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
    for (const e of allEffects()) { Object.assign(fx.params[e.id], defaults(e)); saveParams(e.id); }
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
  $('checkBtn').addEventListener('click', () => { openDialog('checkDlg'); runPreShowCheck(); });
  $('checkRun').addEventListener('click', runPreShowCheck);
  for (const [id, steps] of [['helpLight', LIGHT_STEPS], ['helpBt', bluetoothSteps(env)]]) {
    for (const s of steps) { const li = document.createElement('li'); li.textContent = s; $(id).appendChild(li); }
  }
  $('helpSetupBtn').addEventListener('click', () => { closeDialog($('helpDlg')); openSetup(); });
}

// ---------- wiring ----------

function showTab(name) {
  if (name === 'debug' && !prefs.get('showDebug', false)) name = 'show';
  if (!['show', 'looks', 'effects', 'debug'].includes(name)) name = 'show';
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('tab-show').hidden = name !== 'show';
  $('tab-looks').hidden = name !== 'looks';
  $('tab-effects').hidden = name !== 'effects';
  $('tab-debug').hidden = name !== 'debug';
  prefs.set('tab', name);
  if (name === 'debug') { renderLog(); renderGatt(); renderWriteTargets(); }
  if (name === 'looks') renderLookList();
  if (name === 'effects') renderEffectEditor();
}

function init() {
  for (const sel of ['#powerBtn', '#fadeCtl', '#bri', '#modeSeg', '#cctPanel', '#hsiPanel', '.gel-row']) {
    document.querySelector(sel).classList.add('lockable');
  }

  rig.addEventListener('status', renderConn);
  rig.addEventListener('lights', () => { renderConn(); syncFromLight(); renderPresets(); renderFxParams(); renderCueList(); });
  rig.addEventListener('light', syncFromLight);
  rig.addEventListener('gatt', () => { renderGatt(); renderWriteTargets(); });
  rig.addEventListener('log', () => { if (!$('tab-debug').hidden) renderLog(); });
  rig.addEventListener('status', (ev) => trackLink(ev.detail.light));
  rig.addEventListener('status', () => {
    // Effects survive a dropout (they skip a light while it is away and resume when it is back);
    // they end only when no light is connected or trying to reconnect.
    if (!rig.anyActive && fx.runs.length) { for (const r of fx.runs) r.dead = true; fx.runs = []; renderPresets(); }
    renderPresets();
    renderCueList();
    if (!$('tab-looks').hidden) renderLookList();
  });

  $('connectBtn').addEventListener('click', onConnectClick);
  $('connSub').addEventListener('dblclick', () => {
    if (rig.lights.length !== 1) return;
    const span = document.createElement('span');
    $('connSub').textContent = '';
    $('connSub').appendChild(span);
    startRename(span, rig.lights[0]);
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  $('lockBtn').addEventListener('click', () => setLocked(!ui.locked));
  $('dimBtn').addEventListener('click', () => setDim(!document.body.classList.contains('dim')));

  $('powerBtn').addEventListener('click', () => {
    clearFollow();                       // not takeover(): a running effect pauses while off and resumes on power on
    clearLookMark(targets());
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
  initGels();
  initEffectEditor();
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
