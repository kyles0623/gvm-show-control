// GVM 800-RGB ("BT_LED", Ai-Thinker SPP module) command encoders.
//
// Source: Apple PacketLogger trace of the official iOS app talking to the light (2026-10-26);
// the extracted control frames are in protocol/gvm-800rgb-frames.json.
// All frames go to characteristic 00010203-0405-0607-0809-0a0b0c0d2b10 (write without response);
// replies arrive as notifications on the same characteristic.
//
// Frame layout (verified against 169 unique captured frames):
//   [0..1] 4C 54            "LT" header
//   [2]    N                number of bytes after this byte (including CRC)
//   [3]    00               constant in every captured frame
//   [4]    addr             0x30 for this light (0x00 in the handshake query)
//   [5]    cmd              0x57 'W' set param | 0x02 ack | 0x03 status | 0x48 status echo | 0x53 handshake
//   ...    payload
//   [-2..] CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflection) over bytes [0..-3], big-endian
//
// Set-param payload (cmd 0x57): 00 <param> 01 <value>
// Params seen in the capture:
//   0x00 power        0 = off, 1 = on
//   0x02 brightness   0x0A..0x64 observed (10..100 %)
//   0x03 CCT          0x20..0x38 observed (3200..5600 K, value = K / 100)
//   0x04 hue          0x00..0x48 observed (value = degrees / 5; 0x18 green, 0x30 blue)
//   0x05 saturation   0x00, 0x44, 0x64 observed (0..100 %)
//   0x06 mode         1 = CCT, 2 = HSI
//   0x06 mode         3 = Scene (the light's built-in effects)            [capture 2, 2026-10-30]
//   0x07 scene        built-in effect number, 1-based in the official app's order (2, 8, 20 seen)
//   0x08 cycle        scene cycle time in 0.1 s (Strobe II "Cycle": 1, 25, 50 seen = 0.1, 2.5, 5 s)
// Status (cmd 0x03) payload = current values of params 0x00..0x08 in order.
// Param 0x01 (02 on one light, 0A on another) is never written; meaning unknown.
// The light's handshake reply comes from its address (0x30 in capture 1, 0x33 in capture 2); the official app
// then sends every command to that address.

export const CONTROL_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b10';
export const LIGHT_ADDR = 0x30;
export const CCT_RANGE = [3200, 5600];

export function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The same frame sent to another light address (byte 4), with the CRC recomputed. */
export function withAddress(bytes, addr) {
  if (bytes[4] === addr) return bytes;
  const body = Array.from(bytes.slice(3, -2));
  body[1] = addr;
  return frame(body);
}

/** Builds a full frame from the bytes after the length byte (excluding CRC). */
export function frame(body) {
  const head = [0x4c, 0x54, body.length + 2, ...body];
  const crc = crc16xmodem(head);
  return new Uint8Array([...head, crc >> 8, crc & 0xff]);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const setParam = (param, value) => frame([0x00, LIGHT_ADDR, 0x57, 0x00, param, 0x01, value & 0xff]);

export const GVMProtocol = {
  /** First frame the official app sends after connecting. Captured verbatim. */
  handshake() { return [frame([0x00, 0x00, 0x53, 0x00, 0x00, 0x01, 0x00])]; },

  /** @param {boolean} on */
  power(on) { return [setParam(0x00, on ? 1 : 0)]; },

  /** @param {number} percent 0-100 */
  brightness(percent) { return [setParam(0x02, clamp(percent, 0, 100))]; },

  /** Switches to CCT mode, then sets CCT. @param {number} kelvin clamped to 3200-5600 */
  colorTemperature(kelvin) {
    return [setParam(0x06, 1), setParam(0x03, clamp(kelvin / 100, CCT_RANGE[0] / 100, CCT_RANGE[1] / 100))];
  },

  /** Switches to HSI mode, then sets hue, saturation, brightness. hue 0-360 (5° steps), sat/int 0-100 */
  hsi(hue, saturation, intensity) {
    return [
      setParam(0x06, 2),
      setParam(0x04, clamp(hue / 5, 0, 72)),
      setParam(0x05, clamp(saturation, 0, 100)),
      setParam(0x02, clamp(intensity, 0, 100)),
    ];
  },

  // Single-parameter encoders (same frames as above, one param each).
  /** @param {'cct'|'hsi'|'scene'} m */
  mode(m) { return [setParam(0x06, m === 'hsi' ? 2 : m === 'scene' ? 3 : 1)]; },
  cct(kelvin) { return [setParam(0x03, clamp(kelvin / 100, CCT_RANGE[0] / 100, CCT_RANGE[1] / 100))]; },
  hue(deg) { return [setParam(0x04, clamp(deg / 5, 0, 72))]; },
  saturation(percent) { return [setParam(0x05, clamp(percent, 0, 100))]; },

  // Scene mode (the light's built-in effects). Order as the official app sends it: mode 3, then the effect number.
  /** @param {number} n built-in effect number, 1–20 (official app order; see SCENES) */
  scene(n) { return [setParam(0x06, 3), setParam(0x07, clamp(n, 1, SCENES.length))]; },
  /** Scene cycle time. @param {number} seconds 0.1–5 (sent in 0.1 s; 1–50 seen in the capture) */
  cycle(seconds) { return [setParam(0x08, clamp(seconds * 10, 1, 50))]; },

  /** Reply the official app sends to every status frame: same frame with cmd 0x03 → 0x48. */
  statusEcho(statusFrame) {
    const body = Array.from(statusFrame.slice(3, -2));
    body[2] = 0x48;
    return frame(body);
  },
};

/** Converts one raw param value to app units. */
export function paramUpdate(p, v) {
  switch (p) {
    case 0: return { power: v === 1 };
    case 2: return { brightness: v };
    case 3: return { cct: v * 100 };
    case 4: return { hue: v * 5 };
    case 5: return { saturation: v };
    case 6: return { mode: v === 2 ? 'hsi' : v === 3 ? 'scene' : 'cct' };
    case 7: return { scene: v };
    case 8: return { cycle: v / 10 };
    default: return {};
  }
}

/** Structured state from a decoded frame: full state for status (0x03), one field for ack (0x02). */
export function stateFromFrame(f) {
  if (f.length < 9 || f[0] !== 0x4c || f[1] !== 0x54) return null;
  if (f[5] === 0x03) {
    const s = {};
    Array.from(f.slice(6, -2)).forEach((v, p) => Object.assign(s, paramUpdate(p, v)));
    return s;
  }
  if (f[5] === 0x02) return paramUpdate(f[7], f[8]);
  return null;
}

const PARAM_NAMES = ['power', 'p1', 'brightness', 'cct', 'hue', 'saturation', 'mode', 'scene', 'cycle'];

/** The light's built-in effects (Scene mode), numbered from 1 as in the official app. */
export const SCENES = ['Lightning', 'Cop Car', 'Candle', 'TV', 'Bad Bulb', 'Party', 'Disco', 'Paparazzi', 'Explosion', 'Pulsing',
  'Fire', 'Fireworks', 'Welding', 'CCT Loop', 'Hue Loop', 'Ambulance', 'Fire Engine', 'SOS', 'Strobe', 'Strobe II'];

function fmtParam(p, v) {
  switch (p) {
    case 0: return `power=${v ? 'on' : 'off'}`;
    case 2: return `brightness=${v}%`;
    case 3: return `cct=${v * 100}K`;
    case 4: return `hue=${v * 5}°`;
    case 5: return `saturation=${v}%`;
    case 6: return `mode=${v === 1 ? 'CCT' : v === 2 ? 'HSI' : v === 3 ? 'Scene' : v}`;
    case 7: return `scene=${v}${SCENES[v - 1] ? ` (${SCENES[v - 1]})` : ''}`;
    case 8: return `cycle=${(v / 10).toFixed(1)}s`;
    default: return `${PARAM_NAMES[p] ?? 'p' + p}=0x${v.toString(16).padStart(2, '0')}`;
  }
}

/** Splits a notification into frames and describes each. Returns [{bytes, ok, text, isStatus}]. */
export function decode(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x4c || bytes[i + 1] !== 0x54 || i + 2 >= bytes.length) {
      out.push({ bytes: bytes.slice(i), ok: false, text: 'not an LT frame', isStatus: false });
      break;
    }
    const f = bytes.slice(i, i + 3 + bytes[i + 2]);
    i += f.length;
    const crcOk = f.length >= 5 && crc16xmodem(f.slice(0, -2)) === ((f[f.length - 2] << 8) | f[f.length - 1]);
    const cmd = f[5];
    let text;
    if (cmd === 0x02) text = `ack ${fmtParam(f[7], f[8])}`;
    else if (cmd === 0x03) text = 'status ' + Array.from(f.slice(6, -2), (v, p) => fmtParam(p, v)).join(' ');
    else if (cmd === 0x53) text = `handshake reply addr=0x${f[4].toString(16)} data=${Array.from(f.slice(8, -2), (b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    else if (cmd === 0x57) text = `set ${fmtParam(f[7], f[9])}`;
    else text = `cmd=0x${cmd?.toString(16)}`;
    out.push({ bytes: f, ok: crcOk, text: crcOk ? text : `${text} [CRC MISMATCH]`, isStatus: cmd === 0x03 && crcOk });
  }
  return out;
}
