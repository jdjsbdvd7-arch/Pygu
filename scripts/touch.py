#!/usr/bin/env python3
import argparse
import asyncio
import json
import logging
import os
import socket
import threading

log = logging.getLogger("touch")
LIVE = "/tmp/pygu-live.jpg"


async def open_client(udid):
    import glob

    from idb.grpc.management import ClientManager

    companion = None
    for path in glob.glob("/tmp/idb/**/idb_companion", recursive=True):
        if os.path.isfile(path):
            companion = path
            break
    manager = ClientManager(logger=log, companion_path=companion)
    last = "touch client missing"
    for _ in range(40):
        try:
            ctx = manager.from_udid(udid=udid)
            client = await ctx.__aenter__()
            print("touch connected", flush=True)
            return client
        except Exception as exc:
            last = str(exc)
            print("touch wait", last, flush=True)
        await asyncio.sleep(0.5)
    raise RuntimeError(last)


def publish(frame):
    if len(frame) < 80 or not frame.startswith(b"\xff\xd8"):
        return
    tmp = LIVE + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(frame)
    os.replace(tmp, LIVE)


def take_jpegs(buf):
    frames = []
    while True:
        start = buf.find(b"\xff\xd8")
        if start < 0:
            if len(buf) > 1:
                del buf[:-1]
            break
        end = buf.find(b"\xff\xd9", start + 2)
        if end < 0:
            if start:
                del buf[:start]
            if len(buf) > 900000:
                del buf[:]
            break
        frames.append(bytes(buf[start : end + 2]))
        del buf[: end + 2]
    return frames


async def video_loop(udid):
    from idb.common.types import ScreenshotFormat, ScreenshotOptions, VideoFormat

    while True:
        try:
            client = await open_client(udid)
            print("video connected", flush=True)
            try:
                buf = bytearray()
                async for chunk in client.stream_video(
                    output_file=None,
                    fps=24,
                    format=VideoFormat.MJPEG,
                    compression_quality=0.26,
                    scale_factor=0.48,
                ):
                    buf.extend(chunk)
                    for frame in take_jpegs(buf):
                        publish(frame)
                print("video ended", flush=True)
            except Exception as exc:
                print("video", exc, flush=True)
            options = ScreenshotOptions(
                format=ScreenshotFormat.JPEG,
                compression_quality=0.34,
                max_width=560,
            )
            while True:
                shot = await client.screenshot(options)
                publish(bytes(shot))
                await asyncio.sleep(0.02)
        except Exception as exc:
            print("video wait", exc, flush=True)
            await asyncio.sleep(0.5)


async def act(client, message):
    op = message.get("op")
    if op == "tap":
        x = int(message["x"])
        y = int(message["y"])
        if hasattr(client, "tap"):
            await client.tap(x=x, y=y, duration=0.012)
        else:
            await client.multi_tap(x=x, y=y, count=1, duration=0.012, pause=0.0)
        return
    if op == "swipe":
        start = (int(message["x"]), int(message["y"]))
        end = (int(message["x2"]), int(message["y2"]))
        duration = float(message.get("duration") or 0.07)
        try:
            await client.swipe(p_start=start, p_end=end, duration=duration, delta=16)
        except TypeError:
            await client.swipe(p_start=start, p_end=end, duration=duration)
        return
    if op == "button":
        name = str(message.get("name") or "HOME")
        try:
            from idb.common.types import HIDButtonType

            button = getattr(HIDButtonType, name)
        except Exception:
            button = name
        await client.button(button, duration=0.03)
        return
    raise RuntimeError("bad touch")


def handle(loop, client, conn):
    try:
        conn.settimeout(0.4)
        data = b""
        while b"\n" not in data and len(data) < 8000:
            chunk = conn.recv(1024)
            if not chunk:
                break
            data += chunk
        message = json.loads(data.decode() or "{}")
        future = asyncio.run_coroutine_threadsafe(act(client, message), loop)
        future.result(timeout=1.2)
        conn.sendall(b"ok\n")
    except Exception as exc:
        try:
            conn.sendall(("err " + str(exc)[:160] + "\n").encode())
        except Exception:
            pass
    finally:
        conn.close()


def serve(loop, client):
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 8791))
    sock.listen(16)
    print("touch ready", flush=True)
    while True:
        conn, _ = sock.accept()
        threading.Thread(target=handle, args=(loop, client, conn), daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.ERROR)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    client = loop.run_until_complete(open_client(args.udid))
    threading.Thread(target=serve, args=(loop, client), daemon=True).start()
    loop.create_task(video_loop(args.udid))
    loop.run_forever()


if __name__ == "__main__":
    main()
