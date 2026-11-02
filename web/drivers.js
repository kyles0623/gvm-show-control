// Light drivers: one per kind of light. A driver says how to find the light in the browser's device list,
// what it can do (caps), how to connect (create → a connection with the LightConnection interface), and how to
// encode commands (enc: power, brightness, cct, hue, saturation, mode; optional scene, cycle, handshake).
//
// The app talks to a light only through its connection and its driver's encoder, so adding a brand means adding
// a driver here. status: 'verified' (checked on real hardware), 'reported' (a user says it works), 'untested'.
import { LightConnection, SERVICE } from './ble.js';
import { GVMProtocol } from './gvm-protocol.js';

const DEVICE_INFO = '0000180a-0000-1000-8000-00805f9b34fb';

export const DRIVERS = {
  gvm: {
    id: 'gvm',
    brand: 'GVM',
    models: '800-RGB and other lights that show up as BT_LED',
    status: 'verified',
    caps: {
      cct: [3200, 5600], cctStep: 100,   // K
      hsi: true, hueStep: 5,             // hue sent in 5° steps
      scenes: true,                      // the light's 20 built-in effects (Scene mode)
      gm: false,                         // green/magenta tint
      oneConnection: true,               // the light accepts one Bluetooth connection at a time
    },
    filters: [{ namePrefix: 'BT_LED' }, { services: [SERVICE] }],
    optionalServices: [DEVICE_INFO, SERVICE],
    match: (device) => !device.name || device.name.startsWith('BT_LED'),
    create: (opts) => new LightConnection(opts),
    enc: GVMProtocol,
  },
};

export const DEFAULT_DRIVER = 'gvm';

export const driverOf = (id) => DRIVERS[id] ?? DRIVERS[DEFAULT_DRIVER];

/** The driver for a device picked in the chooser (first match; GVM if none). */
export function driverFor(device) {
  return Object.values(DRIVERS).find((d) => d.match(device)) ?? DRIVERS[DEFAULT_DRIVER];
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
