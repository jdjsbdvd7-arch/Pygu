#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = {"image": b"", "kind": "image/jpeg", "error": "", "width": 0, "height": 0}
lock = threading.Lock()
inbox = ""
frame_path = ""
udid = ""
landscape = False


def jpeg_size(data):
    index = 2
    while index < len(data) - 8:
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            height = int.from_bytes(data[index + 5 : index + 7], "big")
            width = int.from_bytes(data[index + 7 : index + 9], "big")
            return width, height
        if marker in (0xD8, 0xD9):
            index += 2
            continue
        length = int.from_bytes(data[index + 2 : index + 4], "big")
        index += 2 + max(length, 2)
    return 0, 0


def capture_loop(device):
    jpeg = "/tmp/pygu-frame.jpg"
    while True:
        try:
            shot = subprocess.run(
                ["xcrun", "simctl", "io", device, "screenshot", "--type=jpeg", "--mask=ignored", jpeg],
                capture_output=True,
                timeout=8,
            )
            if shot.returncode != 0:
                subprocess.run(
                    ["xcrun", "simctl", "io", device, "screenshot", jpeg],
                    check=True,
                    capture_output=True,
                    timeout=8,
                )
            data = open(jpeg, "rb").read()
            if data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"):
                width, height = jpeg_size(data)
                with lock:
                    state["image"] = data
                    state["width"] = width
                    state["height"] = height
                    state["error"] = ""
        except Exception as exc:
            with lock:
                state["error"] = str(exc)
        time.sleep(0.05)


def device_point(nx, ny):
    with lock:
        width = state["width"]
        height = state["height"]
    if width < 10 or height < 10:
        return None
    scale = 3 if width >= 900 else 2
    return int(nx * width / scale), int(ny * height / scale)


def window_box():
    script = """
tell application "System Events"
  tell process "Simulator"
    set frontmost to true
    set w to front window
    set p to position of w
    set s to size of w
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
"""
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=8)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "simulator window missing").strip())
    return [int(float(part)) for part in proc.stdout.strip().split(",")]


def screen_click(nx, ny):
    wx, wy, ww, wh = window_box()
    with lock:
        width = state["width"]
        height = state["height"]
    scale = 3 if width >= 900 else 2
    points_w = width / scale
    points_h = height / scale
    fitted = ww / points_w if points_w else 1
    chrome = max(wh - points_h * fitted, 0)
    return int(wx + nx * points_w * fitted), int(wy + chrome + ny * points_h * fitted)


def pointer(nx, ny, nx2=None, ny2=None):
    x, y = screen_click(nx, ny)
    click = shutil.which("cliclick")
    if nx2 is None:
        if click:
            proc = subprocess.run([click, f"c:{x},{y}"], capture_output=True, text=True, timeout=8)
            return proc.returncode == 0, proc.stderr.strip() or "ok"
        proc = subprocess.run(
            ["osascript", "-e", f'tell application "System Events" to click at {{{x}, {y}}}'],
            capture_output=True,
            text=True,
            timeout=8,
        )
        return proc.returncode == 0, (proc.stderr or "ok").strip()[-200:]
    x2, y2 = screen_click(nx2, ny2)
    if click:
        proc = subprocess.run([click, f"dd:{x},{y}", "w:120", f"du:{x2},{y2}"], capture_output=True, text=True, timeout=8)
        return proc.returncode == 0, proc.stderr.strip() or "ok"
    return False, "drag needs cliclick"


def menu(item):
    script = f"""
tell application "Simulator" to activate
tell application "System Events"
  tell process "Simulator"
    click menu item "{item}" of menu 1 of menu bar item "Device" of menu bar 1
  end tell
end tell
"""
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=8)
    if proc.returncode == 0:
        return True, "ok"
    return False, (proc.stderr or proc.stdout or "menu failed").strip()[-200:]


def run_idb(args):
    if not shutil.which("idb"):
        return False, "idb missing"
    try:
        proc = subprocess.run(["idb", *args, "--udid", udid], capture_output=True, text=True, timeout=12)
    except Exception as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "idb failed").strip()[-300:]
    return True, "ok"


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("[engine]", fmt % args, flush=True)

        def end(self, code, body, content_type):
            data = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.end(204, b"", "text/plain")

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/stream":
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("access-control-allow-origin", "*")
                self.send_header("cache-control", "no-store")
                self.send_header("x-accel-buffering", "no")
                self.end_headers()
                previous = b""
                last = 0.0
                try:
                    while True:
                        with lock:
                            image = state["image"]
                        now = time.time()
                        if image and (image != previous or now - last > 0.08):
                            previous = image
                            last = now
                            self.wfile.write(len(image).to_bytes(4, "big") + image)
                            self.wfile.flush()
                        time.sleep(0.02)
                except Exception:
                    return
            if path == "/frame":
                with lock:
                    image = state["image"]
                if not image:
                    self.end(503, b"", "image/jpeg")
                    return
                self.end(200, image, "image/jpeg")
                return
            if path == "/health":
                with lock:
                    payload = {"ok": True, "bytes": len(state["image"]), "error": state["error"]}
                self.end(200, json.dumps(payload), "application/json")
                return
            self.end(200, b"ok", "text/plain")

        def do_POST(self):
            try:
                path = self.path.split("?", 1)[0]
                length = int(self.headers.get("content-length", "0") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode() or "{}")
                if path == "/gesture":
                    points = body.get("points")
                    if not isinstance(points, list) or not points:
                        self.end(400, b"bad gesture", "text/plain")
                        return
                    x0 = float(points[0].get("x", -1))
                    y0 = float(points[0].get("y", -1))
                    x1 = float(points[-1].get("x", -1))
                    y1 = float(points[-1].get("y", -1))
                    if not all(0 <= value <= 1 for value in (x0, y0, x1, y1)):
                        self.end(400, b"bad point", "text/plain")
                        return
                    if abs(x1 - x0) < 0.02 and abs(y1 - y0) < 0.02:
                        spot = device_point(x1, y1)
                        ok, detail = (False, "")
                        if spot and shutil.which("idb"):
                            ok, detail = run_idb(["ui", "tap", str(spot[0]), str(spot[1])])
                        if not ok:
                            ok, detail = pointer(x1, y1)
                    else:
                        start = device_point(x0, y0)
                        end = device_point(x1, y1)
                        ok = False
                        detail = ""
                        if start and end and shutil.which("idb"):
                            ok, detail = run_idb(["ui", "swipe", str(start[0]), str(start[1]), str(end[0]), str(end[1])])
                        if not ok:
                            ok, detail = pointer(x0, y0, x1, y1)
                elif path == "/home":
                    ok, detail = run_idb(["ui", "button", "HOME"])
                    if not ok:
                        ok, detail = menu("Home")
                elif path == "/lock":
                    ok, detail = run_idb(["ui", "button", "LOCK"])
                    if not ok:
                        ok, detail = menu("Lock")
                elif path == "/type":
                    text = str(body.get("text", ""))[:32].replace("\\", "").replace('"', "")
                    if not text:
                        self.end(400, b"bad text", "text/plain")
                        return
                    ok, detail = run_idb(["ui", "text", text])
                    if not ok:
                        if text == "\b":
                            script = 'tell application "System Events" to key code 51'
                        else:
                            script = f'tell application "System Events" to keystroke "{text}"'
                        proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=8)
                        ok = proc.returncode == 0
                        detail = "ok" if ok else (proc.stderr or "type failed")[-200:]
                elif path == "/rotate":
                    global landscape
                    landscape = not landscape
                    side = "landscapeLeft" if landscape else "portrait"
                    proc = subprocess.run(
                        ["xcrun", "simctl", "ui", udid, "orientation", side],
                        capture_output=True,
                        text=True,
                    )
                    ok = proc.returncode == 0
                    detail = "ok" if ok else (proc.stderr or proc.stdout or "rotate failed")[-200:]
                    if not ok:
                        ok, detail = menu("Rotate Left")
                else:
                    self.end(404, b"", "text/plain")
                    return
                code = 200 if ok else 503
                self.end(code, json.dumps({"ok": ok, "detail": detail}), "application/json")
            except Exception as exc:
                self.end(500, json.dumps({"ok": False, "detail": str(exc)}), "application/json")

    return Handler


def main():
    global udid
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    udid = args.udid
    threading.Thread(target=capture_loop, args=(args.udid,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler())
    print(f"engine listening on {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
