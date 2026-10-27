# Protocol captures

`gvm-800rgb-frames.json` holds the control traffic between the official GVM iOS app and a GVM 800-RGB:
every ATT Write Command (app → light) and Notification (light → app) on the control characteristic,
with timestamps and decoded meaning. The tests in `tests/` check the encoders against it.

## Contributing a capture for another model
Raw Bluetooth logs (`.pklg`, `btsnoop`) record **every** Bluetooth device near your phone, so please
don't upload them. Instead:

1. Capture the official app with Apple's PacketLogger (iOS: install the Bluetooth logging profile from
   developer.apple.com/bug-reporting/profiles-and-logs, connect the iPhone, File → New iOS Trace) or an
   Android HCI snoop log.
2. Change one setting at a time with a few seconds' pause (power, brightness, CCT, hue, saturation),
   and write down the order.
3. Export or copy only the ATT writes/notifications to the light's control characteristic, in the same
   shape as `gvm-800rgb-frames.json`, and open an issue or pull request with the model name and your notes.
