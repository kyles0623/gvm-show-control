// Generated from CHANGELOG.md by scripts/whatsnew.mjs (the commit hook runs it). Don't edit by hand.
// "What's new": released versions, newest first; each with its Added / Changed / Fixed notes.
export const VERSIONS = [
 {
  "version": "1.21.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Presets",
      "text": "(Shift+1–9): a look, and optionally an effect, for each light by its name (MAIN, LEFT, BAR…), for whole-rig looks like BAR-FOCUSED or PARTY. + Save preset (under the looks on the Show tab, or the Looks tab) saves every connected light under its name; applying a preset sets every light with a matching name (Fade time), starts the saved effects (lights with the same effect run in sync) and leaves other lights alone. Because entries match by name, presets keep working after re-pairing or on another computer. Edit on the Looks tab: rename, apply, update from the lights, remove or add a light, reorder, delete. Presets belong to the open show and are in backups."
     }
    ]
   }
  ]
 },
 {
  "version": "1.20.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "Effects that are too fast for the selected light say so: the tile reads \"too fast\", hovering shows why right away (the light fades into each change; lights with the effect built in still run it), and tapping explains it too."
     }
    ]
   }
  ]
 },
 {
  "version": "1.19.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "amaran lights: built-in effects that need faster changes than the light can show are greyed out for it (Lightning, Cop Car, Candle, Bad Bulb, Paparazzi, Fire, Welding, Ambulance, Fire Engine, Strobe, Strobe II). The Ace 25c glides into each change, so its cleanest step is 500 ms (speed test); TV, Party, Disco, Explosion, Pulsing, Fireworks, CCT Loop, Hue Loop and SOS stay. With GVM and amaran lights selected together, a fast effect runs on the GVM lights only."
     }
    ]
   }
  ]
 },
 {
  "version": "1.18.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Effect speed test",
      "text": "(Settings → Lights, shown when a light without built-in effects is paired): flashes the light at 500, 300, 200, 150 and 100 ms; pick the fastest that still looks clean, and simulated effects on that kind of light never step faster. amaran lights started at 250 ms (the Ace 25c glides into each change, so faster steps blur)."
     }
    ]
   }
  ]
 },
 {
  "version": "1.17.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Fixed",
    "items": [
     {
      "title": "",
      "text": "Simulated Cop Car looked pink/purple on the amaran Ace 25c: the light glides between colors by itself, so quick red ↔ blue switches showed the in-between colors. Color changes in the simulated effects (Cop Car, Party, Disco, Fireworks, Ambulance, Fire Engine) now happen while the light is dark, and each color is held longer."
     }
    ]
   }
  ]
 },
 {
  "version": "1.16.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Supported lights",
      "text": "(Settings → Lights, Help, and the setup screen): each supported brand and model with a product photo from the maker's site, whether it's verified on hardware, what works, how it shows in the device list and what to do before pairing. Also in the README."
     }
    ]
   }
  ]
 },
 {
  "version": "1.15.0",
  "date": "2026-11-02",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "amaran Ace 25c support (untested)",
      "text": "pairing an amaran light that isn't set up asks first, then joins it to the app's own Bluetooth Mesh network (kept in this browser and in backups) and controls on/off, brightness, white (2300-10,000 K) and color. Built-in GVM effects are hidden for it. Not yet checked on a real light; the Debug log shows every setup step. Undo on the light: Bluetooth menu → hold Press to Reset. Light commands ported from wesbos/amaran-BLE-control (MIT); mesh layer written from the Bluetooth Mesh Profile spec and tested against its sample data."
     },
     {
      "title": "Simulated built-in effects",
      "text": "on lights without the GVM light's 20 built-in effects (amaran), the effect tiles still work: the app plays an approximation of each effect (Cop Car, Candle, Fire, Strobe, SOS, …) using its brightness, color temperature, cycle and color settings. Steps are at least 100 ms apart. A mixed selection runs the real effect on GVM lights and the simulation on the others. Mesh lights now get each look in one command."
     },
     {
      "title": "",
      "text": "Settings → Lights shows each light's brand and whether its support is verified."
     },
     {
      "title": "Edit show",
      "text": "(My show ▾ → Edit on the open show): rename the show and choose which effect tiles, App effects and looks its Show tab offers, and their order (All / None / Default per list). Keys Q–Y and 1–9 follow the new order. Each show keeps its own layout; it's in backups too. New looks and effects appear at the end unless hidden."
     },
     {
      "title": "",
      "text": "tools/ble-probe.html: a read-only page that lists what a Bluetooth light offers to the browser (services, characteristics, model and firmware strings), with a filter for Bluetooth Mesh lights and an optional scan. Never writes."
     }
    ]
   },
   {
    "type": "Changed",
    "items": [
     {
      "title": "Copy to…",
      "text": "opens a box: tick the lights (or All / a group) and what to copy: color, brightness, on/off. The choice is remembered."
     },
     {
      "title": "Light drivers",
      "text": "(groundwork for other brands): each kind of light is now a driver (web/drivers.js) that says how to find it, what it can do (color temperature range, color, built-in effects) and how to encode commands. The app sends every command through the light's driver, and controls follow the selected light's abilities. GVM is the only driver so far and works as before; saved lights are treated as GVM."
     }
    ]
   }
  ]
 },
 {
  "version": "1.14.0",
  "date": "2026-11-01",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Light groups",
      "text": "name a set of lights (Settings → Lights → Groups, or double-click a group chip to edit). Each group gets a chip at the top; click it to control those lights, Shift-click to add them to the selection. Groups are in backups (mapped onto your lights on import)."
     },
     {
      "title": "Copy to…",
      "text": "(Light reports card, with 2+ lights): gives other lights, a group, or all of them the selected light's color, brightness and power, using the Fade time."
     },
     {
      "title": "Grand master",
      "text": "fader (Show tab, under Blackout): scales every light's brightness, including effects and cues, while looks, cues and the sliders keep their own levels. Double-click for 100%. Remembered between sessions."
     },
     {
      "title": "Cue numbers and point cues",
      "text": "cues have numbers; Record after a cue inserts one between (2.5 between 2 and 3), typing a number moves a cue, Renumber sets 1, 2, 3… Existing cue lists are numbered 1, 2, 3… on first load."
     },
     {
      "title": "Cue notes",
      "text": "a notes line per cue (e.g. \"GO on 'goodnight'\"), shown under Current and Next in the cue bar."
     },
     {
      "title": "Shows",
      "text": "My show ▾ (top right) keeps several shows, each with its own looks, cues and Effects-tab effects. New, duplicate, rename, delete; opening one reloads the app. Lights, groups, effect settings and preferences are shared."
     }
    ]
   }
  ]
 },
 {
  "version": "1.13.0",
  "date": "2026-10-31",
  "sections": [
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "Cue list: the Auto-GO s box is now Next cue in s (blank shows \"GO\": wait for the GO button), with a clearer tooltip; the countdown reads \"next cue in 3.0 s\"."
     }
    ]
   }
  ]
 },
 {
  "version": "1.12.0",
  "date": "2026-10-31",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Backup export / import",
      "text": "(Settings → Backup): saves looks, cues, Effects-tab effects, effect settings and preferences to a JSON file, and loads them back, in this browser or another one. Import can add to what's there or replace it, and maps the backup's lights onto yours so cues keep their per-light settings."
     }
    ]
   }
  ]
 },
 {
  "version": "1.11.0",
  "date": "2026-10-31",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Gel Reset",
      "text": "button next to the Gel menu: takes the gel off the selected light(s), back to the color they had before it (brightness stays, uses the Fade time)."
     }
    ]
   },
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "The Gel menu now keeps showing the gel that's on the selected light(s). Changing the color any other way (sliders, swatches, a look, a cue, an effect) clears it."
     },
     {
      "title": "",
      "text": "Effect tiles are bigger and taller, with names shrunk to fit on one line."
     }
    ]
   }
  ]
 },
 {
  "version": "1.9.0",
  "date": "2026-10-31",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "What's new",
      "text": "(version number, Help, Settings, the after-update notice) opens an in-app list of the best recent features with where to find them, and a link to this full changelog at the bottom."
     }
    ]
   }
  ]
 },
 {
  "version": "1.7.0",
  "date": "2026-10-30",
  "sections": [
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "While a built-in effect runs, the Brightness slider and the ↑/↓ keys set the effect's brightness instead of taking the light out of the effect, so the effect keeps running and its tile can still be tapped to stop it. App effects (Breathe, custom) still stop when you move Brightness, since they set brightness themselves."
     }
    ]
   }
  ]
 },
 {
  "version": "1.6.0",
  "date": "2026-10-30",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "The light's 20 built-in effects",
      "text": "(tiles in the Effects column; a menu in the cue panel): Lightning, Cop Car, Candle, TV, Bad Bulb, Party, Disco, Paparazzi, Explosion, Pulsing, Fire, Fireworks, Welding, CCT Loop, Hue Loop, Ambulance, Fire Engine, SOS, Strobe, Strobe II. They run on the light itself (smooth, and they keep going if Bluetooth drops), per light, with the same settings as the official app (brightness; color temperature, cycle time or color where the app has them), and can be recorded into cues. Decoded from a capture of the official app."
     },
     {
      "title": "",
      "text": "Connection-lost messages point out that switching the light out of App mode (with its mode button) disconnects it."
     },
     {
      "title": "",
      "text": "Debug tab: Status watch, a live table of every value each light reports, with changes highlighted and the three undecoded values (p1, p7, p8) logged whenever they change. Read-only; it sends nothing."
     },
     {
      "title": "",
      "text": "Setup, Help, connection-problem messages and the README now say the light must be in App mode (press the mode button until the display shows APP)."
     },
     {
      "title": "",
      "text": "Anonymous visit counting on the hosted app with GoatCounter (no cookies, no personal data). Settings → About → \"Count my visits\" turns it off. Local copies (localhost) are never counted."
     },
     {
      "title": "",
      "text": "Effects tab: click a step's color square to open a color picker (color field for hue and saturation, strip for white 3200–5600 K). Picks snap to what the light accepts."
     },
     {
      "title": "",
      "text": "Effects tab: Level, Hold and Fade can each be a random range (the ~ button next to the value). A new value is picked from the range every time the step runs, for natural-looking flicker."
     }
    ]
   },
   {
    "type": "Changed",
    "items": [
     {
      "title": "The Effects column now shows the light's 20 built-in effects",
      "text": "as its main tiles (keys Q–Y start the first six). The app's own effects are a secondary \"App effects\" row: Breathe and your custom effects."
     },
     {
      "title": "",
      "text": "Custom effects can hold a step for as little as 0.06 s (was 0.2 s), for fast flicker and strobe-like effects. A step needs 0.06 s per value it changes (brightness only: 0.06 s; color and brightness: up to 0.24 s); shorter holds are shown in orange. The built-in effects keep their 0.2 s minimum."
     }
    ]
   },
   {
    "type": "Removed",
    "items": [
     {
      "title": "",
      "text": "The app's Cops, Television, Fire, Candle and Party effects: the light has its own (Cop Car, TV, Fire, Candle, Party). Saved cues and settings that used them are moved to the built-in ones."
     }
    ]
   },
   {
    "type": "Fixed",
    "items": [
     {
      "title": "",
      "text": "A light whose Bluetooth link dropped while its services were being read was treated as \"not a supported light\" and forgotten. It is now a normal connection failure: the app retries and keeps the light."
     },
     {
      "title": "",
      "text": "If the light connects but never lists its services (a stuck Bluetooth link), the app no longer waits forever: after 10 s it drops the link and retries."
     },
     {
      "title": "",
      "text": "Lights that use a protocol address other than 0x30 (e.g. 0x33) are now controlled: the app uses the address each light reports (from its handshake reply, or its first status if it doesn't answer the handshake), as the official app does."
     }
    ]
   }
  ]
 },
 {
  "version": "1.3.0",
  "date": "2026-10-29",
  "sections": [
   {
    "type": "Added",
    "items": [
     {
      "title": "Pre-show check",
      "text": "(Check button, top right): confirms every light is connected and answering. Each light that is on dims for a moment, one at a time, so you can see which is which. Also flags cues that use lights that aren't connected or no longer paired."
     },
     {
      "title": "Custom effects",
      "text": "(new Effects tab): build your own looping effect from steps (color, brightness, hold time, fade time). They appear on the Show tab under the built-in effects, run per light, can be recorded into cues, and pick up edits while running."
     },
     {
      "title": "Gel menu",
      "text": "in the color card: approximate gel-style colors (CTO/CTB corrections as color temperature; ambers, pinks, lavenders, blues, greens as hue/saturation). Changes color only, keeps brightness, uses the Fade time. Also usable for custom effect steps."
     },
     {
      "title": "Lost commands are resent.",
      "text": "The light acknowledges every change; if an acknowledgement doesn't arrive within 0.5 s the command is sent again."
     },
     {
      "title": "Faster \"no reply\".",
      "text": "A light that stops answering is flagged within about 2 s (was 7 s) and reconnected after about 6 s of silence (was 12 s)."
     },
     {
      "title": "Restore after reconnect.",
      "text": "A light that drops out and reconnects gets back what the app last sent it (power, color, brightness); an effect running on it resumes."
     },
     {
      "title": "",
      "text": "Cops: Dim brightness setting for the dim steps of the A A / B B and strobe patterns."
     },
     {
      "title": "",
      "text": "\"What's new\" and \"Report a problem\" links in Help and Settings; a one-time \"Updated to …\" notice after an update."
     },
     {
      "title": "",
      "text": "Issue templates for bug reports, feature requests and reports about other GVM lights; contributing and security notes."
     }
    ]
   },
   {
    "type": "Changed",
    "items": [
     {
      "title": "",
      "text": "Default minimum brightness is 20 % for every effect (Cops dim steps were 10 %)."
     }
    ]
   },
   {
    "type": "Fixed",
    "items": [
     {
      "title": "",
      "text": "With a single light, a Bluetooth dropout ended any running effect; effects now survive a dropout."
     }
    ]
   }
  ]
 }
];
