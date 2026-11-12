import { unionCaps, snap, DRIVERS, statusFor } from './drivers.js';
import { simulatedSteps, SPEED_TEST_MS, NEEDS_MS, colorOnly } from './simfx.js';
import { parseHex, toHex, shortUuid, sleep } from './ble.js';
import { Rig } from './rig.js';
import { Show, describeState, normState, stateAt, fmtNum } from './show.js';
import { EFFECTS, GELS, BUILTIN, ALIASES, defaults } from './effects.js';
import { VERSIONS } from './whatsnew.js';
import { CustomEffects, PREFIX as CUSTOM, stepColor, normStep, cycleSeconds, changedValues, hasRandom, RANGES, TEMPLATES } from './customfx.js';
import { Shows } from './shows.js';
import { buildBackup, parseBackup, summarize, defaultLightMap, applyBackup, backupFileName } from './backup.js';
import { APP_VERSION, repoUrl, detectEnv, blockReason, bluetoothSteps, explainProblem, LIGHT_STEPS, OS_NAME, BROWSER_NAME } from './setup.js';

const env = detectEnv();
const rig = new Rig();
const show = new Show();
const shows = new Shows();

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
/** A light's command encoder and capabilities (its driver, drivers.js). */
const E = (l) => l.conn.driver.enc;
const capsOf = (l) => l.conn.caps ?? l.conn.driver.caps;   // narrowed by the light's model (drivers.js capsFor)
/** Caps for controls that act on several lights: the paired lights' widest range. */
/** Fastest step for simulated effects on this light: the speed-test result for its kind of light, else its driver's default. */
const minStepOf = (l) => prefs.get(`minStep.${l.conn.driver.id}`, capsOf(l).minStepMs ?? 100);
/** Can light l show built-in effect e? Its own, or a simulation that isn't too fast for it. */
const whiteOnly = (l) => capsOf(l).hsi === false;                // bi-color lights (amaran Halo, some Godox / Neewer)
/** A simulated effect that only shows color: nothing to see on a white-only light. */
const needsColor = (l, e) => whiteOnly(l) && e.builtin && !capsOf(l).scenes && colorOnly(e.scene);
const canRun = (l, e) => !needsColor(l, e) && (!e.builtin || capsOf(l).scenes || (NEEDS_MS[e.scene] ?? 500) >= minStepOf(l));
/** Why lights can't run e: 'color' when it's color-only for all of them, else 'fast'. */
const naWhy = (ls, e) => (ls.length && ls.every((l) => needsColor(l, e)) ? 'color' : 'fast');
const uiCaps = () => unionCaps(rig.lights.map(capsOf));

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
  renderGel();
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
  // Lights are grouped by brand (GVM, amaran, …), each group led by a brand label that selects all of them.
  const brands = Object.values(DRIVERS).map((d) => ({ d, ls: rig.lights.filter((l) => l.conn.driver === d) })).filter((b) => b.ls.length);
  const ordered = brands.flatMap((b) => b.ls);
  const ids = multi ? ['all', ...brands.map((b) => `${b.d.id}:${b.ls.map((l) => l.id).join(',')}`), ...rig.groups.map((g) => g.id + ':' + g.name), 'add'].join('|') : 'add';
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
    for (const l of ordered) {
      const br = brands.find((x) => x.ls[0] === l);
      if (br && brands.length > 1) {
        const h = document.createElement('button');
        h.className = 'lbrand'; h.dataset.brand = br.d.id; h.textContent = br.d.brand;
        h.title = `${br.d.brand}: click to control all ${br.ls.length} ${br.d.brand} light${br.ls.length > 1 ? 's' : ''} · Shift-click to add them`;
        h.addEventListener('click', (e) => rig.selectIds(br.ls.map((x) => x.id), { add: e.shiftKey || e.metaKey || e.ctrlKey }));
        bar.appendChild(h);
      }
      const b = document.createElement('button');
      b.className = 'lchip';
      b.dataset.id = l.id;
      if (statusFor(l.conn.driver, l.model) === 'untested') b.dataset.untested = '';   // β mark (styles.css)
      const dot = document.createElement('span');
      const sw = document.createElement('span'); sw.className = 'lsw';
      const name = document.createElement('span'); name.className = 'lchip-name';
      b.append(dot, sw, name);
      b.addEventListener('click', (e) => rig.select(l.id, { add: e.shiftKey || e.metaKey || e.ctrlKey }));
      b.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(b, rig.get(l.id)); });
      bar.appendChild(b);
    }
    bar.appendChild(addLightChip(true));
    // Groups: one chip each, then "+ Group" and "Copy to…".
    for (const g of rig.groups) {
      const b = document.createElement('button');
      b.className = 'lchip gchip';
      b.dataset.group = g.id;
      b.textContent = g.name;
      b.addEventListener('click', (e) => rig.selectIds(rig.group(g.id)?.lightIds ?? [], { add: e.shiftKey || e.metaKey || e.ctrlKey }));
      b.addEventListener('dblclick', (e) => { e.preventDefault(); openGroupDialog(g.id); });
      bar.appendChild(b);
    }
  }
  updateAddChip();
  // Too many chips for the top bar: give them their own row instead of hiding some off to the side.
  bar.classList.remove('row');
  if (bar.scrollWidth > bar.clientWidth + 2) bar.classList.add('row');
  $('copyBtn').hidden = !multi;
  $('copyBtn').disabled = rig.connected.length < 2;
  if ($('settingsDlg').open) renderSettingsGroups();
  if (!multi) return;
  bar.firstChild.classList.toggle('sel', !rig.selection);
  for (const h of bar.querySelectorAll('.lbrand')) {
    const ids = rig.lights.filter((l) => l.conn.driver.id === h.dataset.brand).map((l) => l.id);
    h.classList.toggle('sel', !!rig.selection && ids.length === rig.selection.size && ids.every((id) => rig.selection.has(id)));
  }
  for (const b of bar.querySelectorAll('.gchip')) {
    const g = rig.group(b.dataset.group);
    if (!g) continue;
    b.classList.toggle('sel', !!rig.selection && rig.isGroupSelected(g));
    b.title = `${g.name}: ${rig.groupLights(g).map((l) => l.label).join(', ') || 'no lights'}\nClick: control this group · Shift/⌘-click: add it · Double-click: edit`;
  }
  for (const b of bar.querySelectorAll('.lchip[data-id]')) {
    const l = rig.get(b.dataset.id);
    if (!l) continue;
    b.classList.toggle('sel', !!rig.selection && rig.isSelected(l.id));
    b.title = `${l.label}${statusFor(l.conn.driver, l.model) === 'untested' ? ` (β: ${l.conn.driver.brand} support is untested)` : ''}: ${STATUS_TEXT[l.conn.status]}${l.conn.connected ? ` · ${describeState({ ...stateOf(l), power: l.conn.light.power })}` : ''}\nClick: control only this light · Shift/⌘-click: add or remove · Double-click: rename`;
    b.children[0].className = 'dot ' + l.conn.status;
    b.children[1].style.background = l.conn.connected ? stateColor({ ...stateOf(l), power: l.conn.light.power }) : '#222';
    b.children[2].textContent = l.label;
  }
}

// ----- light groups -----

/** Group editor: name + which lights. id null = new group from the current selection. */
function openGroupDialog(id) {
  const g = id ? rig.group(id) : null;
  $('groupDlgTitle').textContent = g ? 'Edit group' : 'New group';
  $('groupName').value = g ? g.name : `Group ${rig.groups.length + 1}`;
  const members = new Set(g ? g.lightIds : rig.selection ? [...rig.selection] : rig.lights.map((l) => l.id));
  const box = $('groupLights');
  box.innerHTML = '';
  for (const l of rig.lights) {
    const lab = document.createElement('label'); lab.className = 'switch';
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = l.id; c.checked = members.has(l.id);
    lab.append(c, ' ', l.label);
    box.appendChild(lab);
  }
  $('groupDelete').hidden = !g;
  $('groupDelete').onclick = () => { closeDialog($('groupDlg')); rig.removeGroup(g.id); toast({ level: 'ok', title: `Deleted group “${g.name}”` }); };
  $('groupForm').onsubmit = (e) => {
    e.preventDefault();
    const ids = [...box.querySelectorAll('input:checked')].map((c) => c.value);
    if (!ids.length) { toast({ level: 'warn', title: 'Pick at least one light' }); return; }
    const name = $('groupName').value.trim();
    closeDialog($('groupDlg'));
    if (g) rig.updateGroup(g.id, { name, lightIds: ids });
    else { const ng = rig.addGroup(name, ids); rig.selectIds(ng.lightIds); toast({ level: 'ok', title: `Group “${ng.name}” saved`, body: 'Click its chip to control those lights. Double-click to edit.' }); }
  };
  openDialog('groupDlg');
  $('groupName').focus(); $('groupName').select();
}

/** Settings → Groups: one row per group (click to edit). */
function renderSettingsGroups() {
  const box = $('setGroups');
  box.innerHTML = '';
  if (!rig.groups.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = rig.lights.length > 1 ? 'No groups yet. A group is a named set of lights with its own chip at the top.' : 'Pair a second light to make groups.'; box.appendChild(p); }
  for (const g of rig.groups) {
    const b = document.createElement('button'); b.className = 'btn sm';
    b.textContent = `${g.name} (${rig.groupLights(g).map((l) => l.label).join(', ') || 'no lights'})`;
    b.title = 'Edit or delete this group';
    b.addEventListener('click', () => openGroupDialog(g.id));
    box.appendChild(b);
  }
  $('setAddGroup').disabled = rig.lights.length < 2;
}

// ----- copy one light's look to others -----


/** Copy to…: pick the lights and which parts (color, brightness, on/off) to copy from the selected light. */
function openCopyMenu() {
  const src = primary();
  if (!src?.conn.connected) return;
  const others = rig.connected.filter((l) => l !== src);
  $('copyTitle').textContent = `Copy ${src.label} (${describeState({ ...stateOf(src), power: src.conn.light.power })})`;
  const box = $('copyTargets');
  box.innerHTML = '';
  for (const l of others) {
    const lab = document.createElement('label'); lab.className = 'switch';
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = l.id; c.checked = others.length === 1;
    lab.append(c, ' ', l.label);
    box.appendChild(lab);
  }
  // Group / All buttons tick their lights.
  const gb = $('copyGroups');
  gb.innerHTML = '';
  const tick = (ids) => { for (const c of box.querySelectorAll('input')) c.checked = ids.includes(c.value); syncCopyGo(); };
  const mkb = (txt, ids) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = txt; b.addEventListener('click', () => tick(ids)); gb.appendChild(b); };
  if (others.length > 1) mkb('All', others.map((l) => l.id));
  for (const g of rig.groups) {
    const ids = rig.groupLights(g).filter((l) => l !== src && l.conn.connected).map((l) => l.id);
    if (ids.length) mkb(g.name, ids);
  }
  gb.hidden = !gb.children.length;
  const props = prefs.get('copyProps', { color: true, bri: true, power: true });
  for (const c of $('copyForm').querySelectorAll('input[data-prop]')) c.checked = !!props[c.dataset.prop];
  $('copyForm').onchange = syncCopyGo;
  $('copyForm').onsubmit = (e) => {
    e.preventDefault();
    const lights = [...box.querySelectorAll('input:checked')].map((c) => rig.get(c.value)).filter(Boolean);
    const what = {};
    for (const c of $('copyForm').querySelectorAll('input[data-prop]')) what[c.dataset.prop] = c.checked;
    if (!lights.length || !Object.values(what).some(Boolean)) return;
    prefs.set('copyProps', what);
    closeDialog($('copyDlg'));
    copyLightTo(src, lights, what);
  };
  syncCopyGo();
  openDialog('copyDlg');
}
function syncCopyGo() {
  const f = $('copyForm');
  $('copyGo').disabled = !f.querySelector('#copyTargets input:checked') || !f.querySelector('input[data-prop]:checked');
}

/** Gives `lights` the parts of the source light picked in `what` ({color, bri, power}), with the Fade time. */
async function copyLightTo(src, lights, what = { color: true, bri: true, power: true }, { fadeMs = ui.fadeMs } = {}) {
  const st = stateOf(src);
  const on = src.conn.light.power !== false;
  const to = {};
  if (what.color) Object.assign(to, { mode: st.mode, cct: st.cct, hue: st.hue, sat: st.sat });
  if (what.bri) to.bri = st.bri;
  if (what.color || what.bri) {
    releaseFromEffect(lights);
    clearFollow();
    for (const l of lights) l.look = null;
  }
  if (what.color) {
    clearGel(lights);
    for (const l of lights) if (src.gel) { l.gel = src.gel; l.preGel = src.preGel; }
  }
  renderPresets(); renderGel();
  const parts = [what.color && 'color', what.bri && 'brightness', what.power && 'on/off'].filter(Boolean).join(' + ');
  rig.logLine(`COPY ${src.label} (${parts}) → ${lights.map((l) => l.label).join(', ')}`);
  if (what.power && on) await each(lights.filter((l) => l.conn.light.power === false), (l) => l.conn.sendFrames(E(l).power(true), 'copy: power on'));
  if (Object.keys(to).length) await crossfade(lights.map((l) => ({ light: l, to })), fadeMs, { label: `COPY ${src.label}` });
  if (what.power && !on) await each(lights, (l) => l.conn.sendFrames(E(l).power(false), 'copy: power off'));
  syncFromLight();
  toast({ level: 'ok', title: `Copied ${src.label}: ${parts}`, body: `→ ${lights.map((l) => l.label).join(', ')}` });
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
/** Lights in brand order (GVM, then amaran, …), as the chips show them. */
const lightsByBrand = () => Object.values(DRIVERS).flatMap((d) => rig.lights.filter((l) => l.conn.driver === d));

function cycleLights(dir) {
  const order = [null, ...lightsByBrand().map((l) => l.id)];
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

/** Controls follow what the primary light can do (its driver's caps). */
function applyCaps(p) {
  const c = p ? capsOf(p) : uiCaps();
  const cct = $('cct');
  if (+cct.min !== c.cct[0] || +cct.max !== c.cct[1] || +cct.step !== c.cctStep) Object.assign(cct, { min: c.cct[0], max: c.cct[1], step: c.cctStep });
  if (+$('hue').step !== c.hueStep) $('hue').step = c.hueStep;
  const hsiBtn = document.querySelector('#modeSeg [data-mode="hsi"]');
  if (hsiBtn) { hsiBtn.hidden = !c.hsi; }
  // Built-in effect tiles only when some paired light has them.
  const sc = uiCaps().scenes;
  // Built-in effect tiles stay: lights without them get a simulation (simfx.js). Note which ones in the tooltip.
  void sc;
}

/** Sliders follow the primary light (first selected). */
function syncFromLight(ev) {
  const p = primary();
  if (ev?.detail?.light && p && ev.detail.light !== p) { renderChipsSoon(); renderLight(); return; }
  const L = PL();
  if (L.brightness != null && !ui.fading && ui.dragging !== 'bri') $('bri').value = L.brightness;
  applyCaps(p);
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
/** The command for one control value on light l: [frames, label]. Values snap to what that light accepts. */
const ENC = {
  bri: (l, v) => [E(l).brightness(v), `brightness ${v}%`],
  cct: (l, v) => [E(l).cct(snap(capsOf(l), 'cct', v)), `cct ${snap(capsOf(l), 'cct', v)}K`],
  hue: (l, v) => [E(l).hue(snap(capsOf(l), 'hue', v)), `hue ${snap(capsOf(l), 'hue', v)}°`],
  sat: (l, v) => [E(l).saturation(v), `saturation ${v}%`],
};
const MODE_OF = { cct: 'cct', hue: 'hsi', sat: 'hsi' };

async function ensureModeOn(l, m, quiet = true) {
  if (l.conn.light.mode === m) return;
  l.conn.light.mode = m;
  await l.conn.sendFrames(E(l).mode(m), `mode ${m}`, { quiet });
}

/** Sends one control value to every target light. */
async function sendValue(id, v, { quiet = true } = {}) {
  const e = { mode: MODE_OF[id] };
  // A light running a built-in effect: Brightness is the effect's own brightness (BRG), so it stays in the effect
  // and the effect's setting follows the slider.
  if (id === 'bri') {
    const runs = new Set(targets().map(runOf).filter((r) => r?.e.builtin));
    for (const r of runs) r.params.level = v;
    if (runs.size) renderFxParamsSoon();
  }
  if (e.mode) setMode(e.mode);
  await each(targets(), async (l) => {
    if (id === 'bri' && isDarkLight(l)) l.blackoutPre = null;   // a level set while dark is what Restore returns to
    if (e.mode === 'hsi' && !capsOf(l).hsi) return;          // a white-only light ignores color
    if (e.mode) await ensureModeOn(l, e.mode);
    const [frames, label] = ENC[id](l, v);
    await l.conn.sendFrames(frames, label, { quiet });
  });
}

/** Sends only the params that differ from the light's known state: mode first, brightness last. */
async function applyStateTo(l, s, { quiet = true, guard = () => true } = {}) {
  const L = l.conn.light;
  // Lights that take a whole look in one command (mesh lights): one message instead of one per value.
  if (l.conn.applyState) {
    if (!guard()) return;
    const t = { ...s };
    for (const k of ['cct', 'hue', 'sat', 'bri']) if (t[k] != null) t[k] = snap(capsOf(l), k, t[k]);
    if (t.mode === 'hsi' && !capsOf(l).hsi) t.mode = 'cct';
    if (t.bri != null && isDarkLight(l)) l.blackoutPre = null;
    await l.conn.applyState(t, { quiet });
    return;
  }
  if (s.mode === 'hsi' && !capsOf(l).hsi) s = { ...s, mode: 'cct' };   // white-only light: keep it white
  if (s.mode && L.mode !== s.mode) {
    if (!guard()) return;
    await l.conn.sendFrames(E(l).mode(s.mode), `mode ${s.mode}`, { quiet });
    L.mode = s.mode;
  }
  for (const k of ['cct', 'hue', 'sat', 'bri']) {
    if (s[k] == null) continue;
    if (k === 'cct' && (s.mode ?? L.mode) === 'hsi') continue;          // color of the other mode is irrelevant
    if ((k === 'hue' || k === 'sat') && (s.mode ?? L.mode) === 'cct') continue;
    const v = snap(capsOf(l), k, s[k]);
    if (L[FIELD[k]] === v) continue;
    if (!guard()) return;
    if (k === 'bri' && isDarkLight(l)) l.blackoutPre = null;
    const [frames, label] = ENC[k](l, v);
    await l.conn.sendFrames(frames, label, { quiet });
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
  el.addEventListener('pointerdown', () => { if (id === 'bri') takeoverForBrightness(); else takeover(); ui.dragging = id; lastSent = null; if (id === 'bri') cancelFade(); });
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
    rig.logLine(`SET ${FIELD[id]} ${+el.value}${{ cct: 'K', hue: '°' }[id] ?? '%'}${rig.lights.length > 1 ? ` → ${targets().map((l) => l.label).join(', ')}` : ''}`);
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
    await each(lights, (l) => l.conn.sendFrames(E(l).power(false), label));
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
      if (fade && l.conn.light.brightness !== 0) await l.conn.sendFrames(E(l).brightness(0), 'restore prep', { quiet: true });
      await l.conn.sendFrames(E(l).power(true), label);
      if (fade) l.conn.light.brightness = 0;
      else if (l.conn.light.brightness !== target.get(l)) await l.conn.sendFrames(E(l).brightness(target.get(l)), 'restore level');
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
    if (c.noAnswers) {
      // Lights that send no replies (untested plain-Bluetooth lights): only the connection can be checked.
      if (!isDarkLight(l) && !runOf(l) && !l.busy) {
        const cur = c.wanted.brightness ?? 50;
        await c.sendFrames(c.driver.enc.brightness(cur > 25 ? 10 : Math.min(100, cur + 40)), 'check: flash', { quiet: true });
        await sleep(350);
        await c.sendFrames(c.driver.enc.brightness(cur), 'check: back', { quiet: true });
      }
      row('warn', l.label, 'connected; this light sends no answers, so look: did it dip?'); warn++;
      continue;
    }
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
    await c.sendFrames(c.driver.enc.brightness(dip), 'check: flash', { quiet: true });
    const ok = await acked;
    const ms = Math.round(performance.now() - t0);
    await sleep(350);
    await c.sendFrames(c.driver.enc.brightness(cur), 'check: back', { quiet: true });
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
    if (gone.length) { row('warn', `Cue ${fmtNum(cu.num)}`, `uses ${gone.length} light(s) that are no longer paired: they'll be skipped`); warn++; }
    if (off.length) { row('warn', `Cue ${fmtNum(cu.num)}`, `uses ${off.join(', ')} (not connected)`); warn++; }
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
  const tpl = $('fxbTemplate');
  tpl.hidden = !TEMPLATES.length;
  tpl.add(new Option('Start from…', ''));
  for (const t of TEMPLATES) { const o = new Option(t.name, t.id); o.title = t.desc; tpl.add(o); }
  tpl.addEventListener('change', () => {
    const t = TEMPLATES.find((x) => x.id === tpl.value);
    tpl.value = '';
    if (!t) return;
    const d = customFx.add(customFx._uniqueName(t.name), structuredClone(t.steps));
    fxb.sel = d.id; prefs.set('fxb.sel', d.id);
    renderEffectEditor();
    toast({ level: 'ok', title: `Added “${d.name}”`, body: `${t.desc}. It’s now under Custom on the Show tab; edit any step here.` });
  });
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
  const info = mk('p', 'hint fxb-info', `${d.steps.length} step${d.steps.length === 1 ? '' : 's'} · ${hasRandom(d) ? 'about ' : ''}${cycleSeconds(d).toFixed(1)} s per cycle at speed 1× · loops until stopped (or its Run for time). Speed and Run for are in the Effects settings on the Show tab.`);

  // Steps
  const table = mk('div', 'fxb-steps');
  const hdr = mk('div', 'fxb-row fxb-hdr');
  for (const h of ['#', '', 'Color', 'Value', 'Level %', 'Hold s', 'Fade s', 'Gel', '']) hdr.append(mk('span', '', h));
  table.append(hdr);
  const set = (i, patch) => { const steps = d.steps.map((s) => ({ ...s })); Object.assign(steps[i], patch); customFx.setSteps(d.id, steps); };
  const move = (i, k) => { const steps = d.steps.map((s) => ({ ...s })); const j = i + k; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; customFx.setSteps(d.id, steps); };
  d.steps.forEach((s, i) => {
    const row = mk('div', 'fxb-row');
    const sw = mk('button', 'cfx-sw sw-btn'); sw.style.background = stepColor(s);
    sw.title = 'Pick a color'; sw.setAttribute('aria-label', `Step ${i + 1} color`);
    sw.addEventListener('click', (ev) => { ev.stopPropagation(); openStepPicker(sw, d.id, i); });
    const mode = mk('select', 'fxb-mode');
    mode.add(new Option('White', 'cct')); mode.add(new Option('Color', 'hsi'));
    mode.value = s.mode; mode.dataset.focus = `${i}:mode`;
    mode.addEventListener('change', () => set(i, { mode: mode.value }));
    const val = mk('span', 'fxb-val');
    const n = (v, o, f, key) => { const x = numInput(document, v, o, (nv) => { if (nv != null) f(nv); }); x.dataset.focus = `${i}:${key}`; return x; };
    if (s.mode === 'cct') {
      val.append(n(s.cct, { min: uiCaps().cct[0], max: uiCaps().cct[1], step: uiCaps().cctStep }, (v) => set(i, { cct: v }), 'cct'), mk('small', '', 'K'));
    } else {
      val.append(n(s.hue, { min: 0, max: 360, step: 5 }, (v) => set(i, { hue: v }), 'hue'), mk('small', '', '°'),
        n(s.sat, { min: 0, max: 100, step: 1 }, (v) => set(i, { sat: v }), 'sat'), mk('small', '', '%'));
    }
    // Level / Hold / Fade: a fixed value, or (toggle ~) a random range picked anew each time the step runs.
    const ranged = (key, opts, input) => {
      const [base, to] = RANGES[key];
      const wrap = mk('span', 'fxb-rng');
      const tog = mk('button', 'fxb-rnd' + (s[to] != null ? ' on' : ''), '~');
      tog.title = s[to] != null ? 'Random range: on (click for a fixed value)' : 'Use a random value from a range';
      tog.setAttribute('aria-pressed', String(s[to] != null));
      tog.dataset.focus = `${i}:${key}~`;
      tog.addEventListener('click', () => {
        if (s[to] != null) { set(i, { [to]: null }); return; }
        const span = { bri: Math.min(100, s.bri + 30), hold: Math.min(600, s.hold * 3), fade: Math.min(60, s.fade + 1) }[key];
        set(i, { [to]: span > s[base] ? span : Math.min(opts.max, s[base] + opts.step) });
      });
      wrap.append(input);
      if (s[to] != null) {
        input.title = 'From';
        const up = n(s[to], opts, (v) => set(i, { [to]: v }), `${key}To`);
        up.title = 'To';
        wrap.classList.add('on');
        wrap.append(mk('small', '', '–'), up);
      }
      wrap.append(tog);
      return wrap;
    };
    const briIn = n(s.bri, { min: 0, max: 100, step: 1 }, (v) => set(i, { bri: v }), 'bri');
    const holdIn = n(s.hold, { min: 0.06, max: 600, step: 0.01 }, (v) => set(i, { hold: v }), 'hold');
    const hold = holdIn;
    // A step needs one write (60 ms) per value it changes; flag holds shorter than that.
    const need = changedValues(d.steps[(i - 1 + d.steps.length) % d.steps.length], s) * 0.06;
    if (d.steps.length > 1 && s.hold < need - 1e-9) {
      hold.classList.add('fxb-warn');
      hold.title = `This step changes ${Math.round(need / 0.06)} values, so it takes at least ${need.toFixed(2)} s to send.`;
    }
    const fadeIn = n(s.fade, { min: 0, max: 60, step: 0.1 }, (v) => set(i, { fade: v }), 'fade');
    const gel = mk('select', 'fxb-gel');
    gel.add(new Option('—', ''));
    for (const g of GELS) gel.add(new Option(g.name, g.id));
    gel.dataset.focus = `${i}:gel`;
    gel.addEventListener('change', () => { const g = GELS.find((x) => x.id === gel.value); if (g) set(i, { ...g.state }); });
    const tools = mk('span', 'fxb-tools');
    tools.append(btn('↑', '', 'Move up', () => move(i, -1)), btn('↓', '', 'Move down', () => move(i, 1)),
      btn('✕', 'danger', 'Remove this step', () => customFx.setSteps(d.id, d.steps.filter((_, k) => k !== i))));
    row.append(mk('span', 'fxb-num', String(i + 1)), sw, mode, val,
      ranged('bri', { min: 0, max: 100, step: 1 }, briIn),
      ranged('hold', { min: 0.06, max: 600, step: 0.01 }, holdIn),
      ranged('fade', { min: 0, max: 60, step: 0.1 }, fadeIn), gel, tools);
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
  const notes = [];
  if (d.steps.some((s) => s.hold < 0.2)) {
    notes.push('Fast steps: a step that changes only brightness can be as short as 0.06 s; each other value it changes adds 0.06 s. Holds shown in orange are shorter than that, so those steps will run a little slower.');
    notes.push('Fast flashing can affect people with photosensitive epilepsy. Theatres usually post a strobe warning.');
  }
  const note = mk('p', 'hint fxb-note', notes.join(' '));
  ed.append(head, info, table, add);
  if (notes.length) ed.append(note);
  if (keep) ed.querySelector(`[data-focus="${keep}"]`)?.focus();
}

// ---------- links: what's new, changelog, issues ----------

/** Compares versions '1.10.0' > '1.9.0'. */
const verCmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const SECTION_LABEL = { Added: 'New', Changed: 'Changed', Fixed: 'Fixed', Removed: 'Removed' };

/** What's new: one block per version, newest first. since = versions newer than this are marked "new to you". */
function openWhatsNew({ since = null } = {}) {
  const list = $('newsList');
  list.innerHTML = '';
  VERSIONS.forEach((v, i) => {
    const d = document.createElement('details');
    d.className = 'news-ver';
    const fresh = since && verCmp(v.version, since) > 0;
    d.open = i === 0 || fresh;
    const sum = document.createElement('summary');
    const vn = document.createElement('b'); vn.textContent = `v${v.version}`;
    const dt = document.createElement('span'); dt.className = 'hint'; dt.textContent = v.date;
    sum.append(vn, ' ', dt);
    if (v.version === APP_VERSION) { const t = document.createElement('span'); t.className = 'news-tag'; t.textContent = 'this version'; sum.append(' ', t); }
    else if (fresh) { const t = document.createElement('span'); t.className = 'news-tag'; t.textContent = 'new to you'; sum.append(' ', t); }
    d.appendChild(sum);
    for (const sec of v.sections) {
      const h = document.createElement('div'); h.className = 'news-sec'; h.textContent = SECTION_LABEL[sec.type] ?? sec.type;
      const ul = document.createElement('ul');
      for (const it of sec.items) {
        const li = document.createElement('li');
        if (it.title) { const b = document.createElement('b'); b.textContent = it.title; li.append(b, ' '); }
        li.append(it.text);
        ul.appendChild(li);
      }
      d.append(h, ul);
    }
    list.appendChild(d);
  });
  $('newsVersion').textContent = `· you have v${APP_VERSION}`;
  document.querySelectorAll('dialog[open]').forEach((dl) => { if (dl.id !== 'newsDlg') closeDialog(dl); });
  openDialog('newsDlg');
}

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
  // "What's new" opens the in-app highlights; the full changelog is linked at the bottom of that dialog.
  $('newsMore').href = `${base}/blob/main/CHANGELOG.md`;
  for (const a of [...document.querySelectorAll('.lnk-changelog'), $('versionBadge')]) {
    a.addEventListener('click', (ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); openWhatsNew(); });
  }
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
    toast({ level: 'ok', title: `Updated to v${APP_VERSION}`, body: `You were on v${last}.`, actions: [{ label: 'What’s new', fn: () => openWhatsNew({ since: last }) }] });
  }
  prefs.set('lastVersion', APP_VERSION);
}

// ---------- color picker for custom effect steps ----------

/**
 * Popover next to a step's color square: a color field (hue across, saturation down) and a white strip
 * (3200–5600 K). Values snap to what the light accepts (hue in 5° steps, CCT in 100 K). Saved on release.
 */
function openStepPicker(anchor, defId, i) {
  closeStepPicker();
  const step = customFx.get(defId)?.steps[i];
  if (!step) return;
  let cur = { ...step };
  const pop = document.createElement('div');
  pop.id = 'stepPicker';
  pop.className = 'step-picker';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Step ${i + 1} color`);
  pop.innerHTML = `
    <div class="sp-head"><span class="sp-prev"></span><span class="sp-val"></span><span class="hint">Step ${i + 1}</span></div>
    <div class="sp-label">Color</div>
    <div class="sp-area sp-hs"><canvas width="256" height="128"></canvas><span class="sp-dot"></span></div>
    <div class="sp-label">White</div>
    <div class="sp-area sp-cct"><canvas width="256" height="20"></canvas><span class="sp-dot"></span></div>`;
  document.body.appendChild(pop);

  const [hsCanvas, cctCanvas] = pop.querySelectorAll('canvas');
  let g = hsCanvas.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const grad = g.createLinearGradient(0, 0, 0, 128);
    const h = (x / 256) * 360;
    grad.addColorStop(0, `hsl(${h} 100% 50%)`);
    grad.addColorStop(1, `hsl(${h} 0% 96%)`);
    g.fillStyle = grad;
    g.fillRect(x, 0, 1, 128);
  }
  g = cctCanvas.getContext('2d');
  const wg = g.createLinearGradient(0, 0, 256, 0);
  const [k0, k1] = uiCaps().cct, kStep = uiCaps().cctStep;
  wg.addColorStop(0, stepColor({ mode: 'cct', cct: k0 }));
  wg.addColorStop(1, stepColor({ mode: 'cct', cct: k1 }));
  g.fillStyle = wg;
  g.fillRect(0, 0, 256, 20);

  const show = () => {
    pop.querySelector('.sp-prev').style.background = stepColor(cur);
    pop.querySelector('.sp-val').textContent = cur.mode === 'cct' ? `White ${cur.cct} K` : `Hue ${cur.hue}° · Sat ${cur.sat}%`;
    const [dHs, dCct] = pop.querySelectorAll('.sp-dot');
    dHs.hidden = cur.mode !== 'hsi';
    dCct.hidden = cur.mode !== 'cct';
    dHs.style.left = `${(cur.hue / 360) * 100}%`;
    dHs.style.top = `${100 - cur.sat}%`;
    dCct.style.left = `${((cur.cct - k0) / (k1 - k0)) * 100}%`;
    dCct.style.top = '50%';
  };
  const commit = () => {
    const d = customFx.get(defId);
    if (!d?.steps[i]) return;
    const steps = d.steps.map((x) => ({ ...x }));
    Object.assign(steps[i], cur.mode === 'cct' ? { mode: 'cct', cct: cur.cct } : { mode: 'hsi', hue: cur.hue, sat: cur.sat });
    customFx.setSteps(defId, steps);
  };
  const drag = (area, fromXY) => {
    const at = (ev) => {
      const r = area.getBoundingClientRect();
      const fx = clamp((ev.clientX - r.left) / r.width, 0, 1), fy = clamp((ev.clientY - r.top) / r.height, 0, 1);
      cur = { ...cur, ...fromXY(fx, fy) };
      show();
    };
    area.addEventListener('pointerdown', (ev) => { area.setPointerCapture(ev.pointerId); at(ev); });
    area.addEventListener('pointermove', (ev) => { if (area.hasPointerCapture(ev.pointerId)) at(ev); });
    area.addEventListener('pointerup', (ev) => { at(ev); commit(); });
  };
  drag(pop.querySelector('.sp-hs'), (fx, fy) => ({ mode: 'hsi', hue: (Math.round((fx * 360) / 5) * 5) % 360, sat: Math.round((1 - fy) * 100) }));
  drag(pop.querySelector('.sp-cct'), (fx) => ({ mode: 'cct', cct: Math.round((k0 + fx * (k1 - k0)) / kStep) * kStep }));
  show();

  // Place it under the square, inside the window.
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = `${clamp(r.left, 8, innerWidth - pw - 8)}px`;
  pop.style.top = `${r.bottom + ph + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;

  const outside = (ev) => { if (!pop.contains(ev.target)) closeStepPicker(); };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); closeStepPicker(); } };
  document.addEventListener('pointerdown', outside, true);   // the opening click's pointerdown has already happened
  window.addEventListener('keydown', esc, true);
  pop._cleanup = () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', esc, true); };
}

function closeStepPicker() {
  const pop = $('stepPicker');
  if (!pop) return;
  pop._cleanup?.();
  pop.remove();
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
    sel.blur();
    if (g) applyGel(g); else renderGel();
  });
  $('gelReset').addEventListener('click', resetGel);
}

/** Gel menu + Reset follow the selected light(s): the gel they all have, else the placeholder. */
function renderGel() {
  const sel = $('gelSel');
  if (!sel.options.length) return;
  const t = targets();
  const ids = [...new Set(t.map((l) => l.gel ?? ''))];
  sel.value = ids.length === 1 ? ids[0] : '';
  sel.options[0].textContent = ids.length > 1 && ids.some(Boolean) ? 'Mixed gels' : 'Gel… (approximate)';
  $('gelReset').disabled = !t.some((l) => l.gel) || !rig.anyConnected;
  // White-only lights: only the white correction gels (CTO / CTB) apply.
  const wo = t.length > 0 && t.every(whiteOnly);
  for (const o of sel.options) { const g = GELS.find((x) => x.id === o.value); if (g) o.disabled = wo && g.state.mode === 'hsi'; }
}

/** A light's color changed some other way: it no longer has its gel. */
function clearGel(lights) {
  for (const l of lights) { l.gel = null; l.preGel = null; }
  renderGel();
}

/** Changes only the color of the selected lights (brightness stays), fading with the Fade time. */
async function applyGel(g, { fadeMs = ui.fadeMs } = {}) {
  const lights = targets();
  if (!lights.length) return;
  // The color before the first gel, so Reset can take it off again (switching gels keeps the original).
  const before = new Map(lights.map((l) => {
    const s = runOf(l)?.snapshot.get(l.id) ?? stateOf(l);
    return [l, l.preGel ?? { mode: s.mode === 'hsi' ? 'hsi' : 'cct', cct: s.cct, hue: s.hue, sat: s.sat }];
  }));
  takeover();
  for (const l of lights) { l.gel = g.id; l.preGel = before.get(l); }
  renderGel();
  rig.logLine(`GEL ${g.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}${rig.lights.length > 1 ? ` → ${lights.map((l) => l.label).join(', ')}` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: { ...stateOf(l), ...g.state } })), fadeMs, { label: `GEL ${g.name}` });
  syncFromLight();
}

/** Reset: takes the gel off the selected lights, back to their color before it (brightness stays). */
async function resetGel({ fadeMs = ui.fadeMs } = {}) {
  const lights = targets().filter((l) => l.gel && l.preGel);
  if (!lights.length) return;
  const back = new Map(lights.map((l) => [l, l.preGel]));
  releaseFromEffect(lights);
  clearFollow();
  clearGel(lights);
  rig.logLine(`GEL off${rig.lights.length > 1 ? ` → ${lights.map((l) => l.label).join(', ')}` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: { ...stateOf(l), ...back.get(l) } })), fadeMs, { label: 'GEL off' });
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
    if (on) await l.conn.sendFrames(E(l).power(false), 'restore after reconnect: off');
  } else {
    if (!on) await l.conn.sendFrames(E(l).power(true), 'restore after reconnect: on');
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
  if (look.state?.mode === 'hsi' && lights.every(whiteOnly)) {
    toast({ level: 'warn', title: `${look.name} is a color look`, body: 'The selected light is white only. Pick a white look, or select a color light.' });
    return;
  }
  releaseFromEffect(lights);
  clearFollow();
  for (const l of lights) { l.look = look.id; l.preset = null; }
  clearGel(lights);
  renderPresets();
  rig.logLine(`LOOK ${look.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}${rig.lights.length > 1 ? ` → ${lights.map((l) => l.label).join(', ')}` : ''}`);
  await crossfade(lights.map((l) => ({ light: l, to: look.state })), fadeMs, { label: `LOOK ${look.name}` });
}

/** + Save look: asks for a name, then saves the selected light's current look. */
function saveCurrentLook() {
  const p = primary();
  if (!p?.conn.connected) return;
  setLookPick(false);
  const state = stateOf(p);
  const input = $('lookNameInput');
  input.value = `Look ${show.looks.length + 1}`;
  $('lookNameDesc').textContent = `${p.label}: ${describeState(state)}`;
  const form = $('lookNameForm');
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    closeDialog($('lookNameDlg'));
    const look = show.addLook(state, name);
    p.look = look.id;
    renderPresets();
    toast({ level: 'ok', title: `Saved “${look.name}”`, body: show.looks.length > LOOK_KEYS.length ? 'Only the first 9 looks show on the Show tab; reorder them on the Looks tab.' : '' });
  };
  openDialog('lookNameDlg');
  input.focus(); input.select();
}

/** Update look: the next look tile tapped (or number pressed) takes the selected light's current look. */
function setLookPick(on) {
  ui.lookPick = !!on;
  $('looks').closest('.looks-card').classList.toggle('picking', ui.lookPick);
  $('lookPickHint').hidden = !ui.lookPick;
  $('updateLookBtn').textContent = ui.lookPick ? 'Cancel' : 'Update look';
}

function updateLookFromLight(look) {
  setLookPick(false);
  const p = primary();
  if (!p?.conn.connected) return;
  show.updateLook(look.id, { state: stateOf(p) });
  p.look = look.id;
  renderPresets();
  toast({ level: 'ok', title: `Updated “${look.name}”`, body: describeState(stateOf(p)) });
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
const allEffects = () => [...BUILTIN, ...EFFECTS, ...customList];
const findEffect = (id) => allEffects().find((x) => x.id === (ALIASES[id] ?? id)) ?? null;

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
fx.selected = ALIASES[prefs.get('fx.selected', '')] ?? prefs.get('fx.selected', BUILTIN[0].id);
if (!findEffect(fx.selected)) fx.selected = BUILTIN[0].id;

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
  // Lights that can't show this effect (too fast for them) are left out.
  const cant = lights.filter((l) => !canRun(l, e));
  if (cant.length) {
    rig.logLine(`EFFECT ${e.name}: ${naWhy(cant, e) === 'color' ? 'color only' : 'too fast'} for ${cant.map((l) => l.label).join(', ')}, skipped`);
    lights = lights.filter((l) => canRun(l, e));
    if (!lights.length) {
      if (!fromCue) toast({ level: 'warn', title: `${e.name} isn’t available on ${[...new Set(cant.map((l) => l.conn.driver.brand))].join(', ')}`, body: naWhy(cant, e) === 'color' ? `${e.name} only shows color, and this light is white only.` : `${e.name} needs faster flashes than this light can show: it fades into each change. Lights with the effect built in, like GVM, still run it.` });
      return;
    }
  }
  if (!lights.length) return;
  if (!fromCue && effectState(e.id, lights) === 'all') { stopEffectOn(lights, { restore: true }); return; }
  // Each light's "before" look: if it was running another effect, the look from before that one.
  const snapshot = new Map(lights.map((l) => [l.id, runOf(l)?.snapshot.get(l.id) ?? stateOf(l)]));
  stopEffectOn(lights, { restore: false, quietLog: true, keepScene: !!e.builtin });
  for (const l of lights) { l.fadeTok = null; l.look = null; l.gel = null; l.preGel = null; l.preset = null; }   // stop fades on these lights only
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
  await each(lights.filter(isDarkLight), (l) => { l.blackoutPre = null; return l.conn.sendFrames(E(l).power(true), 'power on (effect)'); });

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
  // Built-in effects: the light runs it if it has them; other lights (e.g. amaran) get a simulation from the app.
  if (e.builtin) {
    const sim = lights.filter((l) => !capsOf(l).scenes);
    if (sim.length) rig.logLine(`EFFECT ${e.name}: simulated by the app on ${sim.map((l) => l.label).join(', ')}`);
    await each(lights, (l) => (capsOf(l).scenes ? runBuiltin(run, l) : loop(simulatedSteps(e.scene, params, minStepOf(l)), [l])));
  }
  else if (e.perLight) await each(lights, (l) => loop(e.steps(params), [l]));
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
/**
 * A built-in effect on one light: switch it to Scene mode with the effect number, then send the settings
 * (brightness; Strobe II also cycle, hue, saturation) and resend any that change while it runs. The light runs
 * the effect itself. While the light is off, away or fading, nothing is sent; when it is back, everything is
 * sent again (the light may have lost the scene).
 */
async function runBuiltin(run, l) {
  const e = run.e, p = run.params;
  const live = () => !run.dead && run.lights.includes(l) && performance.now() < run.deadline;
  const P = E(l);
  const send = { level: (v) => P.brightness(v), cct: (v) => P.cct(v), cycle: (v) => P.cycle(v), hue: (v) => P.hue(v), sat: (v) => P.saturation(v) };
  let sent = null;
  while (live()) {
    if (!l.conn.connected || isDarkLight(l) || l.busy) { sent = null; await sleep(200); continue; }
    if (!sent) {
      // Already in Scene mode (switching between built-in effects): the official app sends only the number.
      const frames = l.conn.light.mode === 'scene' ? P.scene(e.scene).slice(1) : P.scene(e.scene);
      await l.conn.sendFrames(frames, `scene ${e.scene} ${e.name}`, { quiet: false });
      l.conn.light.mode = 'scene';
      sent = {};
    }
    for (const k of Object.keys(send)) {
      if (p[k] == null || sent[k] === p[k] || !live()) continue;
      sent[k] = p[k];
      await l.conn.sendFrames(send[k](p[k]), `${e.name} ${k} ${p[k]}`, { quiet: true });
    }
    if (l === primary()) syncFromLight();
    await sleep(200);
  }
}

async function stopEffectOn(lights, { restore = false, quietLog = false, keepScene = false } = {}) {
  const back = [];
  for (const run of [...fx.runs]) {
    const gone = run.lights.filter((l) => lights.includes(l));
    if (!gone.length) continue;
    run.lights = run.lights.filter((l) => !gone.includes(l));
    if (!quietLog) {
      rig.logLine(`EFFECT ${run.e.name} stop on ${gone.map((l) => l.label).join(', ')}${restore ? ' (restore previous look)' : ''}${run.lights.length ? `; still running on ${run.lights.map((l) => l.label).join(', ')}` : ''}`);
    }
    if (restore) {
      for (const l of gone) if (run.snapshot.has(l.id)) back.push([l, run.snapshot.get(l.id)]);
    } else if (run.e.builtin && !keepScene) {
      // A built-in effect keeps running on the light until it leaves Scene mode: switch it back to the mode it
      // had before (the light restores its own color for that mode).
      for (const l of gone) back.push([l, { mode: run.snapshot.get(l.id)?.mode ?? 'cct' }]);
    }
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

/** Brightness slider / ↑↓: like takeover, but lights running a built-in effect stay in it (Brightness is its BRG). */
function takeoverForBrightness() {
  const ls = targets();
  releaseFromEffect(ls.filter((l) => !runOf(l)?.e.builtin));
  clearFollow();
  clearLookMark(ls);
}

let fxParamsTimer = null;
function renderFxParamsSoon() { clearTimeout(fxParamsTimer); fxParamsTimer = setTimeout(renderFxParams, 250); }

/** Manual control: takes the selected lights out of their effects (they stay where they are), clears their look highlight. */
function takeover() { releaseFromEffect(targets()); clearFollow(); clearLookMark(targets()); clearGel(targets()); }

function clearLookMark(lights) {
  if (!lights.some((l) => l.look || l.preset)) return;
  for (const l of lights) { l.look = null; l.preset = null; }
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
  b.addEventListener('click', () => (kind !== 'look' ? toggleEffect(item) : ui.lookPick ? updateLookFromLight(item) : applyLook(item)));
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
  const e = findEffect(fx.selected) ?? BUILTIN[0];
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
  const group = (label, list) => { const og = document.createElement('optgroup'); og.label = label; for (const e of list) og.appendChild(new Option(e.name, e.id)); sel.appendChild(og); };
  group('On the light', BUILTIN);
  group('App effects', [...EFFECTS, ...customList]);
  if (!findEffect(fx.selected)) fx.selected = BUILTIN[0].id;
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

/** App effects (Breathe and the ones built on the Effects tab) as a compact row of chips under the built-in tiles. */
// ---------- show board: which effects and looks the Show tab offers, in what order (per show) ----------
//   board = { tiles, chips, looks }, each { order: [ids], hidden: [ids] }. Items not in `order` follow in their
//   usual order and are shown unless hidden, so new looks and effects appear without editing the board.

const BOARD_KEY = 'gvm.board';
const LOOK_SLOTS = LOOK_KEYS.length;
function loadBoard() {
  let b = null;
  try { b = JSON.parse(localStorage.getItem(BOARD_KEY)); } catch {}
  const part = (x) => ({ order: Array.isArray(x?.order) ? x.order : [], hidden: Array.isArray(x?.hidden) ? x.hidden : [] });
  return { tiles: part(b?.tiles), chips: part(b?.chips), looks: part(b?.looks) };
}
let board = loadBoard();
function saveBoard(b) {
  board = b;
  try { localStorage.setItem(BOARD_KEY, JSON.stringify(b)); } catch {}
}
/** All items in board order (hidden ones included). */
function boardOrder(items, cfg) {
  const by = new Map(items.map((x) => [x.id, x]));
  const out = cfg.order.map((id) => by.get(id)).filter(Boolean);
  for (const x of items) if (!cfg.order.includes(x.id)) out.push(x);
  return out;
}
const arrange = (items, cfg) => boardOrder(items, cfg).filter((x) => !cfg.hidden.includes(x.id));
const boardTiles = () => arrange(BUILTIN, board.tiles);
const boardChips = () => arrange([...EFFECTS, ...customList], board.chips);
const boardLooks = () => arrange(show.looks, board.looks).slice(0, LOOK_SLOTS);

function renderCustomChips() {
  const box = $('customFx');
  const list = boardChips();
  const key = list.map((e) => e.id + e.name + e.swatch).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    box.hidden = !list.length;
    const h = document.createElement('span'); h.className = 'hint'; h.textContent = 'App effects';
    h.title = 'Effects the app runs step by step (it keeps sending commands while they run). Build your own on the Effects tab.';
    box.appendChild(h);
    for (const e of list) {
      const b = document.createElement('button');
      b.className = 'chip cfx';
      b.dataset.id = e.id;
      b.title = `${e.desc}\nTap to start / stop on the selected light(s).${e.custom ? ' Edit it on the Effects tab.' : ''}`;
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

/** Effect chips in the cue panel's strip (ours and custom; built-in ones are in the Effects column). */
function fillCueFxStrip(strip, d) {
  strip.innerHTML = '';
  const hint = d.createElement('span'); hint.className = 'hint'; hint.textContent = 'Effects';
  strip.append(hint);
  for (const e of allEffects().filter((x) => !x.builtin)) {
    const b = d.createElement('button');
    b.className = 'chip';
    b.textContent = e.name;
    b.dataset.id = e.id;
    b.title = `Start / stop ${e.name} on the selected light(s). Settings are in the Effects column.`;
    b.addEventListener('click', () => { const x = findEffect(e.id); if (x) toggleEffect(x); });
    strip.append(b);
  }
  // The light's built-in effects, as a menu (the Effects column is hidden while the cue panel is open).
  const bs = d.createElement('select');
  bs.className = 'builtin-select cue-builtin';
  bs.title = 'The light’s own built-in effects (run on the light)';
  bs.add(new (d.defaultView.Option)('On the light…', ''));
  for (const e of BUILTIN) bs.add(new (d.defaultView.Option)(`${e.scene}. ${e.name}`, e.id));
  bs.add(new (d.defaultView.Option)('■ Stop built-in', '__stop'));
  bs.addEventListener('change', () => {
    const v = bs.value;
    bs.value = '';
    if (v === '__stop') { const ls = targets().filter((l) => runOf(l)?.e.builtin); if (ls.length) stopEffectOn(ls, { restore: true }); return; }
    const x = findEffect(v);
    if (x && effectState(x.id) !== 'all') toggleEffect(x);
  });
  strip.append(bs);
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
  boardLooks().forEach((l, i) => looks.appendChild(tile(l, LOOK_KEYS[i], 'look')));
  if (!boardLooks().length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No looks on this show’s board (My show ▾ → Edit show).'; looks.appendChild(p); }
  const tiles = boardTiles();
  const tkey = tiles.map((e) => e.id).join('|');
  if (effects.dataset.key !== tkey) {
    effects.dataset.key = tkey;
    effects.innerHTML = '';
    tiles.forEach((e, i) => effects.appendChild(tile(e, EFFECT_KEYS[i], 'effect')));
  }
  renderCustomChips();
  renderPresetChips();
  renderGel();
  // The board shows the selected light(s): a tile is lit when every selected light has it,
  // half-lit ("partial") when only some do.
  const sel = targets();
  for (const b of looks.children) {
    // Color looks on white-only lights: greyed out (a mixed selection still sets the color lights).
    const lk = boardLooks().find((x) => x.id === b.dataset.id);
    const naL = !!lk && lk.state?.mode === 'hsi' && sel.length > 0 && sel.every(whiteOnly);
    b.classList.toggle('na', naL);
    b.setAttribute('aria-disabled', naL ? 'true' : 'false');
    if (naL) b.dataset.tip = `${lk.name} is a color look: the selected light is white only.`; else delete b.dataset.tip;
    const n = sel.filter((l) => l.look === b.dataset.id).length;
    b.classList.toggle('active', !!sel.length && n === sel.length);
    b.classList.toggle('partial', n > 0 && n < sel.length);
  }
  for (const b of effects.children) {
    const st = effectState(b.dataset.id, sel);
    // Too fast for every selected light: greyed out (a mixed selection runs it on the lights that can).
    const item0 = findEffect(b.dataset.id);
    const na = sel.length > 0 && !sel.some((l) => canRun(l, item0));
    b.classList.toggle('na', na);
    // Disabled buttons don't show tooltips, so these stay clickable (aria-disabled): hover shows why, a tap says why.
    const brands = [...new Set(sel.map((l) => l.conn.driver.brand))].join(', ');
    b.setAttribute('aria-disabled', na ? 'true' : 'false');
    b.title = na ? '' : item0.desc;
    const why = na ? naWhy(sel, item0) : null;
    if (why === 'color') b.dataset.tip = `Not available on ${brands}: ${item0.name} only shows color, and this light is white only.`;
    else if (na) b.dataset.tip = `Not available on ${brands}: ${item0.name} needs faster flashes than this light can show (it fades into each change). Lights with the effect built in, like GVM, still run it.`;
    else delete b.dataset.tip;
    b.classList.toggle('running', st === 'all');
    b.classList.toggle('partial', st === 'some');
    const nm = b.querySelector('.nm');
    const item = findEffect(b.dataset.id);
    nm.innerHTML = '';
    nm.append(item.name);
    if (na) {
      const s = document.createElement('span'); s.className = 'sub na-why';
      s.textContent = why === 'color' ? 'color only' : 'too fast';
      nm.append(s);
    } else if (st !== 'none') {
      const s = document.createElement('span'); s.className = 'sub';
      s.textContent = st === 'all' ? 'running · tap to stop' : `on ${sel.filter((l) => runOf(l)?.e.id === item.id).map((l) => l.label).join(', ')} · tap for all`;
      nm.append(s);
    }
  }
  const on = rig.anyConnected;
  for (const b of document.querySelectorAll('#tab-show .tile')) b.disabled = !on;
  $('saveLookBtn').disabled = !on;
  $('updateLookBtn').disabled = !on || !show.looks.length;
  if (ui.lookPick && $('updateLookBtn').disabled) setLookPick(false);
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
  if (cue.followTimer) { clearTimeout(cue.followTimer); cue.followTimer = null; rig.logLine('auto next cue cancelled'); }
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
  for (const l of rig.lights) { l.look = null; l.preset = null; }
  clearGel(rig.lights);
  renderPresets();
  const q = fmtNum(c.num);
  rig.logLine(`GO cue ${q}${c.name ? ` · ${c.name}` : ''}`);
  if (c.follow != null && c.follow !== '') scheduleFollow(i, +c.follow);
  renderCueBar();
  renderCueList();

  const fadeMs = Math.max(0, (fade ?? c.fade ?? 0) * 1000);
  const entries = Object.entries(c.lights).map(([id, st]) => [rig.get(id), st]).filter(([l]) => l?.conn.connected);
  const missing = Object.keys(c.lights).filter((id) => !rig.get(id)?.conn.connected);
  if (missing.length) rig.logLine(`cue ${q}: ${missing.length} light(s) not connected, skipped`);

  await each(entries.filter(([l, st]) => st.power !== false && isDarkLight(l)), async ([l]) => {
    l.blackoutPre = null;
    if (fadeMs > 0) await l.conn.sendFrames(E(l).brightness(0), 'cue prep', { quiet: true });
    await l.conn.sendFrames(E(l).power(true), `cue ${q} power on`);
    if (fadeMs > 0) l.conn.light.brightness = 0;
  });
  const jobs = entries.filter(([l, st]) => !(st.power === false && isDarkLight(l)))
    .map(([l, st]) => ({ light: l, to: st.power === false ? { bri: 0 } : st }));
  const ok = await crossfade(jobs, fadeMs, { label: `CUE ${q}` });
  if (!ok || token !== cue.token) return;
  await each(entries.filter(([l, st]) => st.power === false && !isDarkLight(l)), ([l, st]) => {
    l.blackoutPre = st.bri || null;
    return l.conn.sendFrames(E(l).power(false), `cue ${q} power off`);
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

const cueTitle = (i) => (i >= 0 && show.cues[i] ? `${fmtNum(show.cues[i].num)}${show.cues[i].name ? ` · ${show.cues[i].name}` : ''}` : '—');
const cueNote = (i) => (i >= 0 && show.cues[i]?.notes?.trim()) || '';

function renderCueBar() {
  const n = show.cues.length;
  const atEnd = cue.index >= n - 1;
  $('cueNow').textContent = n ? (cue.index >= 0 ? cueTitle(cue.index) : 'Ready — press GO for cue 1') : 'No cues yet';
  $('cueNext').textContent = n ? (cue.index + 1 < n ? cueTitle(cue.index + 1) : 'End of list') : 'Record cues on the Cues tab';
  // Notes: the next cue's (its standby / GO point) is the one the operator needs.
  for (const [el, txt] of [[$('cueNowNote'), cueNote(cue.index)], [$('cueNextNote'), cueNote(cue.index + 1)]]) { el.textContent = txt; el.hidden = !txt; el.title = txt; }
  $('cueGo').disabled = !n || !rig.anyConnected || (atEnd && cue.index >= 0);
  $('cueBack').disabled = cue.index <= 0 || !rig.anyConnected;
  updateCueProgress();
}

function updateCueProgress() {
  let pct = 0, text = '';
  if (cue.followTimer) {
    const left = Math.max(0, cue.followAt - performance.now());
    pct = 100 * (1 - left / cue.followTotal);
    text = `next cue in ${(left / 1000).toFixed(1)} s`;
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
  const rec = btn('● Record', 'primary', 'Save every connected light’s current look as a new cue after the selected one (between 2 and 3 it becomes 2.5)', recordCue);
  const upd = btn('Update', '', 'Replace the selected cue with the lights’ current looks', updateSelectedCue);
  const up = btn('↑', '', 'Move the selected cue up', () => cue.selected && show.moveCue(cue.selected, -1));
  const down = btn('↓', '', 'Move the selected cue down', () => cue.selected && show.moveCue(cue.selected, 1));
  const del = btn('Delete', 'danger', 'Delete the selected cue', () => {});
  confirmButton(del, 'Sure?', deleteSelectedCue);
  const renum = btn('Renumber', '', 'Number the cues 1, 2, 3… in list order', () => {});
  confirmButton(renum, 'Renumber all?', () => { show.renumberCues(); renderCueBar(); });
  const top = btn('Top', '', 'Next GO runs the first cue', () => { clearFollow(); cue.index = -1; renderCueBar(); renderCueList(); });

  const strip = mk('div', 'cue-fx-strip');
  fillCueFxStrip(strip, d);
  const hint = mk('p', 'hint cue-hint', 'Set the lights (sliders, looks, an effect), then Record. A cue saves every connected light, a fade, an optional effect with a run time, and optionally when to go to the next cue on its own. Select a cue and Record to add one after it (2.5 between 2 and 3); type in a cue’s number box to renumber it.');
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
  rig.logLine(`RECORD cue ${fmtNum(c.num)}`);
  renderCueList();
  toast({ level: 'ok', title: `Recorded cue ${fmtNum(c.num)}`, body: `${Object.keys(c.lights).length} light(s)${effs.length ? ` + ${cueEffectsLabel(effs)}` : ''}` });
}

function updateSelectedCue() {
  const c = show.cues.find((x) => x.id === cue.selected);
  if (!c || !rig.anyConnected) return;
  show.updateCue(c.id, { lights: { ...c.lights, ...snapshotRig() } });
  toast({ level: 'ok', title: `Updated cue ${fmtNum(c.num)}`, body: 'Saved the current look of the connected lights.' });
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

let liveCueId = null;   // the live cue while its number is being edited (the list may re-sort)

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

    const num = d.createElement('input');
    num.type = 'text'; num.inputMode = 'decimal'; num.className = 'cue-num'; num.value = fmtNum(c.num);
    num.title = 'Cue number. Type e.g. 2.5 to move it between 2 and 3.'; num.dataset.focus = `${c.id}:num`;
    num.addEventListener('change', () => {
      if (!show.setCueNum(c.id, num.value)) { toast({ level: 'warn', title: `Can’t use ${num.value || 'that'} as a cue number`, body: 'Use a positive number that no other cue has.' }); num.value = fmtNum(c.num); return; }
      cue.index = cue.index >= 0 ? show.cues.findIndex((x) => x.id === liveCueId) : -1;
      renderCueList(); renderCueBar();
    });
    num.addEventListener('focus', () => { liveCueId = show.cues[cue.index]?.id ?? null; });
    const name = d.createElement('input');
    name.type = 'text'; name.value = c.name; name.placeholder = `Cue ${fmtNum(c.num)}`; name.className = 'cue-name';
    name.dataset.focus = `${c.id}:name`;
    name.addEventListener('change', () => { show.updateCue(c.id, { name: name.value.trim() }); renderCueBar(); });
    const fade = numInput(d, c.fade, { min: 0, max: 60, step: 0.5 }, (v) => show.updateCue(c.id, { fade: v ?? 0 }));
    fade.title = 'Fade time (s)';
    const follow = numInput(d, c.follow, { min: 0, max: 600, step: 0.5, placeholder: 'GO' }, (v) => show.updateCue(c.id, { follow: v }));
    follow.title = 'Go to the next cue on its own this many seconds after this cue starts. Blank (GO) = wait for you to press GO.';

    const effSel = d.createElement('select');
    effSel.className = 'cue-fx';
    effSel.add(new (d.defaultView.Option)('No effect', ''));
    for (const e of allEffects()) effSel.add(new (d.defaultView.Option)(e.custom ? `${e.name} (custom)` : e.builtin ? e.name : `${e.name} (app)`, e.id));
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
    line2.append(cell('Fade s', fade), cell('Next cue in s', follow), cell('Effect', effSel, 'grow'), cell('Run s', dur));
    const notes = d.createElement('input');
    notes.type = 'text'; notes.className = 'cue-notes'; notes.value = c.notes ?? ''; notes.maxLength = 200;
    notes.placeholder = 'Notes: e.g. GO on “goodnight” (shown big when this cue is next)';
    notes.dataset.focus = `${c.id}:notes`;
    notes.addEventListener('change', () => { show.updateCue(c.id, { notes: notes.value.trim() }); renderCueBar(); });
    row.append(line1, line2, notes);
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
  const cb = h.strip.querySelector('.cue-builtin');
  if (cb) cb.disabled = !rig.anyConnected;
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

/** Cues saved with an app effect that was replaced by a built-in one (e.g. Cops → Cop Car) are moved over. */
function migrateCueEffects() {
  const fix = (ce) => (ce && ALIASES[ce.id] ? { ...ce, id: ALIASES[ce.id] } : ce);
  for (const c of show.cues) {
    const effs = c.effects?.map(fix), eff = fix(c.effect);
    if (eff !== c.effect || (effs && effs.some((x, i) => x !== c.effects[i]))) {
      show.updateCue(c.id, { effect: eff ?? null, ...(effs ? { effects: effs } : {}) });
      rig.logLine(`cue “${c.name || c.id}”: effect moved to the light’s built-in ${findEffect((eff ?? effs[0]).id)?.name}`);
    }
  }
}

function initCues() {
  migrateCueEffects();
  $('cueGo').addEventListener('click', goNext);
  $('cueBack').addEventListener('click', goBack);
  $('cueListBtn').addEventListener('click', () => setCuePanel(!cuePanel.open));
  cuePanel.hosts.panel = buildCueEditor($('cuePanel'), document);
  show.addEventListener('change', (e) => {
    if (e.detail.what === 'cues') { renderCueList(); renderCueBar(); }
    else { renderPresets(); renderLookList(); renderPresetList(); }
  });
  setCuePanel(prefs.get('cuePanel', false));
  renderCueBar();
}

// ---------- presets: a look (and effect) per light, by light name ----------

const nameKey = (s) => String(s ?? '').trim().toLowerCase();
const lightsNamed = (name) => rig.lights.filter((l) => nameKey(l.label) === nameKey(name));

/** What a light is doing now, as a preset entry. */
function presetEntry(l) {
  const run = runOf(l);
  return {
    name: l.label,
    // Running an effect: the look under it (what the light returns to), plus the effect.
    state: { ...(run?.snapshot.get(l.id) ?? stateOf(l)), power: l.conn.light.power !== false },
    effect: run ? { id: run.e.id, params: { ...run.params } } : null,
  };
}

const presetColor = (en) => (en.state.power === false ? '#111' : stateColor(en.state, { full: true }));

/** Applies a preset: each entry goes to every connected light with that name; others are left alone. */
async function applyPreset(p, { fadeMs = ui.fadeMs } = {}) {
  const pairs = p.lights.flatMap((en) => lightsNamed(en.name).filter((l) => l.conn.connected).map((l) => [l, en]));
  const missing = p.lights.filter((en) => !lightsNamed(en.name).some((l) => l.conn.connected)).map((en) => en.name);
  if (!pairs.length) { toast({ level: 'warn', title: `“${p.name}”: no matching lights`, body: `It sets ${p.lights.map((en) => en.name).join(', ')}. Rename your lights to match (double-click a light chip).` }); return; }
  const lights = pairs.map(([l]) => l);
  releaseFromEffect(lights);
  clearFollow();
  clearGel(lights);
  for (const l of lights) { l.look = null; l.preset = p.id; }
  renderPresets();
  rig.logLine(`PRESET ${p.name}${fadeMs ? ` (fade ${fadeMs / 1000}s)` : ''}: ${pairs.map(([l, en]) => `${l.label} → ${en.effect ? fxName(en.effect.id) : describeState(en.state)}`).join(' · ')}${missing.length ? ` · not connected: ${missing.join(', ')}` : ''}`);
  if (missing.length) toast({ level: 'info', title: `“${p.name}”: ${missing.join(', ')} not connected`, body: 'The other lights were set.' });
  // Lights the preset turns on: power on first (from dark, so a fade rises from zero).
  await each(pairs.filter(([l, en]) => en.state.power !== false && isDarkLight(l)), async ([l]) => {
    l.blackoutPre = null;
    if (fadeMs > 0) await l.conn.sendFrames(E(l).brightness(0), 'preset prep', { quiet: true });
    await l.conn.sendFrames(E(l).power(true), `preset ${p.name}: power on`);
    if (fadeMs > 0) l.conn.light.brightness = 0;
  });
  const jobs = pairs.filter(([l, en]) => !(en.state.power === false && isDarkLight(l)))
    .map(([l, en]) => ({ light: l, to: en.state.power === false ? { bri: 0 } : en.state }));
  const ok = await crossfade(jobs, fadeMs, { label: `PRESET ${p.name}` });
  if (!ok) return;
  await each(pairs.filter(([l, en]) => en.state.power === false && !isDarkLight(l)), ([l, en]) => {
    l.blackoutPre = en.state.bri || null;
    return l.conn.sendFrames(E(l).power(false), `preset ${p.name}: power off`);
  });
  // Effects: lights with the same effect and settings run it together (in sync).
  const groups = new Map();
  for (const [l, en] of pairs) {
    if (!en.effect || en.state.power === false || l.preset !== p.id) continue;
    const k = en.effect.id + JSON.stringify(en.effect.params ?? {});
    if (!groups.has(k)) groups.set(k, { en, ls: [] });
    groups.get(k).ls.push(l);
  }
  for (const { en, ls } of groups.values()) {
    const e = findEffect(en.effect.id);
    if (!e) { rig.logLine(`preset ${p.name}: effect ${en.effect.id} no longer exists`); continue; }
    toggleEffect(e, { params: { ...defaults(e), ...en.effect.params }, lights: ls, fromCue: true });
    for (const l of ls) l.preset = p.id;      // starting the effect cleared the mark
  }
  renderPresets();
}

function savePresetDialog() {
  const lights = rig.connected;
  if (!lights.length) return;
  const entries = lights.map(presetEntry);
  $('presetNameInput').value = `Preset ${show.presets.length + 1}`;
  const ul = $('presetNameLights');
  ul.innerHTML = '';
  for (const en of entries) {
    const li = document.createElement('li');
    li.textContent = `${en.name}: ${en.state.power === false ? 'off' : describeState(en.state)}${en.effect ? ` + ${fxName(en.effect.id)}` : ''}`;
    ul.appendChild(li);
  }
  $('presetNameForm').onsubmit = (e) => {
    e.preventDefault();
    const name = $('presetNameInput').value.trim();
    if (!name) return;
    closeDialog($('presetNameDlg'));
    const p = show.addPreset(name, entries);
    for (const l of lights) l.preset = p.id;
    renderPresets();
    toast({ level: 'ok', title: `Saved preset “${p.name}”`, body: `${entries.length} light(s) by name. Edit it on the Looks tab.` });
  };
  openDialog('presetNameDlg');
  $('presetNameInput').focus(); $('presetNameInput').select();
}

/** Show tab: one chip per preset (first nine get Shift+1–9). */
function renderPresetChips() {
  const box = $('presetChips');
  if (!box) return;
  box.innerHTML = '';
  if (!show.presets.length) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = 'Name your lights, set them, then save a preset.'; box.appendChild(h); }
  show.presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'preset-chip';
    const matched = p.lights.flatMap((en) => lightsNamed(en.name));
    b.classList.toggle('active', matched.length > 0 && matched.every((l) => l.preset === p.id));
    const dots = document.createElement('span'); dots.className = 'preset-dots';
    for (const en of p.lights.slice(0, 6)) { const d = document.createElement('span'); d.style.background = presetColor(en); dots.appendChild(d); }
    const nm = document.createElement('span'); nm.textContent = p.name;
    b.append(dots, nm);
    if (i < 9) { const k = document.createElement('span'); k.className = 'pk'; k.textContent = `⇧${i + 1}`; b.appendChild(k); }
    b.title = p.lights.map((en) => `${en.name}: ${en.state.power === false ? 'off' : describeState(en.state)}${en.effect ? ` + ${fxName(en.effect.id)}` : ''}${lightsNamed(en.name).length ? '' : ' (no light with this name)'}`).join('\n');
    b.disabled = !rig.anyConnected;
    b.addEventListener('click', () => applyPreset(p));
    box.appendChild(b);
  });
  $('savePresetBtn').disabled = !rig.anyConnected;
}

/** Looks tab: the preset library (rename, apply, update, remove a light, add a light, reorder, delete). */
function renderPresetList() {
  const list = $('presetList');
  if (!list) return;
  list.innerHTML = '';
  if (!show.presets.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No presets yet. Name your lights (e.g. MAIN, LEFT, BAR), set each one, then + Save current.'; list.appendChild(p); }
  const mk = (txt, title, fn, dis = false, cls = '') => { const b = document.createElement('button'); b.className = 'btn sm ' + cls; b.textContent = txt; b.title = title; b.disabled = dis; b.addEventListener('click', fn); return b; };
  show.presets.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'preset-row';
    const head = document.createElement('div'); head.className = 'head';
    const key = document.createElement('span'); key.className = 'look-key'; key.textContent = i < 9 ? `⇧${i + 1}` : '';
    const name = document.createElement('input'); name.type = 'text'; name.value = p.name; name.className = 'cue-name'; name.maxLength = 40;
    name.addEventListener('change', () => show.updatePreset(p.id, { name: name.value }));
    const del = mk('Delete', 'Delete this preset', () => {}, false, 'danger');
    confirmButton(del, 'Sure?', () => show.removePreset(p.id));
    head.append(key, name,
      mk('Apply', 'Set the lights now (Fade time)', () => applyPreset(p), !rig.anyConnected),
      mk('Update', 'Replace every entry with what its light is doing now (lights not connected keep their entry)', () => {
        const upd = p.lights.map((en) => { const l = lightsNamed(en.name).find((x) => x.conn.connected); return l ? { ...presetEntry(l), name: en.name } : en; });
        show.updatePreset(p.id, { lights: upd });
        toast({ level: 'ok', title: `Updated “${p.name}”` });
      }, !rig.anyConnected),
      mk('↑', 'Move up', () => show.movePreset(p.id, -1), i === 0),
      mk('↓', 'Move down', () => show.movePreset(p.id, 1), i === show.presets.length - 1),
      del);
    const ents = document.createElement('div'); ents.className = 'preset-entries';
    p.lights.forEach((en, j) => {
      const c = document.createElement('span'); c.className = 'preset-entry';
      const sw = document.createElement('span'); sw.className = 'lsw'; sw.style.background = presetColor(en);
      const t = document.createElement('span');
      t.textContent = `${en.name}: ${en.state.power === false ? 'off' : describeState(en.state)}${en.effect ? ` + ${fxName(en.effect.id)}` : ''}`;
      if (!lightsNamed(en.name).length) { t.classList.add('missing'); t.title = 'No light with this name right now'; }
      const x = mk('×', `Remove ${en.name} from this preset`, () => show.updatePreset(p.id, { lights: p.lights.filter((_, k) => k !== j) }));
      c.append(sw, t, x);
      ents.appendChild(c);
    });
    // Add a light that isn't in the preset yet (its current look).
    const absent = rig.connected.filter((l) => !p.lights.some((en) => nameKey(en.name) === nameKey(l.label)));
    if (absent.length) {
      const sel = document.createElement('select'); sel.className = 'gel-select';
      sel.add(new Option('+ Add light…', ''));
      for (const l of absent) sel.add(new Option(l.label, l.id));
      sel.addEventListener('change', () => { const l = rig.get(sel.value); if (l) show.updatePreset(p.id, { lights: [...p.lights, presetEntry(l)] }); });
      ents.appendChild(sel);
    }
    row.append(head, ents);
    list.appendChild(row);
  });
  $('presetSave').disabled = !rig.anyConnected;
}

// ----- Looks tab: looks library -----

function renderLookList() {
  const list = $('lookList');
  list.innerHTML = '';
  show.looks.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'look-row';
    const sw = document.createElement('span'); sw.className = 'lsw big'; sw.style.background = stateColor(l.state, { full: true });
    const key = document.createElement('span'); key.className = 'look-key'; key.textContent = LOOK_KEYS[boardLooks().indexOf(l)] ?? '';
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
  $('savePresetBtn').addEventListener('click', savePresetDialog);
  $('presetSave').addEventListener('click', savePresetDialog);
  renderPresetList();
  $('updateLookBtn').addEventListener('click', () => setLookPick(!ui.lookPick));
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
  takeoverForBrightness();
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
  if (k === 'escape' && ui.lookPick) { e.preventDefault(); setLookPick(false); return; }
  if (k === 'escape') { e.preventDefault(); clearFollow(); cancelFade(); stopAllEffects(true); return; }
  if (k === 'l') { e.preventDefault(); setLocked(!ui.locked); return; }
  if (k === 'c') { e.preventDefault(); if (isPopped()) cuePanel.win.focus(); else { if ($('tab-show').hidden) showTab('show'); setCuePanel(!cuePanel.open); } return; }
  if ($('tab-show').hidden || ui.locked) return;
  if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const p = show.presets[+e.code.slice(5) - 1]; if (p) { e.preventDefault(); applyPreset(p); } return; }
  if (LOOK_KEYS.includes(k)) { const look = boardLooks()[LOOK_KEYS.indexOf(k)]; if (look) { e.preventDefault(); if (ui.lookPick) updateLookFromLight(look); else applyLook(look); } }
  else if (EFFECT_KEYS.includes(k)) { e.preventDefault(); const e2 = boardTiles()[EFFECT_KEYS.indexOf(k)]; if (e2) toggleEffect(e2); }
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
  if (!ui.reloading && rig.anyConnected && prefs.get('confirmClose', true)) { e.preventDefault(); e.returnValue = ''; }
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

const STATUS_NAMES = ['power', 'p1 ?', 'brightness', 'CCT ×100', 'hue ÷5', 'saturation', 'mode (3 = Scene)', 'scene #', 'cycle ×0.1 s'];

/** Debug tab: every light's latest raw status values, recently changed ones highlighted. */
function renderStatusWatch() {
  const box = $('statusWatch');
  if (!box || $('tab-debug').hidden) return;
  const ls = rig.lights.filter((l) => l.conn.statusRaw);
  if (!ls.length) { box.textContent = rig.anyConnected ? 'waiting for the first status…' : '(not connected)'; return; }
  const hx = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  const now = Date.now();
  let html = '<table><tr><th></th>' + ls.map((l) => `<th>${l.label.replace(/[<&]/g, '')}</th>`).join('') + '</tr>';
  for (let p = 0; p < Math.max(...ls.map((l) => l.conn.statusRaw.length)); p++) {
    html += `<tr class="${p === 1 ? 'unk' : ''}"><td>p${p} ${STATUS_NAMES[p] ?? '?'}</td>`;
    for (const l of ls) {
      const v = l.conn.statusRaw[p], hot = now - (l.conn.statusChangedAt[p] || 0) < 15000;
      html += `<td class="${hot ? 'hot' : ''}">${v == null ? '—' : `0x${hx(v)} <small>(${v})</small>`}</td>`;
    }
    html += '</tr>';
  }
  html += '<tr><td>handshake reply</td>' + ls.map((l) => `<td>${l.conn.handshakeReply ? l.conn.handshakeReply.map(hx).join(' ') : '—'}</td>`).join('') + '</tr></table>';
  box.innerHTML = html;
}
setInterval(renderStatusWatch, 1000);

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
  renderSettingsGroups();
  $('setSpeedTest').hidden = !rig.lights.some((l) => !capsOf(l).scenes);
  const box = $('setLights');
  box.innerHTML = '';
  if (!rig.lights.length) {
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No light paired yet.';
    box.appendChild(p);
  }
  for (const l of lightsByBrand()) {
    const row = document.createElement('div');
    row.className = 'light-row';
    row.dataset.id = l.id;
    const dot = document.createElement('span'); dot.className = 'dot ' + l.conn.status;
    const name = document.createElement('input');
    name.type = 'text'; name.maxLength = 24; name.value = l.label; name.placeholder = l.name; name.className = 'light-name';
    name.setAttribute('aria-label', 'Light name');
    name.addEventListener('change', () => { rig.rename(l.id, name.value); renderConn(); });
    const d = l.conn.driver, ds = statusFor(d, l.model);
    const st = document.createElement('span'); st.className = 'hint';
    st.textContent = `${d.brand}${ds === 'verified' ? '' : ` (${ds})`} · ${STATUS_TEXT[l.conn.status]}`;
    st.title = `${d.brand}: ${d.models}. ${ds === 'verified' ? 'Checked on real hardware.' : 'Not yet checked on real hardware: some controls may not work.'}`;
    let model = null;
    if (d.variants) {
      // Lights that differ by model: the user says which one this is (it sets the white range and color).
      model = document.createElement('select'); model.className = 'light-model';
      model.setAttribute('aria-label', `${d.brand} model`);
      for (const [id, v] of Object.entries(d.variants)) { const o = document.createElement('option'); o.value = id; o.textContent = v.label; model.appendChild(o); }
      model.value = l.model ?? '';
      model.addEventListener('change', () => rig.setModel(l.id, model.value));
    }
    const rc = document.createElement('button'); rc.className = 'btn sm'; rc.textContent = 'Reconnect';
    rc.disabled = !env.supported || l.conn.connected;
    rc.addEventListener('click', () => rig.reconnect(l));
    const fg = document.createElement('button'); fg.className = 'btn sm danger'; fg.textContent = 'Forget';
    confirmButton(fg, 'Click again', () => forgetLight(l));
    let rep = null;
    if (ds === 'untested') { rep = document.createElement('a'); rep.className = 'hint'; rep.href = reportUrl(d, l); rep.target = '_blank'; rep.rel = 'noopener'; rep.textContent = 'Report result'; rep.title = 'Tell us whether this light works (opens a pre-filled GitHub issue)'; }
    row.append(dot, name, st, rc, fg);
    if (model || rep) { const ex = document.createElement('div'); ex.className = 'light-extra'; if (model) ex.append(model); if (rep) ex.append(rep); row.append(ex); }
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
  // Visit counter opt-out: GoatCounter's script skips counting when localStorage skipgc is 't' (next load).
  try { $('setCount').checked = localStorage.getItem('skipgc') !== 't'; } catch {}
  $('setCount').addEventListener('change', () => {
    try { if ($('setCount').checked) localStorage.removeItem('skipgc'); else localStorage.setItem('skipgc', 't'); } catch {}
    toast({ level: 'ok', title: $('setCount').checked ? 'Visits will be counted' : 'Visits won’t be counted', body: 'Takes effect the next time the app opens.' });
  });
  initLinks();
  $('envInfo').textContent = `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]}${env.supported ? '' : ' (no Web Bluetooth)'}`;
  $('settingsBtn').addEventListener('click', () => openDialog('settingsDlg'));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeDialog(b.closest('dialog')));

  $('setAddLight').addEventListener('click', () => rig.pair());
  $('setAddGroup').addEventListener('click', () => openGroupDialog(null));
  $('setSpeedTest').addEventListener('click', () => {
    $('speedNow').textContent = ''; $('speedPick').innerHTML = ''; openDialog('speedDlg'); });
  $('speedRun').addEventListener('click', runSpeedTest);
  $('speedDlg').addEventListener('close', () => { ui.speedTest = false; });
  $('copyBtn').addEventListener('click', openCopyMenu);
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
  initBackup();
  initSetup();
}

// ---------- supported lights ----------

const STATUS_LABEL = { verified: 'Verified', reported: 'Reported working', untested: 'Untested' };

/** A pre-filled GitHub issue for reporting how an untested light behaved. */
function reportUrl(d, l = null) {
  const body = `**Brand:** ${d.brand}\n**Model:** ${l ? (d.variants?.[l.model]?.label ?? l.name) : ''}\n**Name in the Bluetooth list:** ${l?.name ?? ''}\n**App version:** ${APP_VERSION}\n\n**Result:** works / partly / doesn't work\n\n- [ ] Connects\n- [ ] On / off\n- [ ] Brightness\n- [ ] White\n- [ ] Color\n\n**What happened:**\n\n(Optional: paste the Debug tab log lines for this light. They show the bytes the app sent.)`;
  return `https://github.com/kyles0623/gvm-show-control/issues/new?title=${encodeURIComponent(`Light report: ${d.brand}${l ? ` ${d.variants?.[l.model]?.label ?? ''}` : ''}`)}&labels=light-report&body=${encodeURIComponent(body)}`;
}
const STATUS_TIP = { verified: 'Checked on real hardware', reported: 'A user reports it works', untested: 'Not yet checked on a real light: some controls may not work' };

function renderSupportedLights() {
  const box = $('lightsList');
  box.innerHTML = '';
  for (const d of Object.values(DRIVERS)) {
    for (const p of d.products ?? []) {
      const card = document.createElement('div'); card.className = 'light-card';
      let img;
      if (p.image) {
        img = document.createElement('img');
        img.className = 'ph'; img.alt = `${p.model} (photo from ${new URL(p.url).hostname})`; img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer'; img.src = p.image;
        img.addEventListener('error', () => { const f = document.createElement('div'); f.className = 'ph'; f.textContent = 'Photo unavailable offline'; img.replaceWith(f); });
      } else { img = document.createElement('div'); img.className = 'ph'; img.textContent = d.brand; }
      const body = document.createElement('div');
      const h = document.createElement('h4'); h.textContent = p.model;
      const ps = p.status ?? d.status;   // a product can have its own status (amaran: Ace 25c reported, Halo untested)
      const b = document.createElement('span'); b.className = `badge ${ps}`; b.textContent = STATUS_LABEL[ps] ?? ps; b.title = STATUS_TIP[ps] ?? '';
      h.appendChild(b);
      const dl = document.createElement('dl');
      for (const [k, v] of [['Works', p.works], ['In the device list', p.listName], ['Before pairing', p.setup], ...((p.source ?? d.source) ? [['Built from', p.source ?? d.source]] : [])]) {
        const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
      }
      const pa = document.createElement('p'); pa.className = 'hint';
      if (p.url) { const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `${ps === 'untested' && !p.image ? 'Source' : 'Product page'} (${new URL(p.url).hostname}) →`; pa.appendChild(a); }
      if (ps === 'untested') {
        const r = document.createElement('a'); r.href = reportUrl(d); r.target = '_blank'; r.rel = 'noopener'; r.textContent = 'Tried it? Report the result →';
        if (p.url) pa.append(' · ');
        pa.appendChild(r);
      }
      body.append(h, dl, pa);
      card.append(img, body);
      box.appendChild(card);
    }
  }
}

// ----- why a tile is unavailable: a tooltip that shows at once (outside the scrolling tile grid, so it isn't clipped) -----

function showTileTip(b) {
  if (!b.dataset.tip) return;
  let t = $('tileTip');
  if (!t) { t = document.createElement('div'); t.id = 'tileTip'; t.setAttribute('role', 'tooltip'); document.body.appendChild(t); }
  t.textContent = b.dataset.tip;
  t.hidden = false;
  const r = b.getBoundingClientRect();
  const top = r.top - t.offsetHeight - 6 > 4 ? r.top - t.offsetHeight - 6 : r.bottom + 6;
  t.style.top = `${top}px`;
  t.style.left = `${clamp(r.left + r.width / 2 - t.offsetWidth / 2, 8, innerWidth - t.offsetWidth - 8)}px`;
}
function hideTileTip() { const t = $('tileTip'); if (t) t.hidden = true; }
for (const ev of ['mouseover', 'focusin']) document.addEventListener(ev, (e) => { const b = e.target.closest?.('.tile.na'); if (b) showTileTip(b); });
for (const ev of ['mouseout', 'focusout']) document.addEventListener(ev, (e) => { if (e.target.closest?.('.tile.na')) hideTileTip(); });

// ----- speed test: how fast a light without built-in effects can flash cleanly -----

async function runSpeedTest() {
  const l = targets().find((x) => !capsOf(x).scenes) ?? rig.connected.find((x) => !capsOf(x).scenes);
  if (!l) { $('speedNow').textContent = 'Connect a light without built-in effects (e.g. amaran) first.'; return; }
  const box = $('speedPick');
  box.innerHTML = '';
  $('speedRun').disabled = true;
  releaseFromEffect([l]);
  const before = stateOf(l), on = { ...before, bri: Math.max(40, before.bri) };
  rig.logLine(`SPEED TEST on ${l.label}`);
  ui.speedTest = true;
  for (const ms of SPEED_TEST_MS) {
    if (!ui.speedTest) break;
    $('speedNow').textContent = `${l.label}: ${ms} ms on / ${ms} ms off`;
    for (let i = 0; i < 6 && ui.speedTest; i++) {
      await applyStateTo(l, on); await sleep(ms);
      await applyStateTo(l, { ...on, bri: 0 }); await sleep(ms);
    }
    await applyStateTo(l, on); await sleep(1200);
  }
  await applyStateTo(l, before);
  ui.speedTest = false;
  $('speedRun').disabled = false;
  $('speedNow').textContent = 'Which was the fastest that still looked like a clean on / off?';
  const cur = minStepOf(l);
  for (const ms of SPEED_TEST_MS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (ms === cur ? ' primary' : ''); b.textContent = `${ms} ms`;
    b.addEventListener('click', () => {
      prefs.set(`minStep.${l.conn.driver.id}`, ms);
      rig.logLine(`SPEED TEST: ${l.conn.driver.brand} effects step no faster than ${ms} ms`);
      toast({ level: 'ok', title: `Effects on ${l.conn.driver.brand} lights: ${ms} ms steps`, body: 'Restart a running effect to use the new speed.' });
      closeDialog($('speedDlg'));
    });
    box.appendChild(b);
  }
}

function openSupportedLights() {
  renderSupportedLights();
  openDialog('lightsDlg');
}
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('.open-lights');
  if (!t) return;
  e.preventDefault();
  openSupportedLights();
});

// ---------- mesh lights: asked before the app joins one to its own network ----------

rig.onSetupNeeded = (conn) => new Promise((resolve) => {
  $('meshSetupName').textContent = conn.device?.name || 'This light';
  for (const e of document.querySelectorAll('.meshBrand')) e.textContent = conn.driver?.brand ?? 'amaran';
  $('meshSetupReset').textContent = conn.driver?.resetHint ?? 'On the light, open the Bluetooth menu and hold “Press to Reset”';
  const f = $('meshSetupForm');
  const done = (ok) => { f.onsubmit = null; $('meshSetupDlg').onclose = null; closeDialog($('meshSetupDlg')); resolve(ok); };
  f.onsubmit = (e) => { e.preventDefault(); done(true); };
  $('meshSetupDlg').onclose = () => resolve(false);
  openDialog('meshSetupDlg');
});

// ---------- untested lights: said once per brand, before the first one is added ----------

rig.onUntested = (d) => new Promise((resolve) => {
  if (prefs.get(`untestedOk.${d.id}`, false)) { resolve(true); return; }
  $('untestedBrand').textContent = d.brand;
  for (const e of document.querySelectorAll('.untestedBrand')) e.textContent = d.brand;
  $('untestedSource').textContent = d.source ?? 'public documentation';
  $('untestedReport').href = reportUrl(d);
  const f = $('untestedForm');
  const done = (ok) => { f.onsubmit = null; $('untestedDlg').onclose = null; closeDialog($('untestedDlg')); if (ok) prefs.set(`untestedOk.${d.id}`, true); resolve(ok); };
  f.onsubmit = (e) => { e.preventDefault(); done(true); };
  $('untestedDlg').onclose = () => resolve(false);
  openDialog('untestedDlg');
});

// ---------- grand master ----------

/** Scales every light's brightness (in the Bluetooth layer, so looks, cues and effects keep their levels). */
function setMaster(pct, { save = true } = {}) {
  pct = clamp(Math.round(pct), 0, 100);
  ui.master = pct;
  $('master').value = pct;
  $('masterVal').textContent = pct;
  $('master').closest('.master-card').classList.toggle('trim', pct < 100);
  // While dragging, send at most every 80 ms per light (always ending on the latest value).
  if (!ui.masterTimer) {
    const wait = Math.max(0, (ui.masterSentAt ?? 0) + 80 - performance.now());
    ui.masterTimer = setTimeout(() => {
      ui.masterTimer = null; ui.masterSentAt = performance.now();
      for (const l of rig.lights) l.conn.setMaster(ui.master / 100);
    }, wait);
  }
  if (save) prefs.set('master', pct);
}

function initMaster() {
  const pct = prefs.get('master', 100);
  for (const l of rig.lights) l.conn.master = pct / 100;
  setMaster(pct, { save: false });
  $('master').addEventListener('input', () => setMaster(+$('master').value));
  $('master').addEventListener('change', () => { setMaster(+$('master').value); rig.logLine(`GRAND MASTER ${ui.master}%`); });
  $('master').addEventListener('dblclick', () => setMaster(100));
  // Lights paired later start at the same master.
  rig.addEventListener('lights', () => { for (const l of rig.lights) if (l.conn.master !== ui.master / 100) l.conn.master = ui.master / 100; });
}

// ---------- shows (productions) ----------

function renderShows() {
  $('showName').textContent = shows.current.name;
  const list = $('showsList');
  list.innerHTML = '';
  for (const x of shows.list) {
    const open = x.id === shows.current.id;
    const n = shows.counts(x.id);
    const row = document.createElement('div'); row.className = 'show-row' + (open ? ' open' : '');
    const name = document.createElement('input'); name.type = 'text'; name.value = x.name; name.maxLength = 40;
    name.addEventListener('change', () => { shows.rename(x.id, name.value); renderShows(); });
    const info = document.createElement('span'); info.className = 'hint';
    info.textContent = `${n.looks ?? 'default'} looks · ${n.cues} cues · ${n.effects} effects`;
    const b = (txt, title, fn, cls = '') => { const e = document.createElement('button'); e.className = 'btn sm ' + cls; e.textContent = txt; e.title = title; e.addEventListener('click', fn); return e; };
    const openBtn = b(open ? 'Open now' : 'Open', 'Switch to this show (reloads the app)', () => openShow(x.id));
    openBtn.disabled = open;
    const dup = b('Duplicate', 'Make a copy of this show', () => { shows.create(`${x.name} copy`, { from: x.id }); renderShows(); });
    const del = b('Delete', open ? 'Open another show first' : 'Delete this show', () => {}, 'danger');
    del.disabled = open;
    if (!open) confirmButton(del, 'Sure?', () => { shows.remove(x.id); renderShows(); toast({ level: 'ok', title: `Deleted show “${x.name}”` }); });
    if (open) { const ed = b('Edit', 'Name, and which effects and looks the Show tab offers, in what order', openEditShow, 'primary'); row.append(name, info, ed, dup, del); }
    else row.append(name, info, openBtn, dup, del);
    list.appendChild(row);
  }
}

// ----- Edit show: board editor -----

const BOARD_PARTS = {
  tiles: { items: () => BUILTIN, swatch: (e) => e.swatch, keys: EFFECT_KEYS },
  chips: { items: () => [...EFFECTS, ...customList], swatch: (e) => e.swatch, keys: [] },
  looks: { items: () => show.looks, swatch: (l) => stateColor(l.state, { full: true }), keys: LOOK_KEYS, max: LOOK_SLOTS },
};
let boardDraft = null;

function openEditShow() {
  boardDraft = {};
  for (const [part, d] of Object.entries(BOARD_PARTS)) {
    const all = boardOrder(d.items(), board[part]);
    boardDraft[part] = { order: all.map((x) => x.id), hidden: board[part].hidden.filter((id) => all.some((x) => x.id === id)) };
  }
  $('editShowName').value = shows.current.name;
  for (const part of Object.keys(BOARD_PARTS)) {
    const box = document.querySelector(`.board-btns[data-part="${part}"]`);
    box.innerHTML = '';
    const ids = () => boardDraft[part].order;
    const mk = (txt, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = txt; b.title = title; b.addEventListener('click', () => { fn(); renderBoardPart(part); }); box.appendChild(b); };
    mk('All', 'Show every one', () => { boardDraft[part].hidden = []; });
    mk('None', 'Hide every one', () => { boardDraft[part].hidden = [...ids()]; });
    mk('Default', 'Every one, in the usual order', () => { boardDraft[part] = { order: BOARD_PARTS[part].items().map((x) => x.id), hidden: [] }; });
    renderBoardPart(part);
  }
  $('editShowForm').onsubmit = (e) => {
    e.preventDefault();
    // Store only what differs from the usual order, so new items keep their place.
    const b = {};
    for (const part of Object.keys(BOARD_PARTS)) {
      const usual = BOARD_PARTS[part].items().map((x) => x.id);
      const same = boardDraft[part].order.join('|') === usual.join('|');
      b[part] = { order: same ? [] : boardDraft[part].order, hidden: boardDraft[part].hidden };
    }
    saveBoard(b);
    shows.rename(shows.current.id, $('editShowName').value);
    closeDialog($('editShowDlg'));
    renderPresets(); renderShows();
    toast({ level: 'ok', title: `Saved “${shows.current.name}”` });
  };
  openDialog('editShowDlg');
}

function renderBoardPart(part) {
  const d = BOARD_PARTS[part], draft = boardDraft[part];
  const by = new Map(d.items().map((x) => [x.id, x]));
  const list = document.querySelector(`.board-list[data-part="${part}"]`);
  list.innerHTML = '';
  let shown = 0;
  draft.order.forEach((id, i) => {
    const x = by.get(id);
    if (!x) return;
    const on = !draft.hidden.includes(id);
    const pos = on ? shown++ : -1;
    const over = on && d.max != null && pos >= d.max;
    const row = document.createElement('div'); row.className = 'board-row' + (on && !over ? '' : ' off');
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on;
    c.addEventListener('change', () => { draft.hidden = c.checked ? draft.hidden.filter((h) => h !== id) : [...draft.hidden, id]; renderBoardPart(part); });
    const sw = document.createElement('span'); sw.className = 'lsw'; sw.style.background = d.swatch(x);
    const nm = document.createElement('span'); nm.textContent = x.name;
    if (over) nm.title = `Only the first ${d.max} fit on the board`;
    const key = document.createElement('span'); key.className = 'bkey'; key.textContent = on ? (d.keys[pos]?.toUpperCase() ?? (over ? 'off' : '')) : '';
    const mv = (txt, delta) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = txt;
      const j = i + delta; b.disabled = j < 0 || j >= draft.order.length;
      b.addEventListener('click', () => { [draft.order[i], draft.order[j]] = [draft.order[j], draft.order[i]]; renderBoardPart(part); });
      return b;
    };
    row.append(c, sw, nm, key, mv('↑', -1), mv('↓', 1));
    list.appendChild(row);
  });
}

function openShow(id) {
  const name = shows.list.find((x) => x.id === id)?.name;
  if (!shows.open(id)) return;
  prefs.set('openedShow', name);
  ui.reloading = true;
  rig.disconnectAll();
  location.reload();
}

function initShows() {
  renderShows();
  $('showsBtn').addEventListener('click', () => { renderShows(); openDialog('showsDlg'); });
  $('showNew').addEventListener('click', () => {
    const id = shows.create(`Show ${shows.list.length + 1}`);
    renderShows();
    $('showsList').querySelector(`.show-row:nth-child(${shows.list.findIndex((x) => x.id === id) + 1}) input`)?.select();
  });
  const opened = prefs.get('openedShow', null);
  if (opened) {
    try { localStorage.removeItem('gvm.ui.openedShow'); } catch {}
    setTimeout(() => toast({ level: 'ok', title: `Opened “${opened}”` }), 300);
  }
}

// ---------- backup: export / import ----------

function exportBackup() {
  const b = buildBackup(localStorage, APP_VERSION, shows.current.name);
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = backupFileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  const n = summarize(b);
  toast({ level: 'ok', title: 'Backup exported', body: `${a.download}: ${n.looks} looks, ${n.cues} cues, ${n.customEffects} effects, ${n.prefs} settings.` });
}

async function openImport(file) {
  let text;
  try { text = await file.text(); } catch { toast({ level: 'error', title: 'Couldn’t read that file' }); return; }
  const { backup: b, error } = parseBackup(text);
  if (error) { toast({ level: 'error', title: 'Can’t import', body: error }); return; }
  const n = summarize(b);
  const when = b.exported ? new Date(b.exported).toLocaleString() : 'unknown date';
  $('importFrom').textContent = `${file.name}${b.show ? ` (show “${b.show}”)` : ''} · exported ${when}${b.version ? ` from v${b.version}` : ''} · goes into the open show “${shows.current.name}”`;
  const parts = $('importParts');
  parts.innerHTML = '';
  const row = (id, label, count, on = count > 0) => {
    const l = document.createElement('label'); l.className = 'switch';
    l.innerHTML = `<input type="checkbox" data-part="${id}"> <span></span>`;
    l.querySelector('span').textContent = label;
    const c = l.querySelector('input'); c.checked = on; c.disabled = !count;
    parts.appendChild(l);
  };
  row('looks', `Looks (${n.looks})`, n.looks);
  row('cues', `Cues (${n.cues})`, n.cues);
  row('presets', `Presets (${n.presets})`, n.presets);
  row('customEffects', `Effects built on the Effects tab (${n.customEffects})`, n.customEffects);
  row('prefs', `Effect settings and preferences (${n.prefs})`, n.prefs);
  row('board', 'Show-tab layout (which effects and looks, in what order)', n.board);
  row('mesh', `Mesh network keys for amaran lights (${n.mesh}) — replaces this browser’s`, n.mesh, false);
  row('groups', `Light groups (${n.groups})`, n.groups && rig.lights.length);
  row('lightNames', `Light names (${n.lights})`, n.lights && rig.lights.length, false);
  // Light map: only needed when the backup's lights aren't the ones here.
  const map = defaultLightMap(b.lights, rig.lights);
  const box = $('importMap');
  box.innerHTML = '';
  for (const bl of b.lights) {
    const name = document.createElement('span'); name.textContent = bl.label || bl.name || 'Light';
    const sel = document.createElement('select'); sel.className = 'gel-select'; sel.dataset.from = bl.id;
    sel.append(new Option('— skip —', ''));
    for (const l of rig.lights) sel.append(new Option(l.label, l.id));
    sel.value = map[bl.id];
    box.append(name, sel);
  }
  const sameLights = b.lights.every((bl) => rig.lights.some((l) => l.id === bl.id));
  $('importMapSec').hidden = !b.lights.length || sameLights;
  $('importForm').onsubmit = (e) => {
    e.preventDefault();
    const chosen = {};
    for (const c of parts.querySelectorAll('input[data-part]')) chosen[c.dataset.part] = c.checked && !c.disabled;
    if (!Object.values(chosen).some(Boolean)) { toast({ level: 'warn', title: 'Nothing selected to import' }); return; }
    const m = {};
    for (const sel of box.querySelectorAll('select')) m[sel.dataset.from] = sel.value;
    const mode = $('importForm').querySelector('input[name=importMode]:checked').value;
    let done;
    try { done = applyBackup(localStorage, b, { parts: chosen, mode, map: m }); }
    catch (err) { toast({ level: 'error', title: 'Import failed', body: String(err.message || err) }); return; }
    prefs.set('imported', { at: Date.now(), done });
    closeDialog($('importDlg'));
    ui.reloading = true;
    rig.disconnectAll?.();
    location.reload();
  };
  openDialog('importDlg');
}

function initBackup() {
  $('setExport').addEventListener('click', exportBackup);
  $('setImport').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
  $('importFile').addEventListener('change', () => { const f = $('importFile').files[0]; if (f) openImport(f); });
  // After the reload: say what came in.
  const imp = prefs.get('imported', null);
  if (imp) {
    try { localStorage.removeItem('gvm.ui.imported'); } catch {}
    const names = { looks: 'looks', cues: 'cues', customEffects: 'effects', prefs: 'settings', lightNames: 'light names', groups: 'groups', board: 'board layout', mesh: 'mesh lights', presets: 'presets' };
    const body = Object.entries(imp.done ?? {}).map(([k, v]) => `${v} ${names[k] ?? k}`).join(', ');
    setTimeout(() => toast({ level: 'ok', title: 'Backup imported', body }), 300);
  }
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
  closeStepPicker();
  if (name === 'debug' && !prefs.get('showDebug', false)) name = 'show';
  if (!['show', 'looks', 'effects', 'debug'].includes(name)) name = 'show';
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('tab-show').hidden = name !== 'show';
  $('tab-looks').hidden = name !== 'looks';
  $('tab-effects').hidden = name !== 'effects';
  $('tab-debug').hidden = name !== 'debug';
  prefs.set('tab', name);
  if (name === 'debug') { renderLog(); renderGatt(); renderWriteTargets(); renderStatusWatch(); }
  if (name === 'looks') renderLookList();
  if (name === 'effects') renderEffectEditor();
}

function init() {
  for (const sel of ['#powerBtn', '#fadeCtl', '#bri', '#modeSeg', '#cctPanel', '#hsiPanel', '.gel-row']) {
    document.querySelector(sel).classList.add('lockable');
  }

  rig.addEventListener('status', renderConn);
  rig.addEventListener('lights', () => { renderConn(); syncFromLight(); renderPresets(); renderFxParams(); renderCueList(); renderPresetList(); });
  rig.addEventListener('status', () => { if (!$('tab-looks').hidden) renderPresetList(); });
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
    each(targets(), (l) => { l.blackoutPre = null; return l.conn.sendFrames(E(l).power(turnOn), turnOn ? 'power on' : 'power off'); });
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
  $('handshakeBtn').addEventListener('click', () => { const p = primary(); if (p?.conn.driver.enc.handshake) p.conn.sendFrames(p.conn.driver.enc.handshake(), 'handshake'); });
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
  initMaster();
  initShows();
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
