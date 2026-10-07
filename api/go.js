let cached = { url: "", at: 0 };

async function tunnel() {
  if (cached.url && Date.now() - cached.at < 5000) return cached.url;
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

export default async function handler(req, res) {
  const op = new URL(req.url, "http://pygu.local").searchParams.get("op") || "frame";
  const query = new URL(req.url, "http://pygu.local").searchParams;
  const via = query.get("via") || "";
  const base = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(via) ? via : await tunnel();
  if (!base) {
    res.statusCode = 404;
    res.setHeader("cache-control", "no-store");
    res.end("offline");
    return;
  }
  if (op !== "frame") {
    let payload = {};
    if (op === "gesture") {
      const points = String(query.get("p") || "")
        .split(";")
        .filter(Boolean)
        .map((pair) => {
          const [x, y] = pair.split(",");
          return { x: Number(x), y: Number(y) };
        })
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      payload = { points };
    } else if (op === "type") {
      payload = { text: query.get("text") || "" };
    }
    const sent = await fetch(base + "/" + op, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    res.statusCode = sent.status;
    res.setHeader("content-type", "text/plain");
    res.setHeader("cache-control", "no-store");
    res.end(await sent.text());
    return;
  }
  if (req.method === "GET") {
    const img = await fetch(base + "/frame?t=" + Date.now(), { cache: "no-store" });
    if (!img.ok) {
      cached = { url: "", at: 0 };
      res.statusCode = 502;
      res.setHeader("cache-control", "no-store");
      res.end("offline");
      return;
    }
    const bytes = Buffer.from(await img.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.setHeader("cdn-cache-control", "no-store");
    res.setHeader("vercel-cdn-cache-control", "no-store");
    res.end(bytes);
    return;
  }
  if (req.method === "POST" && ["gesture", "home", "lock", "type", "rotate"].includes(op)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const sent = await fetch(base + "/" + op, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] || "application/json" },
      body: body.length ? body : undefined,
    });
    res.statusCode = sent.status;
    res.setHeader("content-type", "text/plain");
    res.setHeader("cache-control", "no-store");
    res.end(await sent.text());
    return;
  }
  res.statusCode = 405;
  res.end("no");
}
