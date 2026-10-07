import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const SESSION = "https://raw.githubusercontent.com/jdjsbdvd7-arch/Pygu/main/run/session.json";
const WORKFLOW = "https://github.com/jdjsbdvd7-arch/Pygu/actions/workflows/sim.yml";

type Session = { status?: string; url?: string };

export const Route = createFileRoute("/")({ component: Viewer });

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#222" strokeWidth="1.7">
      <path d={d} />
    </svg>
  );
}

function Viewer() {
  const [note, setNote] = useState("Off");
  const [live, setLive] = useState("");
  const [typing, setTyping] = useState(false);
  const [seen, setSeen] = useState(false);
  const feed = useRef<HTMLImageElement>(null);
  const stroke = useRef<{ x: number; y: number }[]>([]);
  const blob = useRef("");

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`${SESSION}?t=${Date.now()}`);
        if (!res.ok) {
          if (!stop) {
            setNote("Off");
            setLive("");
          }
          return;
        }
        const body = (await res.json()) as Session;
        if (stop) return;
        if (body.status === "live" && body.url) {
          setNote("Live");
          setLive(body.url.replace(/\/$/, ""));
        } else {
          setNote("Off");
          setLive("");
        }
      } catch {
        if (!stop) setNote("Off");
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!live) {
      setSeen(false);
      return;
    }
    let stop = false;
    async function tick() {
      try {
        const res = await fetch(`${live}/frame?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const next = URL.createObjectURL(await res.blob());
        if (blob.current) URL.revokeObjectURL(blob.current);
        blob.current = next;
        if (feed.current) feed.current.src = next;
        if (!stop) setSeen(true);
      } catch {
        return;
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), 280);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [live]);

  function point(event: ReactPointerEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  function down(event: ReactPointerEvent<HTMLImageElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = [point(event)];
    const host = event.currentTarget.parentElement;
    if (!host) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "press";
    dot.style.left = `${event.clientX - rect.left}px`;
    dot.style.top = `${event.clientY - rect.top}px`;
    host.appendChild(dot);
    window.setTimeout(() => dot.remove(), 220);
  }

  function move(event: ReactPointerEvent<HTMLImageElement>) {
    if (!stroke.current.length) return;
    const next = point(event);
    const last = stroke.current[stroke.current.length - 1];
    if (Math.hypot(next.x - last.x, next.y - last.y) > 0.012) stroke.current.push(next);
  }

  function send(path: string, body?: unknown) {
    if (!live) return;
    void fetch(`${live}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!typing || !live) return;
      const text = event.key === "Backspace" ? "\b" : event.key.length === 1 ? event.key : "";
      if (!text) return;
      event.preventDefault();
      send("/type", { text });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <div className="bar">
        <span>{note}</span>
        <a href={WORKFLOW}>Start</a>
      </div>
      <main className="stage">
        <div>
          <div className="row">
            <div className="device">
              <div className="screen">
                <img
                  ref={feed}
                  alt="iPhone"
                  style={{ display: seen ? "block" : "none" }}
                  onPointerDown={down}
                  onPointerMove={move}
                  onPointerUp={() => {
                    const points = stroke.current;
                    stroke.current = [];
                    if (points.length) send("/gesture", { points });
                  }}
                />
                {!seen && <div className="idle">{note === "Live" ? "Connecting" : "No session"}</div>}
              </div>
            </div>
            <div className="rail">
              <button type="button" aria-label="Home" onClick={() => send("/home")}>
                <Icon d="M4 11.5 12 4l8 7.5M7 10.5V20h10v-9.5" />
              </button>
              <button
                type="button"
                aria-label="Screenshot"
                onClick={() => {
                  if (!feed.current?.src) return;
                  const link = document.createElement("a");
                  link.href = feed.current.src;
                  link.download = "screen.jpg";
                  link.click();
                }}
              >
                <Icon d="M8 7h2l1.2-1.5h3.6L16 7h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
              </button>
              <button type="button" aria-label="Keyboard" className={typing ? "on" : ""} onClick={() => setTyping((value) => !value)}>
                <Icon d="M7 10h.01M12 10h.01M17 10h.01M7 14h10" />
              </button>
              <button type="button" aria-label="Lock" onClick={() => send("/lock")}>
                <Icon d="M8 11V8a4 4 0 0 1 8 0v3" />
              </button>
            </div>
          </div>
          <button className="spin" type="button" aria-label="Rotate" onClick={() => send("/rotate")}>
            <Icon d="M20 12a8 8 0 1 1-2.2-5.5M20 4v5h-5" />
          </button>
        </div>
      </main>
    </>
  );
}
