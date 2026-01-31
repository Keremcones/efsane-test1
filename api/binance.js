export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  const url = req.query?.url;
  if (!url || typeof url !== "string") {
    res.statusCode = 400;
    res.end("Missing url parameter");
    return;
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    res.statusCode = 400;
    res.end("Invalid url");
    return;
  }

  const allowedHosts = new Set(["api.binance.com", "fapi.binance.com"]);
  if (!allowedHosts.has(target.hostname)) {
    res.statusCode = 403;
    res.end("Host not allowed");
    return;
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const body = await upstream.text();

    res.statusCode = upstream.status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.end("Upstream fetch failed");
  }
}
