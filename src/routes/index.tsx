import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const SESSION = "https://raw.githubusercontent.com/jdjsbdvd7-arch/Pygu/main/run/session.json";

type Session = { status?: string; url?: string };
type Point = { x: number; y: number };

export const Route = createFileRoute("/")({ component: Screen });

function Screen() {
  const feed = useRef<HTMLImageElement>(null);
  const stroke = useRef<Point[]>([]);
  const live = useRef("");
  const [note, setNote] = useState("Connecting");
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`${SESSION}?t=${Date.now()}`);
        if (!res.ok) {
          if (!stop) {
            live.current = "";
            setSeen(false);
            setNote("No session");
          }
          return;
        }
        const body = (await res.json()) as Session;
        if (stop) return;
        if (body.status === "live" && body.url) {
          const next = body.url.replace(/\/$/, "");
          if (next !== live.current) {
            live.current = next;
            const img = feed.current;
            if (img) img.src = `${next}/frame?t=${Date.now()}`;
          }
        } else {
          live.current = "";
          setSeen(false);
          setNote("No session");
        }
      } catch {
        if (!stop && !live.current) setNote("No session");
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  function pull() {
    const img = feed.current;
    if (!img || !live.current) return;
    img.src = `${live.current}/frame?t=${Date.now()}`;
  }

  function point(event: ReactPointerEvent<HTMLImageElement>): Point {
    return { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight };
  }

  return (
    <>
      <img
        ref={feed}
        alt=""
        referrerPolicy="no-referrer"
        style={{ visibility: seen ? "visible" : "hidden" }}
        onLoad={() => {
          setSeen(true);
          window.setTimeout(pull, 180);
        }}
        onError={() => {
          if (live.current) window.setTimeout(pull, 700);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          stroke.current = [point(event)];
          const dot = document.createElement("span");
          dot.className = "press";
          dot.style.left = `${event.clientX}px`;
          dot.style.top = `${event.clientY}px`;
          document.body.appendChild(dot);
          window.setTimeout(() => dot.remove(), 180);
        }}
        onPointerMove={(event) => {
          if (!stroke.current.length) return;
          const next = point(event);
          const last = stroke.current[stroke.current.length - 1];
          if (Math.hypot(next.x - last.x, next.y - last.y) > 0.012) stroke.current.push(next);
        }}
        onPointerUp={() => {
          const points = stroke.current;
          stroke.current = [];
          const base = live.current;
          if (!base || !points.length) return;
          const first = points[0];
          const last = points[points.length - 1];
          if (first.y > 0.84 && last.y < first.y - 0.12) {
            void fetch(`${base}/home`, { method: "POST" });
            return;
          }
          void fetch(`${base}/gesture`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ points }),
          });
        }}
      />
      {!seen && <div className="wait">{note}</div>}
    </>
  );
}
