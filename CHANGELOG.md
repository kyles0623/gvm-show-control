# Changelog

What changed in each version of GVM Show Control. The version you're running is shown in the app's
lower-right corner (and in Settings → About).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every commit to `main` bumps
the minor version (see [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog)); add your notes under
**Unreleased** and the commit hook moves them under the new version number.

## [Unreleased]

### Added
- **One Bluetooth connection for all amaran lights.** The app connects to one amaran light and reaches the others
  through the mesh (each light is still controlled on its own, by its address), so more amaran lights no longer use up
  the computer's Bluetooth connections. If that light goes off or out of range, the app switches to another amaran
  light by itself. A light reached this way shows "via <light>" in its status.
- **Lights grouped by brand** in the top bar: GVM lights together, amaran lights together, each group led by its brand
  name (click it to control all lights of that brand, Shift-click to add them). Tab and Settings → Lights follow the
  same order. When there are more chips than fit, they get their own row under the top bar.
- **Guide: set up a small theatre lighting system** (https://kyles0623.github.io/gvm-show-control/guide/): where to
  place 3–6 lights around a small stage, with stage-plot diagrams, then how to name and group them in the app and build
  looks, presets and a cue list. Linked from Help.
- **Lighting a small theatre for under $1,000** (https://kyles0623.github.io/gvm-show-control/guide/under-1000/): a
  shopping list for a five-light rig (3× GVM 800D-RGB, 2× amaran Ace 25c, stands, sandbags, chargers, cords, tape) with
  links, where each light goes, power and battery notes, and smaller and bigger budgets.
- **Lights roadmap** (docs/LIGHTS-ROADMAP.md): the plan for adding Neewer, Godox, generic RGB strips, Govee, Nanlite and
  Yongnuo lights from public documentation, and how the app will mark them as untested.
- **Untested support (β) for six more kinds of light**, built from public documentation and open-source projects:
  Neewer (older protocol: RGB660 PRO, RGB176 A1, RGB1, TL60 RGB, CB60B and more), Godox Bluetooth Mesh lights (184
  models; they share the one mesh connection with amaran lights), ELK-BLEDOM / LEDBLE RGB strips, older Govee Bluetooth
  bulbs and strips, Nanlite (NANLINK Bluetooth) and the Yongnuo YN-360. Nobody has tried these on a real light yet. The
  app asks once before adding the first light of each brand, marks them with β, and has a **Report result** link in
  Settings → Lights. Lights that differ by model get a model picker there (it sets the white range and whether color
  is offered). Most of these lights don't answer, so the pre-show check flashes them and asks you to look.

### Changed
- **amaran Ace 25c** is now marked “reported working” instead of untested.
- **What's new** lists the changes version by version (newest open, the others folded), with New / Changed / Fixed
  under each. It's built from this changelog at every commit (scripts/whatsnew.mjs, run by the commit hook). After an
  update, versions you haven't seen yet are marked "new to you".

### Fixed
- Changelog: notes from 1.12.0 to 1.21.0 were filed one version late (and two releases were both called 1.15.0);
  they're now under the version each change actually shipped in.

## [1.21.0] - 2026-11-02

### Added
- **Presets** (Shift+1–9): a look, and optionally an effect, for each light by its **name** (MAIN, LEFT, BAR…), for
  whole-rig looks like BAR-FOCUSED or PARTY. **+ Save preset** (under the looks on the Show tab, or the Looks tab)
  saves every connected light under its name; applying a preset sets every light with a matching name (Fade time),
  starts the saved effects (lights with the same effect run in sync) and leaves other lights alone. Because entries
  match by name, presets keep working after re-pairing or on another computer. Edit on the Looks tab: rename, apply,
  update from the lights, remove or add a light, reorder, delete. Presets belong to the open show and are in backups.

## [1.20.0] - 2026-11-02

### Changed
- Effects that are too fast for the selected light say so: the tile reads "too fast", hovering shows why right away
  (the light fades into each change; lights with the effect built in still run it), and tapping explains it too.

## [1.19.0] - 2026-11-02

### Changed
- amaran lights: built-in effects that need faster changes than the light can show are greyed out for it (Lightning,
  Cop Car, Candle, Bad Bulb, Paparazzi, Fire, Welding, Ambulance, Fire Engine, Strobe, Strobe II). The Ace 25c glides
  into each change, so its cleanest step is 500 ms (speed test); TV, Party, Disco, Explosion, Pulsing, Fireworks,
  CCT Loop, Hue Loop and SOS stay. With GVM and amaran lights selected together, a fast effect runs on the GVM lights only.

## [1.18.0] - 2026-11-02

### Added
- **Effect speed test** (Settings → Lights, shown when a light without built-in effects is paired): flashes the light
  at 500, 300, 200, 150 and 100 ms; pick the fastest that still looks clean, and simulated effects on that kind of
  light never step faster. amaran lights started at 250 ms (the Ace 25c glides into each change, so faster steps blur).

## [1.17.0] - 2026-11-02

### Fixed
- Simulated Cop Car looked pink/purple on the amaran Ace 25c: the light glides between colors by itself, so quick
  red ↔ blue switches showed the in-between colors. Color changes in the simulated effects (Cop Car, Party, Disco,
  Fireworks, Ambulance, Fire Engine) now happen while the light is dark, and each color is held longer.

## [1.16.0] - 2026-11-02

### Added
- **Supported lights** (Settings → Lights, Help, and the setup screen): each supported brand and model with a product
  photo from the maker's site, whether it's verified on hardware, what works, how it shows in the device list and
  what to do before pairing. Also in the README.

## [1.15.0] - 2026-11-02

(This release's number was shown as 1.14.0 for one build that morning.)

### Added
- **amaran Ace 25c support (untested)**: pairing an amaran light that isn't set up asks first, then joins it to the
  app's own Bluetooth Mesh network (kept in this browser and in backups) and controls on/off, brightness, white
  (2300-10,000 K) and color. Built-in GVM effects are hidden for it. Not yet checked on a real light; the Debug log
  shows every setup step. Undo on the light: Bluetooth menu → hold Press to Reset. Light commands ported from
  wesbos/amaran-BLE-control (MIT); mesh layer written from the Bluetooth Mesh Profile spec and tested against its
  sample data.
- **Simulated built-in effects**: on lights without the GVM light's 20 built-in effects (amaran), the effect tiles
  still work: the app plays an approximation of each effect (Cop Car, Candle, Fire, Strobe, SOS, …) using its
  brightness, color temperature, cycle and color settings. Steps are at least 100 ms apart. A mixed selection runs the
  real effect on GVM lights and the simulation on the others. Mesh lights now get each look in one command.
- Settings → Lights shows each light's brand and whether its support is verified.
- **Edit show** (My show ▾ → Edit on the open show): rename the show and choose which effect tiles, App effects and
  looks its Show tab offers, and their order (All / None / Default per list). Keys Q–Y and 1–9 follow the new order.
  Each show keeps its own layout; it's in backups too. New looks and effects appear at the end unless hidden.
- `tools/ble-probe.html`: a read-only page that lists what a Bluetooth light offers to the browser (services,
  characteristics, model and firmware strings), with a filter for Bluetooth Mesh lights and an optional scan. Never writes.

### Changed
- **Copy to…** opens a box: tick the lights (or All / a group) and what to copy: color, brightness, on/off.
  The choice is remembered.
- **Light drivers** (groundwork for other brands): each kind of light is now a driver (`web/drivers.js`) that says how
  to find it, what it can do (color temperature range, color, built-in effects) and how to encode commands. The app
  sends every command through the light's driver, and controls follow the selected light's abilities. GVM is the only
  driver so far and works as before; saved lights are treated as GVM.

## [1.14.0] - 2026-11-01

### Added
- **Light groups**: name a set of lights (Settings → Lights → Groups, or double-click a group chip to edit). Each
  group gets a chip at the top; click it to control those lights, Shift-click to add them to the selection. Groups are
  in backups (mapped onto your lights on import).
- **Copy to…** (Light reports card, with 2+ lights): gives other lights, a group, or all of them the selected light's
  color, brightness and power, using the Fade time.
- **Grand master** fader (Show tab, under Blackout): scales every light's brightness, including effects and cues,
  while looks, cues and the sliders keep their own levels. Double-click for 100%. Remembered between sessions.
- **Cue numbers and point cues**: cues have numbers; Record after a cue inserts one between (2.5 between 2 and 3),
  typing a number moves a cue, **Renumber** sets 1, 2, 3… Existing cue lists are numbered 1, 2, 3… on first load.
- **Cue notes**: a notes line per cue (e.g. "GO on 'goodnight'"), shown under Current and Next in the cue bar.
- **Shows**: **My show ▾** (top right) keeps several shows, each with its own looks, cues and Effects-tab effects.
  New, duplicate, rename, delete; opening one reloads the app. Lights, groups, effect settings and preferences are shared.

## [1.13.0] - 2026-10-31

### Changed
- Cue list: the **Auto-GO s** box is now **Next cue in s** (blank shows "GO": wait for the GO button), with a clearer
  tooltip; the countdown reads "next cue in 3.0 s".

## [1.12.0] - 2026-10-31

### Added
- **Backup export / import** (Settings → Backup): saves looks, cues, Effects-tab effects, effect settings and
  preferences to a JSON file, and loads them back, in this browser or another one. Import can add to what's
  there or replace it, and maps the backup's lights onto yours so cues keep their per-light settings.

## [1.11.0] - 2026-10-31

### Added
- **Gel Reset** button next to the Gel menu: takes the gel off the selected light(s), back to the color they had
  before it (brightness stays, uses the Fade time).

### Changed
- The Gel menu now keeps showing the gel that's on the selected light(s). Changing the color any other way
  (sliders, swatches, a look, a cue, an effect) clears it.
- Effect tiles are bigger and taller, with names shrunk to fit on one line.

## [1.9.0] - 2026-10-31

### Added
- **What's new** (version number, Help, Settings, the after-update notice) opens an in-app list of the best recent
  features with where to find them, and a link to this full changelog at the bottom.

## [1.7.0] - 2026-10-30

### Changed
- While a built-in effect runs, the Brightness slider and the ↑/↓ keys set the effect's brightness instead of taking
  the light out of the effect, so the effect keeps running and its tile can still be tapped to stop it. App effects
  (Breathe, custom) still stop when you move Brightness, since they set brightness themselves.

## [1.6.0] - 2026-10-30

These notes also cover versions 1.4.0 and 1.5.0, which were released without their own notes.

### Added
- **The light's 20 built-in effects** (tiles in the Effects column; a menu in the cue panel): Lightning,
  Cop Car, Candle, TV, Bad Bulb, Party, Disco, Paparazzi, Explosion, Pulsing, Fire, Fireworks, Welding, CCT Loop,
  Hue Loop, Ambulance, Fire Engine, SOS, Strobe, Strobe II. They run on the light itself (smooth, and they keep
  going if Bluetooth drops), per light, with the same settings as the official app (brightness; color temperature,
  cycle time or color where the app has them), and can be recorded into cues. Decoded from a capture of the
  official app.
- Connection-lost messages point out that switching the light out of App mode (with its mode button) disconnects it.
- Debug tab: **Status watch**, a live table of every value each light reports, with changes highlighted and the
  three undecoded values (p1, p7, p8) logged whenever they change. Read-only; it sends nothing.
- Setup, Help, connection-problem messages and the README now say the light must be in App mode (press the mode
  button until the display shows APP).
- Anonymous visit counting on the hosted app with GoatCounter (no cookies, no personal data). Settings → About →
  "Count my visits" turns it off. Local copies (localhost) are never counted.
- Effects tab: click a step's color square to open a color picker (color field for hue and saturation,
  strip for white 3200–5600 K). Picks snap to what the light accepts.
- Effects tab: Level, Hold and Fade can each be a random range (the ~ button next to the value). A new value
  is picked from the range every time the step runs, for natural-looking flicker.

### Changed
- **The Effects column now shows the light's 20 built-in effects** as its main tiles (keys Q–Y start the first six).
  The app's own effects are a secondary "App effects" row: Breathe and your custom effects.
- Custom effects can hold a step for as little as 0.06 s (was 0.2 s), for fast flicker and strobe-like effects.
  A step needs 0.06 s per value it changes (brightness only: 0.06 s; color and brightness: up to 0.24 s); shorter
  holds are shown in orange. The built-in effects keep their 0.2 s minimum.

### Removed
- The app's Cops, Television, Fire, Candle and Party effects: the light has its own (Cop Car, TV, Fire, Candle,
  Party). Saved cues and settings that used them are moved to the built-in ones.

### Fixed
- A light whose Bluetooth link dropped while its services were being read was treated as "not a supported light"
  and forgotten. It is now a normal connection failure: the app retries and keeps the light.
- If the light connects but never lists its services (a stuck Bluetooth link), the app no longer waits forever: after
  10 s it drops the link and retries.
- Lights that use a protocol address other than 0x30 (e.g. 0x33) are now controlled: the app uses the address each
  light reports (from its handshake reply, or its first status if it doesn't answer the handshake), as the official
  app does.

## [1.3.0] - 2026-10-29

### Added
- **Pre-show check** (Check button, top right): confirms every light is connected and answering. Each light that is
  on dims for a moment, one at a time, so you can see which is which. Also flags cues that use lights that aren't
  connected or no longer paired.
- **Custom effects** (new Effects tab): build your own looping effect from steps (color, brightness, hold time,
  fade time). They appear on the Show tab under the built-in effects, run per light, can be recorded into cues,
  and pick up edits while running.
- **Gel menu** in the color card: approximate gel-style colors (CTO/CTB corrections as color temperature;
  ambers, pinks, lavenders, blues, greens as hue/saturation). Changes color only, keeps brightness, uses the
  Fade time. Also usable for custom effect steps.
- **Lost commands are resent.** The light acknowledges every change; if an acknowledgement doesn't arrive within
  0.5 s the command is sent again.
- **Faster "no reply".** A light that stops answering is flagged within about 2 s (was 7 s) and reconnected after
  about 6 s of silence (was 12 s).
- **Restore after reconnect.** A light that drops out and reconnects gets back what the app last sent it
  (power, color, brightness); an effect running on it resumes.
- Cops: **Dim brightness** setting for the dim steps of the A A / B B and strobe patterns.
- "What's new" and "Report a problem" links in Help and Settings; a one-time "Updated to …" notice after an update.
- Issue templates for bug reports, feature requests and reports about other GVM lights; contributing and
  security notes.

### Changed
- Default minimum brightness is 20 % for every effect (Cops dim steps were 10 %).

### Fixed
- With a single light, a Bluetooth dropout ended any running effect; effects now survive a dropout.

## [1.2.0] - 2026-10-29

### Changed
- Default brightness is 50 %: the built-in looks Daylight, Tungsten and Sunset start at 50 % (were 80 %, 80 %, 60 %).
  Looks you already have keep their levels.
- Lower effect defaults: Cops 25 %, Party 30 %, Fire 35 %, Candle 35 %, Television 50 %, Breathe 50 %.

## [1.1.0] - 2026-10-28

### Added
- **Party** effect (rainbow / warm / cool / pink-blue palettes; jump, flow or beat).
- **Independent effects per light**: different lights can run different effects at the same time. The board
  (effect and look highlights, effect settings) follows the selected light. Cues record and replay every running
  effect with its lights.
- **Blackout one light**: with 2+ lights, a button per light under the master Blackout.
- **Tab / Shift+Tab** cycles the selection All → each light.
- **Rename lights in place**: double-click a light chip (or the light name in the header).
- **+ Add light** button next to the light chips.
- Version number in the lower-right corner; automatic version bump on every commit.
- Silent-link watchdog: a light that stops sending anything is dropped and reconnected.

### Changed
- Editing one light by hand no longer stops an effect running on other lights.
- Effects pause while their light is off or blacked out and resume when it comes back on.

### Removed
- Lightning effect (replaced by Party). Cues that used it skip the effect.

## [1.0.0] - 2026-10-27

First public release (including same-day updates).
- Web Bluetooth controller for the GVM 800-RGB: power, brightness, white (3200–5600 K) and color (hue/saturation).
- Several lights at once, with chips to choose which lights the controls change.
- Looks library (keys 1–9) with color crossfades; Blackout / Restore with optional fades, confirmed with the light.
- Cue list with GO / Back, fades, auto-follow and effects; cue panel on the Show tab and a pop-out window.
- Effects: Cops, Television, Fire, Candle, Lightning, Breathe, with their own settings and run times.
- First-run setup that checks the browser and Bluetooth; installable, works offline; lock and dim modes.

[Unreleased]: https://github.com/kyles0623/gvm-show-control/compare/main...HEAD
