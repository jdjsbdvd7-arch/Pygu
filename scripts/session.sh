#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p run
if [ -d /Applications/Xcode.app ]; then
  sudo xcode-select -s /Applications/Xcode.app
fi

ARCH=$(uname -m)

UDID=$(python3 - << 'PY'
import json, re, subprocess
raw = subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"])
data = json.loads(raw)
best = ""
rank = (-1, -1, -1)
for runtime, devices in data.get("devices", {}).items():
    found = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not found:
        continue
    major, minor = int(found.group(1)), int(found.group(2))
    for device in devices:
        name = device.get("name", "")
        if not device.get("isAvailable") or "iPhone" not in name:
            continue
        score = (major, minor, 1 if "Pro" in name and "Max" not in name else 0)
        if score >= rank:
            rank = score
            best = device["udid"]
if not best:
    raise SystemExit("no iPhone simulator")
print(best)
PY
)

xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
defaults write com.apple.iphonesimulator ShowChrome -bool false || true
open -a Simulator --args -CurrentDeviceUDID "$UDID" || true
xcodebuild -version || true
brew install cliclick || true

curl -fsSL -o /tmp/idb.tgz "https://github.com/facebook/idb/releases/download/v1.6.2/idb-companion.macos-arm64.tar.gz" || true
mkdir -p /tmp/idb
tar -xzf /tmp/idb.tgz -C /tmp/idb || true
COMPANION=$(find /tmp/idb -type f -name 'idb_companion' | head -1 || true)
if [ -n "$COMPANION" ]; then
  chmod +x "$COMPANION"
  "$COMPANION" --udid "$UDID" >/tmp/idb.log 2>&1 &
fi
python3 -m pip install --user --break-system-packages fb-idb || true
PYBIN=$(python3 -c 'import glob,os; print(":".join(glob.glob(os.path.expanduser("~/Library/Python/*/bin"))))')
export PATH="$PYBIN:$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v idb || echo "idb client missing"

python3 -u scripts/engine.py --udid "$UDID" --port 8787 >/tmp/engine.log 2>&1 &
ENGINE=$!
tail -n +1 -f /tmp/engine.log &
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
