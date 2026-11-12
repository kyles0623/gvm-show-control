# Lights roadmap: more cheap lights, before we own them

> **Status (2 Nov 2026):** phases A–E are built. Neewer, Godox, RGB strips (ELK-BLEDOM / LEDBLE), Govee, Nanlite and
> Yongnuo drivers are in the app, marked **untested (β)**. Their encoders are checked against the sources' examples
> (`tests/drivers.test.mjs`) and the app was tested with simulated lights only. Next: reports from real lights.
>
> **11 Nov 2026:** amaran Halo 60x/100x/200x/300x/600x added as models of the amaran driver (candidate 2). The Halo 300x
> is reported working (12 Nov); the other sizes are untested.

GVM Show Control speaks to **GVM** (verified on hardware) and **amaran Ace 25c**
(reported working). This plan lists the next brands, where their protocols
are documented, and how we add them **without hardware** while being honest in
the app that they are untested.

## Rules for every new driver

1. **Bytes come from a written source.** Every command byte must be traceable to
   a published spec, a documented open-source project, or a capture. The source
   file and line go in a comment next to the encoder. No guessing, no fuzzing.
2. **License decides what we may copy.**
   - MIT/BSD/CC-BY sources: code may be ported with attribution in
     `THIRD_PARTY_NOTICES.md`.
   - GPL or unlicensed sources: we may use the *facts* (UUIDs, byte layouts) and
     write our own code. No code is copied.
3. **Never touch OTA.** Drivers do not list firmware-update services in
   `optionalServices`, and do not send any command a source marks as
   firmware/OTA (example: Godox `FD 04` arms Bluetooth OTA on LK8720 lights).
4. **Status starts at `untested`.** A driver moves to `reported` when a user
   confirms it works, and to `verified` when we test it ourselves on the light.
5. **Encoders get unit tests** that check our bytes against the examples in the
   source (like `tests/protocol.test.mjs` does for GVM).

## How "untested" shows in the app

The driver `status` field already exists. For `untested` drivers we add:

| Where | What the user sees |
|---|---|
| Supported lights dialog | An orange **Untested** badge on the brand, and a line: "Built from public documentation. Nobody has tried it on a real light yet." |
| Bluetooth chooser / first connect | A one-time confirm: "This is the first time the app talks to a *Neewer* light. It may not respond. Continue?" |
| Light chip in the top bar | A small **β** mark on untested lights, with a tooltip saying why. |
| Settings → Lights | A **Report result** link that opens a pre-filled GitHub issue ("Works / Partly / Doesn't work", model, firmware). |
| Debug log | Every frame sent to an untested light is logged in hex, so reports carry evidence. |

## Candidates, easiest first

| # | Brand | Typical price | Source (license) | Transport | Effort |
|---|---|---|---|---|---|
| 1 | More GVM models | $60–250 | Our own captures | Same as today | Low: add products after a user confirms the model |
| 2 | More amaran models (Halo series: done, 300x reported, others untested; next: Ace 25x, 60x/60d S, 100/200 x S, PT tubes) | $70–400 | wesbos/amaran-BLE-control (MIT) | Same mesh as Ace 25c | Low: same driver, add products, mark `untested` per model |
| 3 | **Neewer** (RGB660, RGB480, SL80, GL1, RGB1, TL60…) | $40–200 | keefo/NeewerLite (MIT) | Plain GATT, one write characteristic | Medium |
| 4 | **Godox** mesh lights (SL, ML, LA, P, UL, LC… 186 models) | $100–1,000 | binary-person/ha-godox-mesh (MIT) | SIG Mesh, vendor opcode | Medium: reuse `mesh.js` + `MeshHub` |
| 5 | **Generic "ELK-BLEDOM"/"LEDBLE" RGB strips and bulbs** | $10–25 | 8none1/ledble-ledlamp (GPL-3, facts only) | Plain GATT | Low, but RGB only |
| 6 | **Govee** BLE bulbs/strips (H6001, H6127…) | $15–40 | chvolkmann/govee_btled, BeauJBurroughs/Govee-H6127 (no license, facts only) | Plain GATT, 20-byte XOR frames | Low–medium, RGB + white |
| 7 | **Nanlite** (PavoTube II C, others) | $100–400 | vmedea gist (CC-BY-4.0) | UART over BLE | Medium; source calls it "slow and unreliable" |
| 8 | **Yongnuo YN-360** | $60–90 | kenkeiter/lantern (MIT) | Plain GATT, 6-byte frames | Low, but an old single model |

### 1. More GVM models

The GVM app uses the same `4C 54` protocol across its RGB panels. We add a
product entry when a user confirms a model (status `reported`). No new code.

### 2. More amaran / Sidus Link models

The Ace 25c driver already follows the Sidus mesh used across the range. Other
models differ in CCT range and whether they have color (the "d" and "S"
daylight models do not).

- Add product entries with per-model caps (CCT range, `hsi: false` for daylight models).
- Status per product: `untested` until reported.
- Done: per-model `variants` with their own `status` (Ace 25c and Halo 300x `reported`; Halo 60x/100x/200x/600x `untested`,
  2700–6500 K, `hsi: false`). Adding another model is one `variants` entry plus a product card.

### 3. Neewer (MIT, port from NeewerLite)

- **Service** `69400001-B5A3-F393-E0A9-E50E24DCCA99`, write `69400002-…`, notify `69400003-…`. Names start with `NEEWER` / `NW-`.
- **Frame:** `78 <tag> <size> <payload…> <checksum>`. The checksum is the sum of all previous bytes, `& 0xFF`.
  - Power: `78 81 01 01 FB` (on), `78 81 01 02 FC` (off).
  - HSI: `78 86 04 <hue lo> <hue hi> <sat> <bri> <cs>`.
  - CCT: `78 87 02 <bri> <cct/100> <cs>`; with GM: `78 87 03 <bri> <cct> <gm> <cs>`.
  - Built-in effects: `78 88 …` (9-FX models) / `78 8B …` (17-FX models).
- **Newer models** use a MAC-addressed form (`78 90 0B <mac6> 87 …`). Browsers do not expose the MAC address, so the first version supports only the classic form. Newer models are listed as "not supported yet".
- **Per-model data:** NeewerLite's `Database/lights.json` holds per-model command patterns, CCT ranges (most 3200–5600 K) and effect lists. We convert it into product entries at build time and keep the MIT notice.
- **Caps:** CCT, HSI on RGB models, GM on some, 9 or 17 built-in effects.

### 4. Godox (MIT, mesh)

Godox mesh lights are standard SIG Mesh over the Proxy service (`0x1828`), the
same transport as amaran. This means `mesh.js` (crypto, provisioning, config) and
`MeshHub` (one connection for many lights) are reused.

- **Vendor model:** `0x0211:0000`. Request opcode `F0 11 02`, response `F1 11 02`.
- **8-byte frames** with a CRC8 (Dallas/Maxim):
  - CCT `F0 <bri%> <K/100> <gm+50> <curve|FF> <gm-if-tint> <bri tenths> <crc>`
  - HSI `F1 <bri%> <hue u16le> <sat> <mode> <bri tenths> <crc>`
  - RGBW `F2 …`
  - Effects `F3`/`F7`
  - Gels `F4`/`F8`
  - Status `FD 01 … <record>`
- **Blocked:** `FD 04` (arms OTA) is never built. The encoder has no way to make it.
- **Caps:** per-model table (186 models: CCT range, fixed-5600 K models, color models, effects), taken from the project's generated model list.
- **Mesh keys:** Godox lights get their own mesh network (separate from amaran). A light already set up with the Godox app keeps that app's keys, so we would provision only lights that are reset, like we do for amaran.

### 5. Generic RGB strips and bulbs (ELK-BLEDOM / LEDBLE / Triones)

These are the cheapest Bluetooth lights. They are useful as colour washes and
practicals (lamps on set), but not as stage lights.

- **ELK-BLEDOM / LEDBLE:** characteristic `FFE1` (some use `FFF3`). Frames are 9 bytes, `7E … EF`:
  - power `7E FF 04 01 FF FF FF FF EF` / `… 04 00 …`
  - RGB `7E FF 05 03 RR GG BB FF EF`
  - brightness `7E FF 01 <bri> …`

  These are facts only (GPL-3 source); we write our own encoder.
- **Caps:** RGB → app converts HSI to RGB; no CCT (we fake warm/cool white with RGB and label it "approximate"); no status replies, so the app tracks state itself.
- **Many clones:** each variant (`ELK-BLEDOM`, `ELK-BLEDOB`, `LEDBLE-…`, `Triones-…`) gets its own product entry, all `untested`.

### 6. Govee (facts only)

- **Characteristic** `00010203-0405-0607-0809-0a0b0c0d2b11`.
- **Frames:** 20 bytes, `33 <cmd> <payload…>` padded with zeros, with a final XOR of all bytes.
  - `01` power
  - `04` brightness (`0x14`–`0xFE`)
  - `05` color/mode
- **Keep-alive:** `AA …` frames are needed or the light drops the link.
- **Collision warning:** Govee uses the same Telink UUID family as GVM (`…2b10`/`…2b11`). Detection must use the device name (`ihoment_`, `Govee_`, `Minger_`) before services. The GVM service fallback must skip these names.
- Many newer Govee models use Wi-Fi or an encrypted protocol; only the older BLE ones are candidates.

### 7. Nanlite (CC-BY-4.0)

- **Service** `0003cdd0-0000-1000-8000-00805f9b0131`, write `…cdd2…`, notify `…cdd1…`. Names start with `NL`.
- **Envelope:** `FA 55 <size u16> 01 <app packet> <sum u16> 0D 0A`.
  - Brightness: group `01` param `01`.
  - CCT: param `03` (2700–7500 K), GM: param `04`.
  - Hue: param `05`, saturation: param `0C`.
- **No power command** is documented, so the app would use brightness 0.
- The author reports it is slow and unreliable. We would set `minStepMs` high (simulated effects greyed out) and mark the driver `untested`.

### 8. Yongnuo YN-360 (MIT)

- **Characteristic** `f000aa61-0451-4000-b000-000000000000`. Names start with `YONGNUO`.
- **Frames:** `AE <cmd> <v1> <v2> <v3> 56`.
  - `A1` RGB
  - `AA 01 <5500K %> <3200K %>` white mix
  - `A3` off
- An old single model; low priority.

## Not planned

- **Wi-Fi-only lights** (newer Govee, LIFX, Hue without a bridge, Aputure's
  Sidus Wi-Fi): Web Bluetooth cannot reach them. A future local bridge could.
- **Lights with encrypted, undocumented BLE** (some Zhiyun, Ulanzi Vijim app
  lights): there is no public source and we will not reverse them without hardware.
- **DMX lights:** these need a USB/Art-Net interface. Web Serial plus a USB-DMX
  dongle is a possible later project.

## Order of work

| Phase | Work | Deliverable |
|---|---|---|
| A | App support for `untested`: badges, first-connect confirm, β mark, "Report result" issue link, hex logging | UI + tests |
| B | Neewer driver (classic protocol) + products from NeewerLite's database | `web/neewer.js`, encoder tests from NeewerLite examples |
| C | Generic RGB driver (ELK-BLEDOM/LEDBLE) | `web/rgbstrip.js`, encoder tests |
| D | Godox mesh driver on top of `mesh.js`/`MeshHub` (second mesh network) | `web/godox.js`, CRC8 + frame tests against the project's spec |
| E | Govee BLE, Nanlite, Yongnuo | one file each, tests |
| F | More amaran/GVM product entries as users report models | data only |

Each phase is testable in the browser with the simulated-light harness we
already use for GVM and amaran. That proves the app sends the documented bytes.
It does **not** prove the light responds, and the app says so.
