import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Point = { x: number; y: number };

export const Route = createFileRoute("/")({ component: Screen });

function Screen() {
  const shown = useRef<HTMLImageElement>(null);
  const next = useRef<HTMLImageElement>(null);
  const urlShown = useRef("");
  const stroke = useRef<Point[]>([]);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let stop = false;
    const front = shown.current;
    const back = next.current;
    if (!front || !back) return;
    const frontImg: HTMLImageElement = front;
    const backImg: HTMLImageElement = back;

    function decode(img: HTMLImageElement, url: string) {
      return new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode"));
        img.src = url;
      });
    }

    async function pull() {
      if (stop) return;
      try {
        const res = await fetch(`/api/go?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error("http");
        const url = URL.createObjectURL(await res.blob());
        if (stop) {
          URL.revokeObjectURL(url);
          return;
        }
        await decode(backImg, url);
        backImg.style.visibility = "visible";
        frontImg.style.visibility = "hidden";
        if (urlShown.current) URL.revokeObjectURL(urlShown.current);
        urlShown.current = url;
        const frontSrc = frontImg.src;
        frontImg.src = backImg.src;
        frontImg.style.visibility = "visible";
        backImg.style.visibility = "hidden";
        backImg.removeAttribute("src");
        if (frontSrc.startsWith("blob:")) URL.revokeObjectURL(frontSrc);
        setSeen(true);
      } catch {
        if (!urlShown.current) setSeen(false);
      }
      if (!stop) window.setTimeout(pull, 90);
    }

    void pull();
    return () => {
      stop = true;
    };
  }, []);

  function point(event: ReactPointerEvent<HTMLDivElement>): Point {
    const img = shown.current;
    if (!img) return { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight };
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth || rect.width;
    const nh = img.naturalHeight || rect.height;
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const width = nw * scale;
    const height = nh * scale;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - left) / width)),
      y: Math.min(1, Math.max(0, (event.clientY - top) / height)),
    };
  }

  return (
    <>
      <img ref={shown} alt="" />
      <img ref={next} alt="" style={{ visibility: "hidden" }} />
      <div
        id="touch"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          stroke.current = [point(event)];
          const dot = document.createElement("span");
          dot.className = "press";
          dot.style.left = `${event.clientX}px`;
          dot.style.top = `${event.clientY}px`;
          document.body.appendChild(dot);
          window.setTimeout(() => dot.remove(), 140);
        }}
        onPointerMove={(event) => {
          if (!stroke.current.length) return;
          const here = point(event);
          const last = stroke.current[stroke.current.length - 1];
          if (Math.hypot(here.x - last.x, here.y - last.y) > 0.008) stroke.current.push(here);
        }}
        onPointerUp={() => {
          const points = stroke.current;
          stroke.current = [];
          if (!points.length) return;
          const first = points[0];
          const last = points[points.length - 1];
          if (first.y > 0.84 && last.y < first.y - 0.12) {
            const home = new URLSearchParams({ op: "home", t: String(Date.now()) });
            void fetch(`/api/go?${home.toString()}`, { method: "GET", cache: "no-store" });
            return;
          }
          const query = new URLSearchParams({
            op: "gesture",
            t: String(Date.now()),
            p: points.map((item) => `${item.x.toFixed(4)},${item.y.toFixed(4)}`).join(";"),
          });
          void fetch(`/api/go?${query.toString()}`, { method: "GET", cache: "no-store" });
        }}
      />
      {!seen && <div className="wait">Connecting</div>}
    </>
  );
}
