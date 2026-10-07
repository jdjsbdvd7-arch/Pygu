#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d /Applications/Xcode.app ]; then
  sudo xcode-select -s /Applications/Xcode.app
fi

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
ARCH=$(uname -m)
rm -rf build
mkdir -p build/Pygu.app run
cp app/Info.plist build/Pygu.app/Info.plist
xcrun -sdk iphonesimulator clang \
  -fobjc-arc -fmodules \
  -target "${ARCH}-apple-ios17.0-simulator" \
  -isysroot "$SDK" \
  -framework UIKit -framework Foundation \
  app/main.m -o build/Pygu.app/Pygu
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

( HOMEBREW_NO_AUTO_UPDATE=1 brew install idb-companion && python3 -m pip install --user fb-idb ) >/tmp/idb-install.log 2>&1 &

python3 scripts/engine.py --udid "$UDID" --port 8787 >/tmp/engine.log 2>&1 &
ENGINE=$!

case "$ARCH" in
  arm64) CFARCH=arm64 ;;
  *) CFARCH=amd64 ;;
esac
curl -fsSL -o /tmp/cf.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CFARCH}.tgz"
mkdir -p /tmp/cfbin
tar -xzf /tmp/cf.tgz -C /tmp/cfbin
CF=$(find /tmp/cfbin -type f -name 'cloudflared*' | head -1)
chmod +x "$CF"
"$CF" tunnel --url http://127.0.0.1:8787 --no-autoupdate >/tmp/cf.log 2>&1 &

URL=""
for _ in $(seq 1 90); do
  URL=$(grep -oE 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' /tmp/cf.log | head -1 || true)
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done
if [ -z "$URL" ]; then
  echo "tunnel failed"
  cat /tmp/cf.log || true
  exit 1
fi

python3 - "$URL" << 'PY'
import json, sys
json.dump({"status": "live", "url": sys.argv[1]}, open("run/session.json", "w"), indent=2)
open("run/session.json", "a").write("\n")
PY

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add run/session.json
git commit -m "Publish the simulator session"
git pull --rebase origin main
git push

cleanup() {
  python3 - << 'PY'
import json
json.dump({"status": "ended", "url": ""}, open("run/session.json", "w"), indent=2)
open("run/session.json", "a").write("\n")
PY
  git add run/session.json
  git commit -m "End the simulator session" || true
  git pull --rebase origin main || true
  git push || true
}
trap cleanup EXIT

sleep 1500
kill "$ENGINE" || true
