import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Point = { x: number; y: number };

export const Route = createFileRoute("/")({ component: Screen });

function Screen() {
  const feed = useRef<HTMLImageElement>(null);
  const stroke = useRef<Point[]>([]);
  const busy = useRef(false);
  const [seen, setSeen] = useState(false);

  function pull() {
    const img = feed.current;
    if (!img || busy.current) return;
    busy.current = true;
    img.src = `/api/go?t=${Date.now()}`;
  }

  useEffect(() => {
    pull();
  }, []);

  function point(event: ReactPointerEvent<HTMLImageElement>): Point {
    return { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight };
  }

  return (
    <>
      <img
        ref={feed}
        alt=""
        onLoad={() => {
          busy.current = false;
          setSeen(true);
          window.setTimeout(pull, 120);
        }}
        onError={() => {
          busy.current = false;
          window.setTimeout(pull, 400);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          stroke.current = [point(event)];
          const dot = document.createElement("span");
          dot.className = "press";
          dot.style.left = `${event.clientX}px`;
          dot.style.top = `${event.clientY}px`;
          document.body.appendChild(dot);
          window.setTimeout(() => dot.remove(), 160);
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
          if (!points.length) return;
          const first = points[0];
          const last = points[points.length - 1];
          if (first.y > 0.84 && last.y < first.y - 0.12) {
            void fetch("/api/go?op=home", { method: "POST" });
            return;
          }
          void fetch("/api/go?op=gesture", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ points }),
          });
        }}
      />
      {!seen && <div className="wait">Connecting</div>}
    </>
  );
}
