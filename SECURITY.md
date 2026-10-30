# Security

GVM Show Control runs in your browser. It has no server and no accounts. Your lights, looks, cues and effects
never leave the browser. The hosted app loads GoatCounter, a cookie-free visit counter that records the page,
browser, screen size and country of a visit (no personal data); Settings → About → "Count my visits" turns it off,
and it never counts local copies (localhost). Settings, looks, cues and custom effects are stored
in your browser's local storage.

The app refuses to write to Bluetooth characteristics that look like firmware update (OTA/DFU) channels.

If you find a security problem, please report it privately through GitHub's
[private vulnerability reporting](https://github.com/kyles0623/gvm-show-control/security/advisories/new)
rather than a public issue.
