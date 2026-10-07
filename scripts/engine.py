#!/usr/bin/env python3
import argparse
import json
import os
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
            )
            if shot.returncode != 0:
                subprocess.run(
                    ["xcrun", "simctl", "io", device, "screenshot", jpeg],
                    check=True,
                    capture_output=True,
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


def device_point(x, y):
    with lock:
        width = state["width"]
        height = state["height"]
    if width < 10 or height < 10:
        return None
    scale = 3 if width >= 900 else 2
    return int(x * width / scale), int(y * height / scale)


def run_idb(args):
    try:
        proc = subprocess.run(
            ["idb", *args, "--udid", udid],
            capture_output=True,
            text=True,
            timeout=12,
        )
    except Exception as exc:
        return False, str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "idb failed").strip()
        return False, detail[-300:]
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
                    mapped = []
                    for point in points[:40]:
                        x = float(point.get("x", -1))
                        y = float(point.get("y", -1))
                        if not (0 <= x <= 1 and 0 <= y <= 1):
                            self.end(400, b"bad point", "text/plain")
                            return
                        spot = device_point(x, y)
                        if not spot:
                            self.end(503, json.dumps({"ok": False, "detail": "screen not ready"}), "application/json")
                            return
                        mapped.append(spot)
                    x0, y0 = mapped[0]
                    x1, y1 = mapped[-1]
                    if abs(x1 - x0) < 8 and abs(y1 - y0) < 8:
                        ok, detail = run_idb(["ui", "tap", str(x1), str(y1)])
                    else:
                        ok, detail = run_idb(["ui", "swipe", str(x0), str(y0), str(x1), str(y1)])
                elif path == "/home":
                    ok, detail = run_idb(["ui", "button", "HOME"])
                elif path == "/lock":
                    ok, detail = run_idb(["ui", "button", "LOCK"])
                elif path == "/type":
                    text = str(body.get("text", ""))[:32]
                    if not text:
                        self.end(400, b"bad text", "text/plain")
                        return
                    ok, detail = run_idb(["ui", "text", text])
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
