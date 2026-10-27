#!/bin/bash
# Generate the Xcode project, build Debug, and launch the app.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found; installing with Homebrew"
  brew install xcodegen
fi

xcodegen generate
xcodebuild -project GVMLight.xcodeproj -scheme GVMLight -configuration Debug \
  -derivedDataPath build build | tail -n 40

APP="build/Build/Products/Debug/GVMLight.app"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -E "bluetooth|sandbox" || true
open "$APP"
