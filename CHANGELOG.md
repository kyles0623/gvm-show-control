# Changelog

What changed in each version of GVM Show Control. The version you're running is shown in the app's
lower-right corner (and in Settings → About).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every commit to `main` bumps
the minor version (see [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog)); add your notes under
**Unreleased** and the commit hook moves them under the new version number.

## [Unreleased]

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
