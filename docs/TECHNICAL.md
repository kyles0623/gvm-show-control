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
- Acknowledgements and resend: the light acknowledges every set that changes a value (cmd 0x02 with the param and
  value, seen within ~30–60 ms in real logs). It does not acknowledge a set to the value it already has, and it ignores
  changes while off. So the app expects an ack only for a change from the last value the light itself reported, while
  it is on. No ack within 500 ms → the command is sent once more. Still no ack, and nothing received since → the light
  is shown as "no reply" (about 1–2 s after the command).
- After "no reply", 6 s without anything from the light → the link is dropped and reconnected (otherwise 12 s; see below).
- Restore after reconnect: when a link drops, the app remembers what it last sent the light (including commands that may
  not have arrived). After reconnecting and the first status frame, it powers the light on/off to match and resends the
  color and brightness; a light that was running an effect is picked up by the effect. Changes made to other lights
  while it was away (e.g. a cue) are not replayed to it.
- Pre-show check (Check button): per light, connected? Lights that are on get a brightness dip (to 10 %, or +40 % if
  already low) and must acknowledge it within 1.5 s; then the level goes back. Lights that are off, fading or running an
  effect aren't flashed; they pass if anything arrived in the last 7 s. Cues that reference unpaired or disconnected
  lights are listed as warnings.
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
| 1 | Daylight | CCT 5600 K, 50 % |
| 2 | Tungsten | CCT 3200 K, 50 % |
| 3 | Sunset | HSI 25°, sat 90, 50 % |
| 4 | Moonlight | HSI 215°, sat 45, 25 % |
| 5 | Night | HSI 235°, sat 100, 10 % |
| 6 | Romance | HSI 330°, sat 70, 40 % |

| Key | Effect | Pattern |
|---|---|---|
| Q | Cops | red ↔ blue every 400 ms, 25 %; dim steps (A A / B B, strobe) 20 % |
| W | Television | cool tint, level 20–50 %, changes every 250–700 ms, occasional scene cut |
| E | Fire | hue 10–30°, level 20–35 %, every 300–500 ms |
| R | Candle | hue 30°, level 20–35 %, every 350–700 ms |
| T | Party | saturated color changes: Jump (new color every ~450 ms), Flow (glides around the palette), Beat (color on / dim, ~260 ms each); palettes Rainbow, Warm, Cool, Pink/Blue; level 20–30 %; each light runs its own sequence |
| Y | Breathe | brightness sine 20–50 %, 6 s period, current color |

Default max brightness is kept low: fast effects (Cops, Party) 25–30 %, saturated colors (Fire, Candle) under 40 %,
others 50 %. Default min brightness is 20 % for every effect. Each effect's settings panel can change both.

- Looks send only the params that differ from the light's current state.
- A look pressed during blackout is sent to the light; Restore powers on at that look's brightness.
- Effects run per light: each light runs at most one effect, and different lights can run different effects at once.
  Lights started together share one run (in sync, Cops A/B alternation). Starting an effect on a light moves it out of
  its previous run; the rest of that run keeps going.
- The board follows the selection: look/effect tiles are lit when every selected light has them, dashed when only some do.
  The effect settings panel shows the selected light's running values; edits apply to the selected lights' runs and are
  saved as the defaults for next time.
- Custom effects (Effects tab, `localStorage['gvm.customfx']`): `{id, name, steps: [{mode, cct|hue+sat, bri, hold s,
  fade s}]}`, looped. A fade is sent as intermediate steps of ≥ 250 ms (hue the short way round; White↔Color dips
  through dark); holds are at least 60 ms (`FAST_STEP_MS`, the write gap), and a step that changes several values takes
  60 ms per value regardless (the editor marks shorter holds in orange). Built-in effects keep ≥ 200 ms steps. Settings: Speed (0.25–4×) and Run for. The running effect re-reads the
  steps every cycle, so edits apply live.
  Level, Hold and Fade may be random ranges (`briTo`, `holdTo`, `fadeTo` as upper bounds); each time the step runs a
  value is picked uniformly from the range (Level as a whole %). Cycle times with ranges are shown as averages. Effect ids are `custom:<id>`; a cue that uses a deleted custom effect skips it.
- Gels: approximate gel-style colors (`GELS` in effects.js). Corrections are color temperature (Full CTO 3200 K,
  ¾ 3500, ½ 3800, ¼ 4500, ⅛ 4900, ½ CTB on tungsten 4100, Full CTB 5600); colors are hue/saturation. Applying a gel
  changes color only and crossfades with the Fade time.
- Cues record every running effect with its lights (`effects: [{id, params, lightIds}]`; single-effect cues keep `effect`).
- Effects: tapping a lit effect stops it on the selected lights and returns them to their look from before; Esc stops all effects. Grabbing a slider, a chip,
  or a look on a light takes that light out of the effect and leaves it where it is (other lights keep running).
  Power off, Blackout (master or per light) pause the effect on the dark lights; it resumes when they come back on.
  A timed effect keeps counting while paused. An effect started during blackout powers the light on.
- Lock disables look/effect keys and tiles (Esc and B still work).
- All writes are spaced ≥ 60 ms. Effects stay ≥ 10 % brightness and ≤ ~3 changes/s.
- **Effect settings** (panel under the effect tiles; pick the effect in "Settings for"). Edits apply live, persist per effect, Reset restores defaults, editable while disconnected:
  | Effect | Controls |
  |---|---|
  | Cops | Max brightness, Dim brightness, Speed, Color A, Color B, Pattern (A/B · double flash · strobe with dark gaps) |
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
