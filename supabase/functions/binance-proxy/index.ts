import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const allowedHosts = new Set([
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com",
  "api3.binance.com",
  "api4.binance.com",
  "data-api.binance.vision",
  "fapi.binance.com",
  "fapi1.binance.com",
  "fapi2.binance.com",
  "fapi3.binance.com",
  "fapi4.binance.com",
]);

function jsonResponse(body: Record<string, unknown>, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return jsonResponse({ error: "Missing url" }, 400);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse({ error: "Invalid url" }, 400);
  }

  if (targetUrl.protocol !== "https:") {
    return jsonResponse({ error: "Invalid protocol" }, 400);
  }

  if (!allowedHosts.has(targetUrl.hostname)) {
    return jsonResponse({ error: "Host not allowed" }, 400);
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: {
        Accept: req.headers.get("Accept") || "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "s-maxage=10, stale-while-revalidate=20",
      },
    });
  } catch (error) {
    return jsonResponse({ error: "Upstream fetch failed" }, 502);
  }
});
