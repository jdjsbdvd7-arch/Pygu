#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = {"image": b"", "kind": "image/jpeg", "error": ""}
lock = threading.Lock()
inbox = ""
frame_path = ""


def capture_loop(udid):
    jpeg = "/tmp/pygu-frame.jpg"
    while True:
        try:
            shot = subprocess.run(
                ["xcrun", "simctl", "io", udid, "screenshot", "--type=jpeg", "--mask=ignored", jpeg],
                capture_output=True,
            )
            if shot.returncode != 0:
                subprocess.run(
                    ["xcrun", "simctl", "io", udid, "screenshot", jpeg],
                    check=True,
                    capture_output=True,
                )
            data = open(jpeg, "rb").read()
            if data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"):
                with lock:
                    state["image"] = data
                    state["error"] = ""
        except Exception as exc:
            with lock:
                state["error"] = str(exc)
        time.sleep(0.05)


def enqueue(payload):
    if not inbox:
        return False, "inbox is not ready"
    os.makedirs(inbox, exist_ok=True)
    path = os.path.join(inbox, f"{time.time_ns()}.json")
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(temporary, path)
    return True, "queued"


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
                if path == "/tap":
                    x = float(body.get("x", -1))
                    y = float(body.get("y", -1))
                    if not (0 <= x <= 1 and 0 <= y <= 1):
                        self.end(400, b"bad point", "text/plain")
                        return
                    ok, detail = enqueue({"cmd": "tap", "x": x, "y": y})
                elif path == "/gesture":
                    points = body.get("points")
                    if not isinstance(points, list) or not points:
                        self.end(400, b"bad gesture", "text/plain")
                        return
                    clean = []
                    for point in points[:40]:
                        x = float(point.get("x", -1))
                        y = float(point.get("y", -1))
                        if not (0 <= x <= 1 and 0 <= y <= 1):
                            self.end(400, b"bad point", "text/plain")
                            return
                        clean.append({"x": x, "y": y})
                    ok, detail = enqueue({"cmd": "gesture", "points": clean})
                elif path == "/home":
                    ok, detail = enqueue({"cmd": "home"})
                elif path == "/type":
                    text = str(body.get("text", ""))[:8]
                    if not text:
                        self.end(400, b"bad text", "text/plain")
                        return
                    ok, detail = enqueue({"cmd": "type", "text": text})
                elif path == "/app":
                    name = str(body.get("name", "")).strip()[:24]
                    if not name:
                        self.end(400, b"bad name", "text/plain")
                        return
                    ok, detail = enqueue({"cmd": "add", "name": name})
                else:
                    self.end(404, b"", "text/plain")
                    return
                code = 200 if ok else 503
                self.end(code, json.dumps({"ok": ok, "detail": detail}), "application/json")
            except Exception as exc:
                self.end(500, json.dumps({"ok": False, "detail": str(exc)}), "application/json")

    return Handler


def main():
    global inbox, frame_path
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--inbox", required=True)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    inbox = args.inbox
    frame_path = args.frames
    threading.Thread(target=capture_loop, args=(args.udid,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler())
    print(f"engine listening on {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
