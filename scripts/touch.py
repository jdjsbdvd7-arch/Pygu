#!/usr/bin/env python3
import argparse
import asyncio
import json
import logging
import socket
import threading

log = logging.getLogger("touch")


async def open_client(udid):
    last = "touch client missing"
    for _ in range(40):
        try:
            from idb.client.grpc import GrpcClientManager

            manager = GrpcClientManager(logger=log)
            ctx = manager.from_udid(udid=udid)
            return await ctx.__aenter__()
        except Exception as exc:
            last = str(exc)
        await asyncio.sleep(0.5)
    raise RuntimeError(last)


async def act(client, message):
    op = message.get("op")
    if op == "tap":
        x = int(message["x"])
        y = int(message["y"])
        if hasattr(client, "tap"):
            await client.tap(x=x, y=y, duration=0.02)
        else:
            await client.multi_tap(x=x, y=y, count=1, duration=0.02, pause=0.0)
        return
    if op == "swipe":
        start = (int(message["x"]), int(message["y"]))
        end = (int(message["x2"]), int(message["y2"]))
        duration = float(message.get("duration") or 0.09)
        try:
            await client.swipe(p_start=start, p_end=end, duration=duration, delta=12)
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
        await client.button(button, duration=0.04)
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
        future.result(timeout=0.45)
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
    loop.run_forever()


if __name__ == "__main__":
    main()
