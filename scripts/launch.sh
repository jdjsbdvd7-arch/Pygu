#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -d /Applications/Xcode.app ]; then
  sudo xcode-select -s /Applications/Xcode.app
fi

TITLE=$(printf '%s' "${TITLE:-Pygu}" | tr -cd 'A-Za-z0-9 ._-')
TITLE=$(printf '%s' "$TITLE" | cut -c1-24)
if [ -z "$TITLE" ]; then
  TITLE=Pygu
fi

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
ARCH=$(uname -m)
rm -rf build
mkdir -p build/Pygu.app
cp app/Info.plist build/Pygu.app/Info.plist
printf '#define SCREEN_TITLE @"%s"\n' "$TITLE" > build/title.h

xcrun -sdk iphonesimulator clang \
  -fobjc-arc \
  -fmodules \
  -include build/title.h \
  -target "${ARCH}-apple-ios17.0-simulator" \
  -isysroot "$SDK" \
  -framework UIKit \
  -framework Foundation \
  app/main.m \
  -o build/Pygu.app/Pygu

codesign --force --sign - --timestamp=none build/Pygu.app

UDID=$(python3 - << 'PY'
import json, subprocess
raw = subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"])
data = json.loads(raw)
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for device in devices:
        if device.get("isAvailable") and "iPhone" in device.get("name", ""):
            print(device["udid"])
            raise SystemExit
raise SystemExit("no iPhone simulator")
PY
)

xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" build/Pygu.app
xcrun simctl launch "$UDID" app.pygu.runner
sleep 4
mkdir -p run
xcrun simctl io "$UDID" screenshot run/screen.png
python3 - "$UDID" "$TITLE" << 'PY'
import json, sys
json.dump({"status": "launched", "bundle": "app.pygu.runner", "title": sys.argv[2], "udid": sys.argv[1]}, open("run/result.json", "w"), indent=2)
open("run/result.json", "a").write("\n")
PY
