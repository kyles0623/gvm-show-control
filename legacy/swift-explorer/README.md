# Legacy: SwiftUI BLE explorer (unused)

The first attempt: a macOS SwiftUI app used to discover the light's GATT services before the web app
existed. It is kept for reference only and is not maintained. Building it needs full Xcode and XcodeGen:

```
cd legacy/swift-explorer && ./build.sh
```

`GVMProtocol.swift` is a stub; the working protocol lives in `web/gvm-protocol.js`.
