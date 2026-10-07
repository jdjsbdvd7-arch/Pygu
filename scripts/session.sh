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
open -a Simulator --args -CurrentDeviceUDID "$UDID" || true

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
if ! command -v idb_companion >/dev/null 2>&1; then
  brew install idb-companion || brew install facebook/fb/idb-companion
fi
python3 -m pip install --user fb-idb
export PATH="$PATH:$HOME/Library/Python/3.9/bin:$HOME/Library/Python/3.11/bin:$HOME/Library/Python/3.12/bin:$HOME/Library/Python/3.13/bin:/opt/homebrew/bin:/usr/local/bin"
idb_companion --udid "$UDID" >/tmp/idb.log 2>&1 &
ready=0
for _ in $(seq 1 90); do
  if idb list-targets 2>/dev/null | grep -q "$UDID"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "idb did not attach"
  cat /tmp/idb.log || true
  exit 1
fi

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
