# Security

GVM Show Control runs entirely in your browser. It has no server, no accounts and no analytics: the only
thing it sends anywhere is Bluetooth commands to your light. Settings, looks, cues and custom effects are stored
in your browser's local storage.

The app refuses to write to Bluetooth characteristics that look like firmware update (OTA/DFU) channels.

If you find a security problem, please report it privately through GitHub's
[private vulnerability reporting](https://github.com/kyles0623/gvm-show-control/security/advisories/new)
rather than a public issue.
