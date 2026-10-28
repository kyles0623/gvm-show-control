# Technical notes

How the app behaves and how the light's protocol works. For setup and use, see the [README](../README.md).
Tested with a GVM 800-RGB, which advertises as `BT_LED`.

## Run
```
bash web/serve.sh           # from the repo root: serves http://localhost:8765 and opens Chrome
```
Install as an app: Chrome address bar → install icon (or ⋮ → Cast, save, and share → Install page as app).
After the first install the app also opens offline from its cache. Run serve.sh again to pick up code changes.

## Supported browsers
| Platform | Works? |
|---|---|
| macOS, Windows, ChromeOS, Android — Chrome or Edge | Yes (tested: Chrome on macOS) |
| Opera | Should work (Chromium); untested |
| Brave | Web Bluetooth off by default |
| Safari, Firefox (any OS) | No Web Bluetooth |
| iPhone / iPad (any browser) | No — Apple blocks Web Bluetooth; third-party Bluefy browser untested |
| Linux Chrome | Untested |

Unsupported browsers get a full-screen explanation with alternatives and a Copy link button.

## Onboarding & help
- **First run:** setup checklist: browser ✓, Bluetooth availability (live; per-OS fix steps, e.g. macOS
  Privacy & Security → Bluetooth), light prep (on, phone app closed, in range), then **Find my light**.
  Re-run from Help.
- **Plain-language problems:** chooser cancelled, Bluetooth off/blocked, light busy (phone connected),
  wrong device, browser forgot permission, connection lost, repeated reconnect failures. Each comes with
  fix steps and an action button (Pair light / Try again / Retry now / Help).
- **Help** (`?`): quick start, shortcuts, troubleshooting.
- **Settings:** display name, auto-connect on open, reconnect, forget light, keep screen awake, warn
  before closing, dim UI, reset effect settings, show Debug tab (hidden by default), reset all settings,
  about. Settings save immediately. Destructive buttons need a second click to confirm.

## Hosting
Web Bluetooth only works on `https://` or `http://localhost`.
- Local (current): `bash web/serve.sh`.
- Shared: upload the `web/` folder to any static HTTPS host (e.g. GitHub Pages, Netlify). There is no server-side code.

## Layout
- 960 px wide and up: three columns that fill the window, no scrolling — **A** Power / Blackout / Fade / status,
  **B** Brightness / color / Looks, **C** Effects + settings. Sizes scale with window height; checked in Chromium
  at 1024×640, 1024×768, 1180×820, 1280×720, 1366×768, 1440×900 and 1920×1080, including the tallest
  case (Color mode + an effect with 7 settings).
- Narrower (phones, portrait tablets): sections stack and the page scrolls.
- Keyboard shortcuts moved from the footer to Help (`?`).

## Show tab
| Control | Behavior |
|---|---|
| Power | Toggles power (param 0x00) |
| Blackout / Restore (`B`) | Snap: power off/on. With a fade time: brightness ramps to 0 then power off; restore powers on at 0 and ramps back to the pre-blackout level |
| Fade time | Slider 0–10 s (quadratic: left third = 0–1 s in 50 ms steps) + chips Snap/0.25/0.5/1/3/5/10 s. Fades ≤ 1.5 s step every 70 ms, longer every 150 ms |
| Sliders | Live while dragging (≤ 1 frame / 150 ms), final value on release; CCT/color sliders switch the light's mode first if needed |
| `↑` `↓` / `⇧`+`↑` `↓` | Brightness ±5 / ±1 |
| Lock (`L`) | Disables everything except Blackout/Restore |
| Dim UI | Halves screen brightness for the booth |
| Keep screen awake | Screen Wake Lock while connected |
| Light reports | Decoded from the light's 5 s status frames |

## Multiple lights (`rig.js`)
- Every paired light has its own connection (own write queue, reconnect and status), so lights are driven in parallel.
- Silent-link watchdog: the light sends a status frame every ~5 s. If a connected light sends nothing for 7 s its
  blackout button shows "no reply"; after 12 s the app drops that link and reconnects it (macOS can keep a dead link
  "connected" for 20 s or more, while writes to it go nowhere).
- Remembered lights live in `localStorage['gvm.lights']` as `{id, name, label}`; the older single-light keys are migrated on first load.
- Selection: chips appear with 2+ lights. Click = only that light, Shift/⌘-click = add/remove, All = every light.
  Sliders, mode, looks, effects and the Power button act on the selection; the sliders show the first selected light.
- The master Blackout / Restore acts on every connected light; Restore also brings back lights blacked out individually.
  Each light remembers its own pre-blackout level.
- With 2+ lights, a button per light under the master blacks out / restores just that light (same fade time).
  It doesn't stop effects or cues on the other lights; each light owns its own fade, so one light's fade never cancels another's.
- `Tab` / `⇧Tab` cycles the selection All → each light (ignored while typing in a text field).
- Rename: double-click a light chip, or the header name with one light, or Settings → Lights. Enter saves, Esc cancels.

## Crossfades
- Looks use the Fade time; cues use their own fade time. Every ~70 ms (fades ≤ 1.5 s) or ~120 ms, each light gets only the
  parameters that changed, so a brightness-only fade is one frame per step.
- Hue moves the short way round the wheel (330° → 20° goes through 0°). White ↔ Color can't be blended, so the light fades
  out in the old mode, switches at the midpoint and fades in with the new one.
- Any manual control, Blackout, a new look/cue or Esc cancels a running fade.

## Cue list (`show.js`; **☰ Cue list** panel on the Show tab, or popped out)
- The panel replaces the Effects column (toggle: button or `C`) and has its own row of effect buttons, so a look, the
  sliders and an effect can all be set and recorded without leaving the Show tab. Effect *settings* are in the Effects column.
- **Pop out** opens the same editor in a separate window (same page, same lights — no second Bluetooth connection);
  Space / Shift+Space / B / Esc work in it. **Dock** or closing the window brings the list back to the panel.
- A cue = `{name, fade s, follow s | null, effect: {id, params, lightIds} | null, lights: {id: {power, mode, cct, hue, sat, bri}}}`,
  stored in `localStorage['gvm.cues']`.
- **Record** saves every connected light after the selected cue. If an effect is running, the cue stores the effect (with its
  current settings) and, as each light's base look, the look from before the effect started.
- **GO** (`Space`): lights recorded as on but currently dark are powered on at 0 and faded in; others crossfade; lights
  recorded as off fade out and power off; then the cue's effect starts. **Auto-GO** counts from the start of the cue.
  **Back** (`Shift+Space`) runs the previous cue. Esc cancels a pending auto-GO, a running fade and the effect.
- Lights in a cue that aren't connected are skipped (logged).

## Looks library (Looks tab)
`localStorage['gvm.looks']`, seeded with the six defaults. Save current (from the first selected light), rename, update,
reorder, delete, restore defaults. The first nine are on the Show tab with keys 1–9.

## Looks & effects (`effects.js`)
Default looks (editable, see Looks library):

| Key | Look | State |
|---|---|---|
| 1 | Daylight | CCT 5600 K, 80 % |
| 2 | Tungsten | CCT 3200 K, 80 % |
| 3 | Sunset | HSI 25°, sat 90, 60 % |
| 4 | Moonlight | HSI 215°, sat 45, 25 % |
| 5 | Night | HSI 235°, sat 100, 10 % |
| 6 | Romance | HSI 330°, sat 70, 40 % |

| Key | Effect | Pattern |
|---|---|---|
| Q | Cops | red ↔ blue every 400 ms |
| W | Television | cool tint, level 15–60 %, changes every 250–700 ms, occasional scene cut |
| E | Fire | hue 10–30°, level 35–75 %, every 300–500 ms |
| R | Candle | hue 30°, level 30–45 %, every 350–700 ms |
| T | Party | saturated color changes: Jump (new color every ~450 ms), Flow (glides around the palette), Beat (color on / dim, ~260 ms each); palettes Rainbow, Warm, Cool, Pink/Blue; each light runs its own sequence |
| Y | Breathe | brightness sine 10–80 %, 6 s period, current color |

- Looks send only the params that differ from the light's current state.
- A look pressed during blackout is sent to the light; Restore powers on at that look's brightness.
- Effects: tap again or Esc stops and returns to the look from before the effect. Grabbing a slider, a chip,
  or a look on a light takes that light out of the effect and leaves it where it is (other lights keep running).
  Power off, Blackout (master or per light) pause the effect on the dark lights; it resumes when they come back on.
  A timed effect keeps counting while paused. An effect started during blackout powers the light on.
- Lock disables look/effect keys and tiles (Esc and B still work).
- All writes are spaced ≥ 60 ms. Effects stay ≥ 10 % brightness and ≤ ~3 changes/s.
- **Effect settings** (panel under the effect tiles; pick the effect in "Settings for"). Edits apply live, persist per effect, Reset restores defaults, editable while disconnected:
  | Effect | Controls |
  |---|---|
  | Cops | Max brightness, Speed, Color A, Color B, Pattern (A/B · double flash · strobe with dark gaps) |
  | Television | Max brightness, Min brightness, Speed, Tint, Color strength, Scene cuts |
  | Fire | Max brightness, Min brightness, Speed, Base color, Color spread |
  | Candle | Max brightness, Min brightness, Speed, Color, Saturation |
  | Party | Max brightness, Min brightness, Speed, Colors, Style, Saturation, Run for |
  | Breathe | Max brightness, Min brightness, Cycle time |
- Speed scales step timing; any step is ≥ 200 ms regardless of speed.
- **Run for** (every effect): 0 = until stopped; otherwise the effect stops after that many seconds and the lights return
  to the look from before it. In a cue, the run time is set in the cue row.
- With several lights: Cops' "Multiple lights" setting alternates colors between lights (A on odd, B on even);
  Television, Fire and Candle run an independent random pattern on each light; the others stay in sync.
- Edit or add entries in `effects.js` (a look is a state; an effect is a generator of `{state, wait}` steps).

Connection: remembers the light, auto-connects on open, sends the handshake, echoes status frames like
the official app, and retries with backoff (1–30 s) after an unexpected drop.

## Protocol
See the header of `web/gvm-protocol.js`. Source: an Apple PacketLogger trace of the official iOS app
controlling the light; the extracted control frames (no other Bluetooth traffic) are in
[`protocol/gvm-800rgb-frames.json`](../protocol/gvm-800rgb-frames.json) and are used by `tests/`.

| | |
|---|---|
| Service | `00010203-0405-0607-0809-0a0b0c0d1910` |
| Control characteristic | `00010203-0405-0607-0809-0a0b0c0d2b10` (read, write without response, notify; described as "Ai-Thinker SPP") |
| Frame | `4C 54` · length · `00` · address `30` · command · payload · CRC-16/XMODEM (big-endian) |
| Set parameter | command `57`, payload `00 <param> 01 <value>` |
| Params | `00` power · `02` brightness % · `03` CCT ÷ 100 · `04` hue ÷ 5 · `05` saturation % · `06` mode (1 CCT, 2 HSI) |
| Light → app | `02` ack · `03` status every 5 s (params 0–8); the app echoes status with command `48` |
| Handshake | `4C 54 09 00 00 53 00 00 01 00 94 74` |

| Item | Status |
|---|---|
| Frame format, CRC-16/XMODEM | matches all 169 captured frames |
| Handshake, power, brightness, sliders | verified on hardware |
| CCT 3200–5600 K, hue (5° units), saturation, mode | encoders reproduce captured frames; driven via sliders on hardware |
| Brightness 0 % | not in capture (min seen 10 %); used as the fade floor |
| Params 0x01, 0x07, 0x08 | unknown, never written |
| Status echo required? | unknown; sent by default |

## Files
`web/index.html`, `styles.css`, `app.js` (UI), `ble.js` (connection), `gvm-protocol.js` (encoders/decoder),
`effects.js` (looks/effects), `setup.js` (environment checks, messages), `sw.js` + `manifest.webmanifest` +
`icons/` (installable, offline). `legacy/swift-explorer/` is the unused SwiftUI explorer.
