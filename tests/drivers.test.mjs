// Encoders for untested lights, checked against the examples in their sources (see web/lightproto.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../web/lightproto.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const st = (o) => ({ on: true, mode: 'cct', kelvin: 5600, hue: 0, sat: 100, bri: 50, ...o });

test('Neewer: power frames and checksums (NeewerLiteTests/CommandParserTests.swift)', () => {
  assert.equal(hex(P.neewerFrame(0x81, [0x01])), '788101' + '01fb');
  assert.equal(hex(P.neewerFrame(0x81, [0x02])), '78810102fc');
  assert.equal(hex(P.neewerFrame(0x87, [0x32, 0x32, 0x32, 0x00, 0x00])), '788705323232' + '00009a');
  assert.equal(hex(P.neewerFrame(0x86, [0x80, 0x50, 0x64, 0x00])), '788604805064' + '0036');
});

test('Neewer: whole states per family', () => {
  assert.deepEqual(P.neewerFrames(st({ on: false })).map(hex), ['78810102fc']);
  const [on, cct] = P.neewerFrames(st({ bri: 75, kelvin: 4400 }));
  assert.equal(hex(on), '78810101fb');
  assert.equal(hex(cct), hex(P.neewerFrame(0x87, [75, 44, 0x32, 0, 0])));
  const [, hsi] = P.neewerFrames(st({ mode: 'hsi', hue: 300, sat: 80, bri: 100 }));
  assert.equal(hex(hsi), hex(P.neewerFrame(0x86, [300 & 0xff, 1, 80, 100])));
  const [, c2] = P.neewerFrames(st({ bri: 10, kelvin: 3200 }), { family: 'classic' });
  assert.equal(hex(c2), hex(P.neewerFrame(0x87, [10, 32])));
  const [, b1, b2] = P.neewerFrames(st({ bri: 10, kelvin: 9000 }), { family: 'classicBi' });
  assert.equal(hex(b1), hex(P.neewerFrame(0x82, [10])));
  assert.equal(hex(b2), hex(P.neewerFrame(0x83, [56])));            // clamped to 5600 K
  const [, white] = P.neewerFrames(st({ mode: 'hsi' }), { hsi: false });
  assert.equal(white[1], 0x87);                                      // a bi-color light never gets a color command
});

test('Godox: CRC-8 and frames (protocol.py doctests)', () => {
  assert.equal(P.crc8maxim(Uint8Array.from([0xfe, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff])), 0x7f);
  assert.equal(hex(P.godoxCct(75, 5600)), 'f04b38320000003c');
  assert.equal(hex(P.godoxHsi(100, 240, 100)), 'f164f000640000fb');
  assert.equal(hex(P.godoxHsi(50, 0, 0)), 'f1320000000000fa');
  assert.equal(hex(P.godoxStatusRequest()), 'fd01ffffffffa095');
  assert.deepEqual(P.godoxParseStatus(Uint8Array.from([0xa0, 0x0a, 0x1b, 0x32, 0xff, 0xff, 0x01, 0xf9])), { record: 0xa0, bri: 10, kelvin: 2700 });
  assert.equal(P.godoxParseStatus(Uint8Array.from([0xa0, 0x0a, 0x1b, 0x32, 0xff, 0xff, 0x01, 0x00])), null);
  assert.equal(hex(P.godoxFrame(st({ on: false }))), hex(P.godoxCct(0, 5600)));
  assert.equal(P.godoxFrame(st({ mode: 'hsi' }), { hsi: false })[0], 0xf0);
});

test('Nanlite: envelope and packets (gist examples)', () => {
  assert.equal(hex(P.nanliteEnvelope([0x03, 0x20, 0x01, 0x01, 0x00, 0x32, 0x00, 0x04])), 'fa55001101032001010032000401bd0d0a');
  assert.equal(hex(P.nanliteSet16(0x03, 0x01, 50)), 'fa55001101032001010032000401bd0d0a');
  const [hsi] = P.nanliteFrames(st({ mode: 'hsi', hue: 0, sat: 100, bri: 11 }), 0x23);
  assert.equal(hex(hsi.subarray(5, hsi.length - 4)), '232400040101010800' + '0b030100' + '0064');
  const [cct] = P.nanliteFrames(st({ kelvin: 5600, bri: 50 }), 1);
  assert.equal(hex(cct.subarray(5, cct.length - 4)), '0124000401010' + '10b0032020201' + '15e0' + '000001');
});

test('Yongnuo: lantern packets', () => {
  assert.deepEqual(P.yongnuoFrames(st({ on: false })).map(hex), ['aea300000056']);
  assert.equal(hex(P.yongnuoFrames(st({ kelvin: 5500, bri: 100 }))[0]), 'aeaa01640056');
  assert.equal(hex(P.yongnuoFrames(st({ kelvin: 3200, bri: 50 }))[0]), 'aeaa01003256');
  assert.equal(hex(P.yongnuoFrames(st({ mode: 'hsi', hue: 0, sat: 100, bri: 100 }))[0]), 'aea1ff000056');
});

test('ELK-BLEDOM, LEDBLE and Govee: frames from their sources', () => {
  assert.deepEqual(P.elkFrames(st({ on: false })).map(hex), ['7e00040000000000ef']);
  const elk = P.elkFrames(st({ mode: 'hsi', hue: 120, sat: 100, bri: 50 })).map(hex);
  assert.deepEqual(elk, ['7e00040100000000ef', '7e00050300ff0000ef', '7e00013200000000ef']);
  assert.deepEqual(P.ledbleFrames(st({ on: false })).map(hex), ['7eff0400ffffffffef']);
  assert.equal(hex(P.ledbleFrames(st({ mode: 'hsi', hue: 240 }))[1]), '7eff05030000ffffef');
  assert.equal(hex(P.goveeKeepAlive()), 'aa010000000000000000000000000000000000ab');
  const g = P.goveeFrames(st({ mode: 'hsi', hue: 0, sat: 100, bri: 100 }));
  assert.equal(g[0].length, 20);
  assert.equal(hex(g[0]), '3301010000000000000000000000000000000033');
  assert.equal(hex(g[1]).slice(0, 12), '330502ff0000');
  assert.equal(g[2][2], 0xfe);
});
