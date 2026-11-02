// amaran / Sidus "Telink 0x26" light commands: 10-byte payloads sent with access opcode 0x26 over Bluetooth Mesh.
//
// Ported from wesbos/amaran-BLE-control, src/telink.ts (MIT License, Copyright (c) 2026 wesbos), which documents
// these from the amaran apps and checked them on Halo and T2c lights. NOT yet confirmed on an Ace 25c: the amaran
// driver is 'untested' until each command is checked on the real light (docs/TECHNICAL.md).
//
// Layout: p[0] = checksum (sum of p[1..9] & 0xff), p[9] = command type, value bits in between.
// Intensity is 0..1000 (0.1 % steps).

export const OPCODE = 0x26;

const done = (p) => { let s = 0; for (let i = 1; i < 10; i++) s += p[i]; p[0] = s & 0xff; return p; };
const clampI = (v) => Math.max(0, Math.min(1000, Math.round(v)));

/** Status request (0x0e): the light answers with its state. */
export const statusRequest = () => done(Object.assign(new Uint8Array(10), { 9: 0x0e }));

/** On / off (0x8c). */
export function onoff(on) { const p = new Uint8Array(10); p[8] = on ? 1 : 0; p[9] = 0x8c; return done(p); }

/** Brightness only (0x8f), intensity 0..1000. */
export function brightness(i) {
  const v = clampI(i), p = new Uint8Array(10);
  p[7] = (v & 3) << 6; p[8] = (v >> 2) & 0xff; p[9] = 0x8f;
  return done(p);
}

/** White (0x82): kelvin, intensity 0..1000, green/magenta -10..+10 (0 = neutral). */
export function cct(kelvin, i, gm = 0) {
  const v = clampI(i);
  let t = Math.trunc((kelvin + 5) / 10);           // kelvin/10, as the firmware's integer division
  t = Math.max(80, Math.min(2000, t));
  const g = Math.max(0, Math.min(20, Math.round(gm) + 10));
  let low = BigInt(v & 3) << 62n;
  let high = 0x8200 | ((v >> 2) & 0xff);
  if (t < 1001) { low |= BigInt(t) << 52n; high |= (t >> 12) & 0xff; }
  else { low |= BigInt((t + 0x18) & 0x3ff) << 52n; low |= 0x0000040000000000n; }
  low |= BigInt(g & 0x7f) << 45n;
  const p = new Uint8Array(10);
  for (let k = 0; k < 8; k++) p[k] = Number((low >> BigInt(k * 8)) & 0xffn);
  p[8] = high & 0xff; p[9] = (high >> 8) & 0xff;
  return done(p);
}

/** Color (0x81): hue 0..360, saturation 0..100, intensity 0..1000. */
export function hsi(hue, sat, i) {
  const v = clampI(i), h = Math.max(0, Math.min(360, Math.round(hue))) & 0x1ff, s = Math.max(0, Math.min(100, Math.round(sat))) & 0x7f;
  const p = new Uint8Array(10);
  p[5] = (s & 3) << 6;
  p[6] = ((h & 7) << 5) | ((s >> 2) & 0x1f);
  p[7] = ((h >> 3) & 0x3f) | ((v & 3) << 6);
  p[8] = (v >> 2) & 0xff;
  p[9] = 0x81;
  return done(p);
}

/** Decodes a 10-byte status payload → {on, mode: 'cct'|'hsi', intensity, kelvin, gm, hue, sat} or null. */
export function decodeStatus(p) {
  if (p.length < 10) return null;
  let s = 0; for (let i = 1; i < 10; i++) s += p[i];
  if ((s & 0xff) !== p[0]) return null;
  const cmd = p[9] & 0x7f;
  let low = 0n; for (let i = 0; i < 8; i++) low |= BigInt(p[i]) << BigInt(i * 8);
  const high = p[8] | (p[9] << 8);
  const on = ((low >> 8n) & 1n) === 1n;
  if (cmd === 0x02) {
    const raw = Number((low >> 52n) & 0x3ffn), flag = Number((low >> 42n) & 1n);
    const intensity = ((high << 2) | Number((low >> 62n) & 3n)) & 0x3ff;
    const gm = Math.max(-10, Math.min(10, Number((low >> 45n) & 0x7fn) - 10));
    return { on, mode: 'cct', intensity, kelvin: (flag ? raw + 1000 : raw) * 10, gm };
  }
  if (cmd === 0x01) {
    return {
      on, mode: 'hsi',
      sat: Math.min(100, ((p[6] & 0x1f) << 2) | ((p[5] >> 6) & 3)),
      hue: Math.min(360, ((p[7] & 0x3f) << 3) | ((p[6] >> 5) & 7)),
      intensity: Math.min(1000, (p[8] << 2) | ((p[7] >> 6) & 3)),
    };
  }
  return null;
}
