// Light drivers: one per kind of light. A driver says how to find the light in the browser's device list,
// what it can do (caps), how to connect (create → a connection with the LightConnection interface), and how to
// encode commands (enc: power, brightness, cct, hue, saturation, mode; optional scene, cycle, handshake).
//
// The app talks to a light only through its connection and its driver's encoder, so adding a brand means adding
// a driver here. status: 'verified' (checked on real hardware), 'reported' (a user says it works), 'untested'.
import { LightConnection, SERVICE } from './ble.js';
import { GVMProtocol } from './gvm-protocol.js';
import { AmaranConnection, AMARAN_ENC, MESH_UUIDS } from './amaran.js';

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
    models: 'Ace 25c (Bluetooth Mesh lights set up by this app)',
    status: 'untested',
    products: [{
      model: 'amaran Ace 25c',
      url: 'https://amarancreators.com/pages/amaran-ace-25c',
      image: 'https://cdn.sanity.io/images/7n7ckclh/production/73e66b2ec6ee19e1e477e431463f657d1e9a2442-960x960.png?w=600',
      listName: 'no name (Chrome may show “Unknown or Unsupported Device”)',
      works: 'On/off, brightness, white 2300–10,000 K, color; the 20 effects simulated by the app',
      setup: 'Close the amaran app. The first time, the app asks to set the light up in its own network (undo: hold Press to Reset in the light’s Bluetooth menu).',
    }],
    // Ace 25c: 2300-10,000 K and full color (amarancreators.com product page). Commands carry kelvin/10 and hue in 1°.
    caps: { cct: [2300, 10000], cctStep: 100, hsi: true, hueStep: 1, scenes: false, gm: false, oneConnection: false },
    filters: [{ services: [MESH_UUIDS.PROV_SERVICE] }, { services: [MESH_UUIDS.PROXY_SERVICE] }, { namePrefix: 'amaran' }],
    optionalServices: [DEVICE_INFO, MESH_UUIDS.PROV_SERVICE, MESH_UUIDS.PROXY_SERVICE],
    match: (device) => /^(amaran|aputure|slck)/i.test(device.name ?? ''),
    services: [MESH_UUIDS.PROV_SERVICE, MESH_UUIDS.PROXY_SERVICE],
    create: (opts) => new AmaranConnection(opts),
    enc: AMARAN_ENC,
  },
};

export const DEFAULT_DRIVER = 'gvm';

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
  const list = drivers.length ? drivers : [DRIVERS[DEFAULT_DRIVER]];
  return {
    cct: [Math.min(...list.map((d) => d.caps.cct[0])), Math.max(...list.map((d) => d.caps.cct[1]))],
    cctStep: Math.min(...list.map((d) => d.caps.cctStep)),
    hsi: list.some((d) => d.caps.hsi),
    hueStep: Math.min(...list.map((d) => d.caps.hueStep)),
    scenes: list.some((d) => d.caps.scenes),
    gm: list.some((d) => d.caps.gm),
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
export const APP_CAPS = unionCaps(Object.values(DRIVERS));
