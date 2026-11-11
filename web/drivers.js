// Light drivers: one per kind of light. A driver says how to find the light in the browser's device list,
// what it can do (caps), how to connect (create → a connection with the LightConnection interface), and how to
// encode commands (enc: power, brightness, cct, hue, saturation, mode; optional scene, cycle, handshake).
//
// The app talks to a light only through its connection and its driver's encoder, so adding a brand means adding
// a driver here. status: 'verified' (checked on real hardware), 'reported' (a user says it works), 'untested'.
//
// Drivers whose lights differ by model have `variants` (id → {label, caps, …}) and `guessModel(name)`: each light
// stores its model (Settings → Lights lets the user change it) and gets that model's caps (capsFor).
// Untested drivers name their source next to every byte (lightproto.js) and never offer raw writes.
import { LightConnection, SERVICE } from './ble.js';
import { GVMProtocol } from './gvm-protocol.js';
import { AmaranConnection, AMARAN_ENC, MESH_UUIDS } from './amaran.js';
import { GattLightConnection, STATE_ENC } from './gatt-light.js';
import { GodoxConnection } from './godox.js';
import { GODOX_MODELS } from './godox-models.js';
import * as P from './lightproto.js';

const DEVICE_INFO = '0000180a-0000-1000-8000-00805f9b34fb';

export const DRIVERS = {
  gvm: {
    id: 'gvm',
    brand: 'GVM',
    models: '800-RGB and other lights that show up as BT_LED',
    status: 'verified',
    // Shown in Supported lights (images load from the maker's site; credit and link below each).
    products: [{
      model: 'GVM 800D-RGB (800D-II)',
      url: 'https://shop.gvmled.com/products/gvm-800d-rgb-led-studio-video-light',
      image: 'https://shop.gvmled.com/cdn/shop/products/gvm-800d-40w-powerful-bi-color-and-rgb-video-panel-light-kit-908428.jpg?v=1773209171&width=600',
      listName: 'BT_LED',
      works: 'On/off, brightness, white 3200–5600 K, color, the light’s 20 built-in effects',
      setup: 'Set the light to App mode (small mode button until the display shows APP). Close the GVM phone app.',
    }],
    caps: {
      cct: [3200, 5600], cctStep: 100,   // K
      hsi: true, hueStep: 5,             // hue sent in 5° steps
      scenes: true,                      // the light's 20 built-in effects (Scene mode)
      gm: false,                         // green/magenta tint
      oneConnection: true,               // the light accepts one Bluetooth connection at a time
    },
    filters: [{ namePrefix: 'BT_LED' }, { services: [SERVICE] }],
    optionalServices: [DEVICE_INFO, SERVICE],
    match: (device) => device.name?.startsWith('BT_LED'),
    services: [SERVICE],                 // a light offering one of these is this driver's (detectDriver)
    create: (opts) => new LightConnection(opts),
    enc: GVMProtocol,
  },
  amaran: {
    id: 'amaran',
    brand: 'amaran',
    models: 'Ace 25c; Halo 60x/100x/200x/300x/600x untested (Bluetooth Mesh lights set up by this app)',
    status: 'reported',          // works on two Ace 25c lights (user report, 2026-11-02); the shared mesh connection isn't confirmed yet
    products: [{
      model: 'amaran Ace 25c',
      url: 'https://amarancreators.com/pages/amaran-ace-25c',
      image: 'https://cdn.sanity.io/images/7n7ckclh/production/73e66b2ec6ee19e1e477e431463f657d1e9a2442-960x960.png?w=600',
      listName: 'no name (Chrome may show “Unknown or Unsupported Device”)',
      works: 'On/off, brightness, white 2300–10,000 K, color; 9 slower effects simulated by the app (fast ones like Strobe and Cop Car aren’t offered: the light glides into each change)',
      setup: 'Close the amaran app. The first time, the app asks to set the light up in its own network (undo: hold Press to Reset in the light’s Bluetooth menu).',
    }, {
      model: 'amaran Halo 300x (also Halo 60x, 100x, 200x, 600x)',
      status: 'untested',
      source: 'wesbos/amaran-BLE-control (MIT): the same 0x26 commands as the Ace 25c',
      url: 'https://amarancreators.com/pages/amaran-halo-300x',
      listName: 'not confirmed (may show no name, like the Ace 25c)',
      works: 'On/off, brightness, white 2700–6500 K. Bi-color: no color. Pick the model in Settings → Lights after pairing.',
      setup: 'Close the amaran app and reset the light’s Bluetooth. Untested: not tried on a real Halo yet.',
    }],
    // Ace 25c: 2300-10,000 K and full color (amarancreators.com product page). Commands carry kelvin/10 and hue in 1°.
    // minStepMs: the light glides into each change by itself (seen on the Ace 25c), so simulated effects step no faster
    // than this. 500 ms looked cleanest on the Ace 25c (speed test, 2026-11-02); the speed test can change it.
    caps: { cct: [2300, 10000], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: false, minStepMs: 500 },
    // Models. Halo: Sidus Mesh (the amaran app pairs "all Sidus Mesh enabled lights", help.amarancreators.com FAQ), so the
    // same mesh setup and 0x26 commands (telink.js; wesbos/amaran-BLE-control's example config controls a "Halo 100x").
    // No new bytes. Ranges: 2700-6500 K, bi-color (amarancreators.com Halo comparison table). status: per model.
    variants: {
      ace25c: { label: 'Ace 25c (2300–10,000 K, color)', status: 'reported' },
      ...Object.fromEntries(['60', '100', '200', '300', '600'].map((w) => [`halo${w}x`, {
        label: `Halo ${w}x (2700–6500 K, white only)`, status: 'untested',
        source: 'wesbos/amaran-BLE-control (MIT)', caps: { cct: [2700, 6500], hsi: false },
      }])),
    },
    // The Ace 25c advertises no name; Halo names are unconfirmed. Default: Ace 25c (keeps lights saved before models).
    guessModel: (name = '') => { const m = /halo\s*(60|100|200|300|600)\s*x/i.exec(name); return m ? `halo${m[1]}x` : 'ace25c'; },
    filters: [{ services: [MESH_UUIDS.PROV_SERVICE] }, { services: [MESH_UUIDS.PROXY_SERVICE] }, { namePrefix: 'amaran' }],
    optionalServices: [DEVICE_INFO, MESH_UUIDS.PROV_SERVICE, MESH_UUIDS.PROXY_SERVICE],
    match: (device) => /^(amaran|aputure|slck)/i.test(device.name ?? ''),
    services: [MESH_UUIDS.PROV_SERVICE, MESH_UUIDS.PROXY_SERVICE],
    create: (opts) => new AmaranConnection(opts),
    enc: AMARAN_ENC,
    mesh: true,
  },
  neewer: {
    id: 'neewer',
    brand: 'Neewer',
    models: 'RGB660 PRO, RGB176 A1, RGB1, RGB168, TL60 RGB, CB60B, CB120B and other Neewer lights (older protocol)',
    status: 'untested',
    source: 'keefo/NeewerLite (MIT)',
    products: [{
      model: 'Neewer RGB and bi-color lights (older Bluetooth protocol)',
      url: 'https://github.com/keefo/NeewerLite',
      listName: 'NEEWER-…, NW-… or NWR-…',
      works: 'On/off, brightness, white, color on RGB models. Pick your model in Settings → Lights. Not supported: SL90, HS60C, HS60C Pro, BH20C, BH-30S RGB (they need the light’s hardware address, which browsers don’t give).',
      setup: 'Close the NEEWER app. Untested: built from NeewerLite’s documentation, not tried on a real light yet.',
    }],
    caps: { cct: [3200, 5600], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: true },
    // Model → command family and range, from NeewerLite Database/lights.json (type in brackets).
    variants: {
      'other-db': { label: 'Other Neewer RGB light (database commands)', family: 'db' },
      'other-classic': { label: 'Older Neewer RGB light (classic commands)', family: 'classic' },
      'other-classic-bi': { label: 'Older Neewer bi-color light (classic commands)', family: 'classicBi', caps: { hsi: false } },
      'RGB660 PRO': { label: 'RGB660 PRO [3]', family: 'db' },
      'RGB176 A1': { label: 'RGB176 A1 [5]', family: 'db' },
      'RGB1': { label: 'RGB1 [8]', family: 'db' },
      'RGB168': { label: 'RGB168 [16]', family: 'db', caps: { cct: [2500, 8500] } },
      'TL60 RGB': { label: 'TL60 RGB [59]', family: 'db' },
      'GR18C': { label: 'GR18C [62]', family: 'db' },
      'GL1C': { label: 'GL1C [39]', family: 'db', caps: { cct: [2900, 7000] } },
      'RGB62': { label: 'RGB62 [40]', family: 'db', caps: { cct: [2500, 8500] } },
      'CB100C': { label: 'CB100C [49]', family: 'db', gmNeutral: 0x00, caps: { cct: [2700, 6500] } },
      'CB60B': { label: 'CB60B [31]', family: 'db', caps: { hsi: false } },
      'CB120B': { label: 'CB120B [70]', family: 'db', caps: { hsi: false, cct: [2700, 6500] } },
      'TL40': { label: 'TL40 [67]', family: 'db', caps: { hsi: false, cct: [2900, 7000] } },
    },
    guessModel: (name = '') => {
      const n = name.toUpperCase().replace(/[\s_-]/g, '');
      const hit = Object.keys(DRIVERS.neewer.variants).filter((k) => !k.startsWith('other')).sort((a, b) => b.length - a.length)
        .find((k) => n.includes(k.replace(/[\s_-]/g, '')));
      return hit ?? 'other-db';                  // NeewerLite's default light type (8) uses the database commands
    },
    filters: [{ namePrefix: 'NEEWER' }, { namePrefix: 'NW-' }, { namePrefix: 'NWR' }, { services: [P.NEEWER.SERVICE] }],
    optionalServices: [P.NEEWER.SERVICE],
    match: (device) => /^(neewer|nw-|nwr)/i.test(device.name ?? '') && !/^nh-/i.test(device.name ?? ''),
    services: [P.NEEWER.SERVICE],
    create: (opts) => new GattLightConnection({ ...opts, proto: {
      service: P.NEEWER.SERVICE, write: P.NEEWER.CONTROL, notify: P.NEEWER.NOTIFY, gapMs: 15,   // NeewerLite: 15 ms between writes
      frames: (st, c) => { const m = c.modelInfo ?? {}; return P.neewerFrames(st, { family: m.family ?? 'db', gmNeutral: m.gmNeutral ?? 0x32, hsi: c.caps?.hsi !== false, cct: c.caps?.cct }); },
      key: (f) => `${f[1]}`,
    } }),
    enc: STATE_ENC,
  },
  godox: {
    id: 'godox',
    brand: 'Godox',
    models: '184 Bluetooth Mesh models (SL, ML, LA, UL, LC, P…): pick yours in Settings → Lights',
    status: 'untested',
    source: 'binary-person/ha-godox-mesh (MIT)',
    resetHint: 'Factory-reset the light (usually: hold its Bluetooth button until it flashes)',
    products: [{
      model: 'Godox Bluetooth Mesh lights (SL60IIBi, SL200IIIBi, ML60IIBi, LC500R…)',
      url: 'https://github.com/binary-person/ha-godox-mesh/blob/main/docs/consolidated/models/models.md',
      listName: 'GD_LED',
      works: 'On/off (as 0 % brightness), brightness, white over the model’s range, color on RGB models. Shares the one mesh connection with amaran lights.',
      setup: 'Close the Godox Light app and factory-reset the light (it can only be in one app’s network). Untested: built from ha-godox-mesh’s documentation.',
    }],
    caps: { cct: [2800, 6500], cctStep: 100, hsi: false, hueStep: 1, scenes: false, gm: false, oneConnection: false, minStepMs: 200 },
    variants: Object.fromEntries(GODOX_MODELS.map(([m, lo, hi, hsi, ok]) => [m, { label: `${m} (${lo === hi ? `${lo} K` : `${lo}–${hi} K`}${hsi ? ', color' : ''}${ok ? ', confirmed by ha-godox-mesh' : ''})`, caps: { cct: [lo, hi], hsi: !!hsi } }])),
    guessModel: () => 'SL60IIBi',              // the light doesn't say its model over Web Bluetooth: the user picks it
    filters: [{ namePrefix: 'GD_LED' }],
    optionalServices: [DEVICE_INFO, MESH_UUIDS.PROV_SERVICE, MESH_UUIDS.PROXY_SERVICE],
    match: (device) => /^GD_LED/i.test(device.name ?? ''),
    services: [],                               // same mesh services as amaran: told apart by the name GD_LED
    mesh: true,
    create: (opts) => new GodoxConnection(opts),
    enc: STATE_ENC,
  },
  rgbstrip: {
    id: 'rgbstrip',
    brand: 'RGB strip',
    models: 'ELK-BLEDOM and LEDBLE Bluetooth LED strip controllers and bulbs',
    status: 'untested',
    source: 'arduino12/ble_rgb_led_strip_controller, 8none1/ledble-ledlamp (facts only)',
    products: [{
      model: 'ELK-BLEDOM / LEDBLE strip controllers (“Lotus Lantern”, “LED Lamp”, “duoCo Strip” apps)',
      listName: 'ELK-BLEDOM… or LEDBLE-…',
      works: 'On/off, brightness, color. White is approximate (mixed from red, green and blue). For practicals and color washes, not stage lighting.',
      setup: 'Close the strip’s phone app. Untested: built from public notes on these controllers.',
    }],
    caps: { cct: [2700, 6500], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: true, approxWhite: true, minStepMs: 150 },
    variants: {
      elk: { label: 'ELK-BLEDOM (service FFF0)' },
      ledble: { label: 'LEDBLE (service FFE0)' },
    },
    guessModel: (name = '') => (/^LEDBLE/i.test(name) ? 'ledble' : 'elk'),
    filters: [{ namePrefix: 'ELK-' }, { namePrefix: 'LEDBLE' }],
    optionalServices: [P.ELK.SERVICE, P.LEDBLE.SERVICE],
    match: (device) => /^(ELK-|LEDBLE)/i.test(device.name ?? ''),
    services: [],
    create: (opts) => new GattLightConnection({ ...opts, proto: opts.model === 'ledble'
      ? { service: P.LEDBLE.SERVICE, write: P.LEDBLE.WRITE, frames: (st) => P.ledbleFrames(st), key: (f) => `${f[2]}` }
      : { service: P.ELK.SERVICE, frames: (st) => P.elkFrames(st), key: (f) => `${f[2]}` } }),
    enc: STATE_ENC,
  },
  govee: {
    id: 'govee',
    brand: 'Govee',
    models: 'Older Govee Bluetooth bulbs and strips (H6001, H6127…)',
    status: 'untested',
    source: 'chvolkmann/govee_btled, BeauJBurroughs/Govee-H6127-Reverse-Engineering (facts only)',
    products: [{
      model: 'Govee H6001 bulb, H6127 strip and similar Bluetooth-only Govee lights',
      listName: 'ihoment_H…, Govee_H… or Minger_H…',
      works: 'On/off, brightness, color. White is approximate (mixed from red, green and blue). Newer Wi-Fi Govee lights aren’t supported.',
      setup: 'Close the Govee Home app. Untested: built from public notes on these lights.',
    }],
    caps: { cct: [2700, 6500], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: true, approxWhite: true, minStepMs: 150 },
    filters: [{ namePrefix: 'ihoment_' }, { namePrefix: 'Govee_' }, { namePrefix: 'Minger_' }],
    optionalServices: [P.GOVEE.SERVICE],
    match: (device) => /^(ihoment_|govee_|minger_)/i.test(device.name ?? ''),
    services: [],                               // shares GVM's service UUID: never detected by service
    create: (opts) => new GattLightConnection({ ...opts, proto: {
      service: P.GOVEE.SERVICE, write: P.GOVEE.CONTROL, frames: (st) => P.goveeFrames(st), key: (f) => `${f[1]}`,
      keepAlive: { ms: 2000, frame: P.goveeKeepAlive },
    } }),
    enc: STATE_ENC,
  },
  nanlite: {
    id: 'nanlite',
    brand: 'Nanlite',
    models: 'Nanlite lights with Bluetooth (PavoTube II C and others using the NANLINK app’s Bluetooth protocol)',
    status: 'untested',
    source: 'vmedea’s “Nanlite app protocol” notes (CC-BY-4.0)',
    products: [{
      model: 'Nanlite PavoTube II C and other NANLINK Bluetooth lights',
      listName: 'varies (the app finds it by its Bluetooth service)',
      works: 'Brightness (off is 0 %), white 2700–7500 K, color. The source calls the Bluetooth link slow and unreliable, so simulated effects are limited to slow ones.',
      setup: 'Close the NANLINK app. Untested: built from one person’s published notes.',
    }],
    caps: { cct: [2700, 7500], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: true, minStepMs: 1000 },
    filters: [{ services: [P.NANLITE.SERVICE] }],
    optionalServices: [P.NANLITE.SERVICE],
    match: () => false,
    services: [P.NANLITE.SERVICE],
    create: (opts) => new GattLightConnection({ ...opts, proto: {
      service: P.NANLITE.SERVICE, write: P.NANLITE.WRITE, notify: P.NANLITE.NOTIFY, chunk: 20, gapMs: 60,
      frames: (st, c) => P.nanliteFrames(st, (c.seq = (c.seq + 1) & 0xff)),
    } }),
    enc: STATE_ENC,
  },
  yongnuo: {
    id: 'yongnuo',
    brand: 'Yongnuo',
    models: 'YN-360 light wand',
    status: 'untested',
    source: 'kenkeiter/lantern (MIT)',
    products: [{
      model: 'Yongnuo YN-360',
      url: 'http://www.hkyongnuo.com/e-detaily.php?ID=375',
      listName: 'YONGNUO…',
      works: 'Off, brightness, white 3200–5500 K, color.',
      setup: 'Untested: built from the lantern library (2017).',
    }],
    caps: { cct: [3200, 5500], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: true },
    filters: [{ namePrefix: 'YONGNUO' }],
    optionalServices: [P.YONGNUO.SERVICE],
    match: (device) => /^YONGNUO/i.test(device.name ?? ''),
    services: [],
    create: (opts) => new GattLightConnection({ ...opts, proto: { service: P.YONGNUO.SERVICE, write: P.YONGNUO.CONTROL, frames: (st) => P.yongnuoFrames(st), key: () => 'state' } }),
    enc: STATE_ENC,
  },
};

export const DEFAULT_DRIVER = 'gvm';

/** A model's details (null for drivers without models). */
export function modelInfo(d, model) {
  if (!d.variants) return null;
  return d.variants[model] ?? d.variants[d.guessModel?.('')] ?? null;
}

/** Caps of a light: its driver's, narrowed by its model's. */
export function capsFor(d, model) {
  const m = modelInfo(d, model);
  return m?.caps ? { ...d.caps, ...m.caps } : d.caps;
}

/** verified / reported / untested for a light: its model's status, else its driver's. */
export function statusFor(d, model) {
  return modelInfo(d, model)?.status ?? d.status;
}

export const driverOf = (id) => DRIVERS[id] ?? DRIVERS[DEFAULT_DRIVER];

/** The driver for a device picked in the chooser (first match; GVM if none). */
export function driverFor(device) {
  return Object.values(DRIVERS).find((d) => d.match(device)) ?? DRIVERS[DEFAULT_DRIVER];
}

/**
 * Works out a chosen device's driver: by name when it has a known one, else by connecting and looking at which
 * services it offers (an unnamed device is common: the Ace 25c advertises no name). Read-only.
 */
export async function detectDriver(device, log = () => {}) {
  const byName = Object.values(DRIVERS).find((d) => d.match(device));
  if (byName) return byName;
  try {
    const server = await device.gatt.connect();
    for (const d of Object.values(DRIVERS)) {
      for (const u of d.services) {
        if (await server.getPrimaryService(u).then(() => true, () => false)) { log(`${device.name ?? '(unnamed)'}: ${d.brand} (offers ${u.slice(4, 8)})`); return d; }
      }
    }
  } catch (e) { log(`detect: ${e.name}: ${e.message}`); }
  return DRIVERS[DEFAULT_DRIVER];
}

/** Chooser options covering every driver. */
export function chooserOptions(extraServices = []) {
  const all = Object.values(DRIVERS);
  return {
    filters: all.flatMap((d) => d.filters),
    optionalServices: [...new Set([...all.flatMap((d) => d.optionalServices), ...extraServices])],
  };
}

/** Caps covering a set of lights (for controls shared by all of them): widest CCT range, any scenes / color. */
export function unionCaps(drivers) {
  // Accepts drivers or caps objects.
  const list = (drivers.length ? drivers : [DRIVERS[DEFAULT_DRIVER]]).map((d) => d.caps ?? d);
  return {
    cct: [Math.min(...list.map((c) => c.cct[0])), Math.max(...list.map((c) => c.cct[1]))],
    cctStep: Math.min(...list.map((c) => c.cctStep)),
    hsi: list.some((c) => c.hsi),
    hueStep: Math.min(...list.map((c) => c.hueStep)),
    scenes: list.some((c) => c.scenes),
    gm: list.some((c) => c.gm),
  };
}

/** Rounds a value to what this light accepts. k: 'cct' | 'hue' | 'sat' | 'bri'. */
export function snap(caps, k, v) {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  if (k === 'cct') return clamp(Math.round(v / caps.cctStep) * caps.cctStep, caps.cct[0], caps.cct[1]);
  if (k === 'hue') return clamp(Math.round(v / caps.hueStep) * caps.hueStep, 0, 360);
  return clamp(Math.round(v), 0, 100);
}

/** What looks, cues and effects may store: the widest range of every driver (each light snaps on send). */
export const APP_CAPS = unionCaps(Object.values(DRIVERS).flatMap((d) => [d.caps, ...Object.keys(d.variants ?? {}).map((m) => capsFor(d, m))]));
