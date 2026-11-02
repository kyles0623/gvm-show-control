// Command encoders for lights that are UNTESTED on hardware. Each one turns a whole light state
// {on, mode: 'cct'|'hsi', kelvin, hue, sat, bri} into the bytes its source documents. Nothing here is guessed:
// every byte layout names the source it comes from, and tests/drivers.test.mjs checks the encoders against the
// examples in those sources. Pure functions (no Bluetooth), so they run in Node for the tests.
//
// Sources and licenses (see THIRD_PARTY_NOTICES.md):
//   Neewer   keefo/NeewerLite (MIT): NeewerLight.swift, NeewerLightConstant.swift, Database/lights.json,
//            NeewerLiteTests/CommandParserTests.swift
//   Godox    binary-person/ha-godox-mesh (MIT): src/godox_mesh_bt/protocol.py, crypto.py, docs/consolidated/*
//   Yongnuo  kenkeiter/lantern (MIT): lantern/light.py
//   Nanlite  vmedea's gist 434694c11092261fcac401b7a4b9a741 (CC-BY-4.0): "Nanlite app protocol"
//   ELK-BLEDOM  arduino12/ble_rgb_led_strip_controller README (GPL-3: facts only, this code is our own)
//   LEDBLE   8none1/ledble-ledlamp ledbleledlamp.py (GPL-3: facts only, this code is our own)
//   Govee    chvolkmann/govee_btled, BeauJBurroughs/Govee-H6127-Reverse-Engineering (no license: facts only)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const u8 = (a) => new Uint8Array(a);

/** HSV (hue°, sat %, value 0..1) → [r, g, b] 0..255. For lights that only take RGB. */
export function hsvToRgb(h, s, v = 1) {
  s = clamp(s, 0, 100) / 100; h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((n) => clamp((n + m) * 255, 0, 255));
}

/**
 * Approximate white for RGB-only lights: blends from warm (2700 K ≈ 255,166,87) to cool (6500 K = 255,255,255).
 * These two RGB points are the usual sRGB approximations of those color temperatures, not from a light's source;
 * the app labels white on these lights "approximate".
 */
export function kelvinToRgb(k) {
  const t = Math.min(1, Math.max(0, (k - 2700) / (6500 - 2700)));
  return [255, clamp(166 + t * (255 - 166), 0, 255), clamp(87 + t * (255 - 87), 0, 255)];
}

// ---------------------------------------------------------------------------------------------------------------
// Neewer (NeewerLite, MIT). Every command: 78 <tag> <size> <payload…> <checksum = sum of all bytes before & 0xFF>.
// ---------------------------------------------------------------------------------------------------------------

export const NEEWER = {
  SERVICE: '69400001-b5a3-f393-e0a9-e50e24dcca99',
  CONTROL: '69400002-b5a3-f393-e0a9-e50e24dcca99',   // write
  NOTIFY: '69400003-b5a3-f393-e0a9-e50e24dcca99',
};

/** NeewerLight.swift appendCheckSum / composeSingleCommand. */
export function neewerFrame(tag, payload) {
  const b = [0x78, tag, payload.length, ...payload];
  return u8([...b, b.reduce((s, x) => s + x, 0) & 0xff]);
}

/**
 * Neewer frames for a state. family:
 *   'db'        lights.json commandPatterns (RGB660 PRO, RGB176 A1, RGB1, TL60 RGB…):
 *               power 78 81 01 {01 on|02 off}; cct 78 87 05 <bri> <K/100> <gm> 00 00; hsi 78 86 04 <hue le16> <sat> <bri>
 *               (gm byte: literal 0x32 in most patterns; "gm uint8 0..100" = gm+50, so neutral is also 0x32;
 *               "gm int8 -50..50" (CB100C) neutral is 0x00: gmNeutral)
 *   'classic'   NeewerLight.swift legacy getCCTLightCommand (RGB lights without database patterns):
 *               cct 78 87 02 <bri> <K/100>; hsi as above
 *   'classicBi' legacy getCCTOnlyLightCommand (bi-color lights without patterns): 78 82 01 <bri> then 78 83 01 <K/100>
 * Off is the power command. Brightness travels inside the white / color command.
 */
export function neewerFrames(st, { family = 'db', hsi = true, gmNeutral = 0x32, cct = [3200, 5600] } = {}) {
  if (!st.on) return [neewerFrame(0x81, [0x02])];
  const out = [neewerFrame(0x81, [0x01])];
  const bri = clamp(st.bri, 0, 100);
  if (st.mode === 'hsi' && hsi) {
    const h = clamp(st.hue, 0, 360);
    out.push(neewerFrame(0x86, [h & 0xff, (h >> 8) & 0xff, clamp(st.sat, 0, 100), bri]));
    return out;
  }
  const k = clamp(clamp(st.kelvin, cct[0], cct[1]) / 100, 0, 255);
  if (family === 'classicBi') out.push(neewerFrame(0x82, [bri]), neewerFrame(0x83, [k]));
  else if (family === 'classic') out.push(neewerFrame(0x87, [bri, k]));
  else out.push(neewerFrame(0x87, [bri, k, gmNeutral, 0x00, 0x00]));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ELK-BLEDOM / LEDBLE RGB strip controllers (facts only, see header). 9-byte frames 7E … EF.
// ---------------------------------------------------------------------------------------------------------------

export const ELK = { SERVICE: '0000fff0-0000-1000-8000-00805f9b34fb' };
export const LEDBLE = { SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb', WRITE: '0000ffe1-0000-1000-8000-00805f9b34fb' };

/**
 * ELK-BLEDOM (arduino12 README): power 7E 00 04 <01|00> 00 00 00 00 EF; brightness 7E 00 01 <0..100> 00 00 00 00 EF;
 * RGB 7E 00 05 03 <r> <g> <b> 00 EF. White is sent as RGB (approximate): the README's temperature mode has no
 * kelvin scale.
 */
export function elkFrames(st) {
  if (!st.on) return [u8([0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef])];
  const [r, g, b] = st.mode === 'hsi' ? hsvToRgb(st.hue, st.sat) : kelvinToRgb(st.kelvin);
  return [
    u8([0x7e, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0xef]),
    u8([0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef]),
    u8([0x7e, 0x00, 0x01, clamp(st.bri, 0, 100), 0x00, 0x00, 0x00, 0x00, 0xef]),
  ];
}

/**
 * LEDBLE-01 (ledble-ledlamp): power 7E FF 04 <01|00> FF FF FF FF EF; RGB 7E FF 05 03 <r> <g> <b> FF EF;
 * brightness 7E FF 01 <0..100> 00 FF FF FF FF EF (10 bytes, as the source sends it).
 */
export function ledbleFrames(st) {
  if (!st.on) return [u8([0x7e, 0xff, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff, 0xef])];
  const [r, g, b] = st.mode === 'hsi' ? hsvToRgb(st.hue, st.sat) : kelvinToRgb(st.kelvin);
  return [
    u8([0x7e, 0xff, 0x04, 0x01, 0xff, 0xff, 0xff, 0xff, 0xef]),
    u8([0x7e, 0xff, 0x05, 0x03, r, g, b, 0xff, 0xef]),
    u8([0x7e, 0xff, 0x01, clamp(st.bri, 0, 100), 0x00, 0xff, 0xff, 0xff, 0xff, 0xef]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Govee BLE bulbs / strips (facts only). 20 bytes: 33 <cmd> <payload> zero-padded to 19, then XOR of those 19.
// ---------------------------------------------------------------------------------------------------------------

export const GOVEE = {
  SERVICE: '00010203-0405-0607-0809-0a0b0c0d1910',     // the same service UUID GVM lights use: detect Govee by name
  CONTROL: '00010203-0405-0607-0809-0a0b0c0d2b11',
};

export function goveeFrame(first, cmd, payload = []) {
  const b = [first, cmd, ...payload];
  while (b.length < 19) b.push(0);
  return u8([...b, b.reduce((x, y) => x ^ y, 0)]);
}
/** Keep-alive the Govee app sends every 2 s (Govee-H6127 README): AA 01 00… AB. */
export const goveeKeepAlive = () => goveeFrame(0xaa, 0x01);

/**
 * Power 33 01 <01|00>; brightness 33 04 <0..FE> (H6127: 0xFE = 100 %); color 33 05 02 <r> <g> <b> (manual mode).
 * White is sent as RGB (approximate): the bulbs' white LEDs need the Govee app's table of white shades.
 */
export function goveeFrames(st) {
  if (!st.on) return [goveeFrame(0x33, 0x01, [0x00])];
  const [r, g, b] = st.mode === 'hsi' ? hsvToRgb(st.hue, st.sat) : kelvinToRgb(st.kelvin);
  return [
    goveeFrame(0x33, 0x01, [0x01]),
    goveeFrame(0x33, 0x05, [0x02, r, g, b]),
    goveeFrame(0x33, 0x04, [clamp(st.bri * 0xfe / 100, 0, 0xfe)]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Yongnuo YN-360 (lantern, MIT): AE <cmd> <v1> <v2> <v3> 56.
// ---------------------------------------------------------------------------------------------------------------

export const YONGNUO = {
  // lantern looks the characteristic up without its service; Web Bluetooth needs the service. f000aa60 is the
  // service TI's convention pairs with f000aa61 (an assumption: if it's wrong, the light just won't connect).
  SERVICE: 'f000aa60-0451-4000-b000-000000000000',
  CONTROL: 'f000aa61-0451-4000-b000-000000000000',
};

/**
 * set_color A1 <r> <g> <b> (each scaled by intensity); set_white AA 01 <5500K %> <3200K %> (3200–5500 K, each 0..100
 * scaled by intensity); power_off A3 00 00 00. Outside 3200–5500 K lantern sends white as RGB; this app keeps
 * the light's white range at 3200–5500 K instead.
 */
export function yongnuoFrames(st) {
  const f = (cmd, a, b, c) => u8([0xae, cmd, a, b, c, 0x56]);
  if (!st.on) return [f(0xa3, 0x00, 0x00, 0x00)];
  const i = clamp(st.bri, 0, 100) / 100;
  if (st.mode === 'hsi') { const [r, g, b] = hsvToRgb(st.hue, st.sat); return [f(0xa1, clamp(r * i, 0, 255), clamp(g * i, 0, 255), clamp(b * i, 0, 255))]; }
  const k = Math.min(5500, Math.max(3200, st.kelvin));
  const p = (k - 3200) / (5500 - 3200);
  return [f(0xaa, 0x01, clamp(p * 100 * i, 0, 100), clamp((1 - p) * 100 * i, 0, 100))];
}

// ---------------------------------------------------------------------------------------------------------------
// Nanlite (gist, CC-BY-4.0): UART over BLE. Envelope FA 55 <total size u16 BE> 01 <app packet> <sum u16 BE> 0D 0A,
// sum = all bytes before it + 1. App packets: short (8 bytes) seq, flags, group, param, 4-byte payload;
// extended: seq, 24, 00 04, 01 01, opcode, payload.
// ---------------------------------------------------------------------------------------------------------------

export const NANLITE = {
  SERVICE: '0003cdd0-0000-1000-8000-00805f9b0131',
  NOTIFY: '0003cdd1-0000-1000-8000-00805f9b0131',   // UART_TX
  WRITE: '0003cdd2-0000-1000-8000-00805f9b0131',    // UART_RX (20 bytes per write)
};

export function nanliteEnvelope(app) {
  const size = 5 + app.length + 4;
  const b = [0xfa, 0x55, size >> 8, size & 0xff, 0x01, ...app];
  const sum = (b.reduce((s, x) => s + x, 0) + 1) & 0xffff;
  return u8([...b, sum >> 8, sum & 0xff, 0x0d, 0x0a]);
}

/** Write a uint16 parameter of group 1: seq 20 01 <param> <hi> <lo> 00 04 (the gist's brightness example). */
export const nanliteSet16 = (seq, param, v) => nanliteEnvelope([seq & 0xff, 0x20, 0x01, param, (v >> 8) & 0xff, v & 0xff, 0x00, 0x04]);

/**
 * set_mode (extended opcode 01). HSI 03:01: ssize 08, bri u16, 03 01, hue u16 BE, sat (the gist's example
 * 23 24 00 04 01 01 01 08 00 0b 03 01 00 00 64). CCT 02:02: ssize 0B, bri u16, 02 02, 01, K u16 BE, G/M u16 BE, 01.
 * No power command is documented: off is brightness 0.
 */
export function nanliteFrames(st, seq) {
  const bri = st.on ? clamp(st.bri, 0, 100) : 0;
  const head = [seq & 0xff, 0x24, 0x00, 0x04, 0x01, 0x01, 0x01];
  if (!st.on) return [nanliteSet16(seq, 0x01, 0)];
  if (st.mode === 'hsi') {
    const h = clamp(st.hue, 0, 359);
    return [nanliteEnvelope([...head, 0x08, 0x00, bri, 0x03, 0x01, h >> 8, h & 0xff, clamp(st.sat, 0, 100)])];
  }
  const k = clamp(st.kelvin, 2700, 7500);
  return [nanliteEnvelope([...head, 0x0b, 0x00, bri, 0x02, 0x02, 0x01, k >> 8, k & 0xff, 0x00, 0x00, 0x01])];
}

// ---------------------------------------------------------------------------------------------------------------
// Godox mesh (ha-godox-mesh, MIT): vendor access messages, opcode 0x0211F0 (wire F0 11 02), replies 0x0211F1.
// V2 frame: <sub> <5 data bytes, padded FF> <end byte> <CRC-8 Dallas/Maxim over the first 7>.
// ---------------------------------------------------------------------------------------------------------------

export const GODOX = { OPCODE: [0xf0, 0x11, 0x02], REPLY_OPCODE: 0x0211f1 };

/** CRC-8 Dallas/Maxim (reflected polynomial 0x8C, init 0): crypto.py checksum. */
export function crc8maxim(bytes) {
  let crc = 0;
  for (const x of bytes) {
    crc ^= x;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
  }
  return crc;
}

export function godoxV2(sub, end, data) {
  const d = [...data]; while (d.length < 5) d.push(0xff);
  const b = [sub, ...d, end];
  return u8([...b, crc8maxim(b)]);
}

/** build_cct_command: F0 <bri %> <K/100> <gm+50> <curve> <gm if tint> <bri tenths>; gm 0, curve 0 (the app's default). */
export const godoxCct = (bri, kelvin) => godoxV2(0xf0, 0, [clamp(bri, 0, 100), clamp(kelvin / 100, 0, 255), 50, 0, 0]);
/** build_hsi_command: F1 <bri %> <hue le16> <sat> <mode 0> <bri tenths>. */
export const godoxHsi = (bri, hue, sat) => { const h = clamp(hue, 0, 360); return godoxV2(0xf1, 0, [clamp(bri, 0, 100), h & 0xff, h >> 8, clamp(sat, 0, 100), 0]); };
/** build_status_request(): FD 01 … end A0 (the colour-temperature record). The only FD request this app sends. */
export const godoxStatusRequest = () => godoxV2(0xfd, 0xa0, [0x01]);

/** Godox frame for a state. Off is 0 % brightness, as the Home Assistant integration does by default. */
export function godoxFrame(st, { hsi = false, cct = [2800, 6500] } = {}) {
  const bri = st.on ? st.bri : 0;
  if (st.mode === 'hsi' && hsi) return godoxHsi(bri, st.hue, st.sat);
  return godoxCct(bri, Math.min(cct[1], Math.max(cct[0], st.kelvin)));
}

/** A status reply (record A0..AA): {record, bri, kelvin?}; null if the CRC doesn't match. */
export function godoxParseStatus(f) {
  if (f.length !== 8 || crc8maxim(f.subarray(0, 7)) !== f[7] || f[0] < 0xa0 || f[0] > 0xaa) return null;
  return { record: f[0], bri: f[1], kelvin: f[0] === 0xa0 ? f[2] * 100 : null };
}
