# Changelog

What changed in each version of GVM Show Control. The version you're running is shown in the app's
lower-right corner (and in Settings → About).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every commit to `main` bumps
the minor version (see [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog)); add your notes under
**Unreleased** and the commit hook moves them under the new version number.

## [Unreleased]

### Added
- Setup, Help, connection-problem messages and the README now say the light must be in App mode.
- Anonymous visit counting on the hosted app with GoatCounter (no cookies, no personal data). Settings → About →
  "Count my visits" turns it off. Local copies (localhost) are never counted.
- Effects tab: click a step's color square to open a color picker (color field for hue and saturation,
  strip for white 3200–5600 K). Picks snap to what the light accepts.
- Effects tab: Level, Hold and Fade can each be a random range (the ~ button next to the value). A new value
  is picked from the range every time the step runs, for natural-looking flicker.
- Effects tab: **Start from…** templates. First one: **Paparazzi** (camera flashes: dim pauses of random length,
  short white flashes, sometimes a double flash), built from editable steps with random ranges.

### Changed
- Custom effects can hold a step for as little as 0.06 s (was 0.2 s), for fast flicker and strobe-like effects.
  A step needs 0.06 s per value it changes (brightness only: 0.06 s; color and brightness: up to 0.24 s); shorter
  holds are shown in orange. The built-in effects keep their 0.2 s minimum.

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
