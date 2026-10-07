export const config = { runtime: "edge" };

let cached = { url: "", at: 0 };

async function tunnel(via) {
  if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(via)) return via;
  if (cached.url && Date.now() - cached.at < 4000) return cached.url;
  const res = await fetch(
    "https://raw.githubusercontent.com/jdjsbdvd7-arch/Pygu/main/run/session.json?t=" + Date.now(),
    { cache: "no-store" },
  );
  if (!res.ok) return "";
  const body = await res.json();
  const url = body && body.status === "live" && body.url ? String(body.url).replace(/\/$/, "") : "";
  cached = { url, at: Date.now() };
  return url;
}

export default async function handler(request) {
  const via = new URL(request.url).searchParams.get("via") || "";
  const base = await tunnel(via);
  if (!base) return new Response("offline", { status: 404, headers: { "cache-control": "no-store" } });
  const upstream = await fetch(base + "/stream", { cache: "no-store" });
  if (!upstream.ok || !upstream.body) {
    return new Response("offline", { status: 502, headers: { "cache-control": "no-store" } });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
