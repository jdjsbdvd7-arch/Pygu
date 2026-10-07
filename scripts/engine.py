#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = {"png": b"", "error": "", "width": 0, "height": 0}
lock = threading.Lock()


def png_size(buf):
    if len(buf) < 24 or buf[:8] != b"\x89PNG\r\n\x1a\n":
        return 0, 0
    return int.from_bytes(buf[16:20], "big"), int.from_bytes(buf[20:24], "big")


def capture_loop(udid, path):
    while True:
        try:
            subprocess.run(
                ["xcrun", "simctl", "io", udid, "screenshot", path],
                check=True,
                capture_output=True,
            )
            data = open(path, "rb").read()
            w, h = png_size(data)
            with lock:
                state["png"] = data
                state["width"] = w
                state["height"] = h
                state["error"] = ""
        except Exception as exc:
            with lock:
                state["error"] = str(exc)
        time.sleep(0.25)


def idb_bin():
    for candidate in (shutil.which("idb"), "/opt/homebrew/bin/idb", "/usr/local/bin/idb"):
        if candidate and shutil.which(candidate if "/" not in candidate else None) or (
            candidate and candidate.startswith("/") and shutil.os.path.isfile(candidate)
        ):
            return candidate
    return None


def tap(udid, x_norm, y_norm):
    with lock:
        width, height = state["width"], state["height"]
    if width < 2 or height < 2:
        return False, "no frame yet"
    scale = 3 if width >= 1000 else 2
    x = int((x_norm * width) / scale)
    y = int((y_norm * height) / scale)
    binary = idb_bin()
    if not binary:
        return False, "tap bridge is not installed yet"
    proc = subprocess.run(
        [binary, "ui", "tap", str(x), str(y), "--udid", udid],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "tap failed").strip()
    return True, f"{x},{y}"


def make_handler(udid):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("[engine]", fmt % args)

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
            if path == "/frame":
                with lock:
                    png = state["png"]
                if not png:
                    self.end(503, b"", "image/png")
                    return
                self.end(200, png, "image/png")
                return
            if path == "/health":
                with lock:
                    payload = {"ok": True, "bytes": len(state["png"]), "error": state["error"]}
                self.end(200, json.dumps(payload), "application/json")
                return
            self.end(200, b"ok", "text/plain")

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path != "/tap":
                self.end(404, b"", "text/plain")
                return
            length = int(self.headers.get("content-length", "0") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode() or "{}")
                x = float(body.get("x", -1))
                y = float(body.get("y", -1))
            except Exception:
                self.end(400, b"bad json", "text/plain")
                return
            if not (0 <= x <= 1 and 0 <= y <= 1):
                self.end(400, b"bad point", "text/plain")
                return
            ok, detail = tap(udid, x, y)
            code = 200 if ok else 503
            self.end(code, json.dumps({"ok": ok, "detail": detail}), "application/json")

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    threading.Thread(target=capture_loop, args=(args.udid, "/tmp/pygu-frame.png"), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.udid))
    print(f"engine listening on {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
