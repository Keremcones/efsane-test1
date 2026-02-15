// deno-lint-ignore-file no-explicit-any
/// <reference lib="deno.window" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

/**
 * ✅ FIXES INCLUDED
 * - Uses SERVICE_ROLE_KEY (server-side safe) instead of ANON
 * - Adds CRON_SECRET auth guard (optional but recommended)
 * - Implements tickSize precision rounding via exchangeInfo cache
 * - Properly handles Binance response errors + NaN protection
 * - Uses maybeSingle() for duplicate check
 * - Inserts new signal if provided and not duplicate
 * - Status model: ACTIVE / CLOSED + close_reason: TP_HIT / SL_HIT
 */

// =====================
// ENV
// =====================
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const cronSecret = Deno.env.get("CRON_SECRET") ?? ""; // set this to protect endpoint

// Supabase client (init lazily to avoid boot errors when env is missing)
let supabase: ReturnType<typeof createClient> | null = null;

// =====================
// Binance API bases & price cache
// =====================
const BINANCE_SPOT_API_BASE = "https://api.binance.com/api/v3";
const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com/fapi/v1";

// Exchange info cache (tick size / price precision)
const exchangeInfoCache: Record<string, { timestamp: number; symbols: Record<string, any> }> = {};
const EXCHANGE_INFO_TTL = 10 * 60 * 1000; // 10 minutes
const exchangeInfoInFlight: Record<"spot" | "futures", Promise<void> | null> = { spot: null, futures: null };
let requestMetrics = { klinesFetched: 0, klinesSkippedByProximity: 0, exchangeInfoFetches: 0 };

async function ensureExchangeInfo(marketType: "spot" | "futures"): Promise<void> {
  const cacheKey = marketType;
  const now = Date.now();
  const cached = exchangeInfoCache[cacheKey];
  if (cached && (now - cached.timestamp) < EXCHANGE_INFO_TTL) {
    return;
  }
  if (binanceBanUntil && now < binanceBanUntil) {
    return;
  }
  if (exchangeInfoInFlight[cacheKey]) {
    await exchangeInfoInFlight[cacheKey];
    return;
  }

  exchangeInfoInFlight[cacheKey] = (async () => {
    requestMetrics.exchangeInfoFetches += 1;
    const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
    const url = `${base}/exchangeInfo`;
    const res = await throttledFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const symbols = (data?.symbols || []).reduce((acc: Record<string, any>, item: any) => {
      const priceFilter = (item.filters || []).find((f: any) => f.filterType === "PRICE_FILTER");
      const tickSize = priceFilter?.tickSize;
      const tickDecimals = tickSize ? getTickSizeDecimals(String(tickSize)) : null;
      const pricePrecision = typeof item.pricePrecision === "number" ? item.pricePrecision : null;
      const resolvedPrecisionCandidates = [pricePrecision, tickDecimals].filter((value) => Number.isFinite(value)) as number[];
      const resolvedPrecision = resolvedPrecisionCandidates.length
        ? Math.max(...resolvedPrecisionCandidates)
        : null;
      acc[String(item.symbol)] = { pricePrecision: resolvedPrecision, tickSize: tickSize ? Number(tickSize) : null };
      return acc;
    }, {});
    exchangeInfoCache[cacheKey] = { timestamp: now, symbols };
  })().finally(() => {
    exchangeInfoInFlight[cacheKey] = null;
  });

  await exchangeInfoInFlight[cacheKey];
}

function getTickSizeDecimals(tickSize: string): number {
  if (!tickSize || !tickSize.includes(".")) return 0;
  const fraction = tickSize.split(".")[1] || "";
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length;
}

async function getSymbolPricePrecision(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  const cacheKey = marketType;
  const now = Date.now();
  const cached = exchangeInfoCache[cacheKey];
  if (cached && (now - cached.timestamp) < EXCHANGE_INFO_TTL) {
    const info = cached.symbols?.[symbol];
    if (info) return info.pricePrecision ?? null;
  }

  if (binanceBanUntil && now < binanceBanUntil) {
    return null;
  }
  await ensureExchangeInfo(marketType);
  const refreshed = exchangeInfoCache[cacheKey];
  const info = refreshed?.symbols?.[symbol];
  return info ? info.pricePrecision ?? null : null;
}

async function getSymbolTickSize(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  const cacheKey = marketType;
  const now = Date.now();
  const cached = exchangeInfoCache[cacheKey];
  if (cached && (now - cached.timestamp) < EXCHANGE_INFO_TTL) {
    const info = cached.symbols?.[symbol];
    if (info && Number.isFinite(info.tickSize)) return Number(info.tickSize);
  }

  if (binanceBanUntil && now < binanceBanUntil) {
    return null;
  }
  await ensureExchangeInfo(marketType);
  const refreshed = exchangeInfoCache[cacheKey];
  const info = refreshed?.symbols?.[symbol];
  return info && Number.isFinite(info.tickSize) ? Number(info.tickSize) : null;
}

function formatPriceWithPrecision(value: number, precision: number | null): string {
  if (!Number.isFinite(value)) return "0";
  if (precision === null || precision === undefined) {
    return value.toFixed(8);
  }
  return value.toFixed(Math.max(0, precision));
}

function formatTurkeyDateTime(timestampMs?: number): string {
  const baseDate = Number.isFinite(timestampMs) ? new Date(Number(timestampMs)) : new Date();
  const turkeyTime = new Date(baseDate.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
  const day = String(turkeyTime.getDate()).padStart(2, "0");
  const month = String(turkeyTime.getMonth() + 1).padStart(2, "0");
  const year = turkeyTime.getFullYear();
  const hours = String(turkeyTime.getHours()).padStart(2, "0");
  const minutes = String(turkeyTime.getMinutes()).padStart(2, "0");
  const seconds = String(turkeyTime.getSeconds()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

// Global ban cooldown (Binance 418)
let binanceBanUntil = 0;
let binanceTimeOffsetMs = 0;
let lastBinanceTimeSyncMs = 0;
let futuresAlgoEndpointBlockedUntil = 0;
const BINANCE_TIME_SYNC_TTL_MS = 5 * 60 * 1000;

// Cache prices to avoid redundant API calls
const priceCache: Record<string, { price: number; timestamp: number }> = {};
const PRICE_CACHE_TTL = 15000; // 15 seconds - reduce API pressure
const allTickerCache: Record<"spot" | "futures", { timestamp: number; prices: Record<string, number> }> = {
  spot: { timestamp: 0, prices: {} },
  futures: { timestamp: 0, prices: {} },
};
const ALL_TICKER_TTL = 15000; // 15 seconds
const markPriceCache: { timestamp: number; prices: Record<string, number> } = { timestamp: 0, prices: {} };
const MARK_PRICE_TTL = 15000; // 15 seconds

// =====================
// Request throttling & queueing (prevent rate limiting)
// =====================
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1000ms (1s) minimum between ALL requests
let requestQueue: Array<{ url: string; options?: any; resolve: Function; reject: Function }> = [];
let isProcessingQueue = false;
let requestCount = 0;
let binanceRequestCount = 0;
const endpointStats: Record<string, { count: number; totalMs: number }> = {};

function getEndpointKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

function trackRequest(url: string) {
  requestCount += 1;
  if (/binance\.(com|vision)/i.test(url)) {
    binanceRequestCount += 1;
  }
}

async function processRequestQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const { url, options, resolve, reject } = requestQueue.shift()!;
    try {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      
      if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        await new Promise(r => setTimeout(r, waitTime));
      }
      
      lastRequestTime = Date.now();
      
      // Add 5 second timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(`⏱️ Request timeout for URL: ${url.substring(0, 80)}...`);
        controller.abort();
      }, 5000);
      
      const startMs = Date.now();
      const response = await fetch(url, { ...options, signal: controller.signal });
      const durationMs = Date.now() - startMs;
      const endpointKey = getEndpointKey(url);
      if (!endpointStats[endpointKey]) {
        endpointStats[endpointKey] = { count: 0, totalMs: 0 };
      }
      endpointStats[endpointKey].count += 1;
      endpointStats[endpointKey].totalMs += durationMs;
      if (/binance\.(com|vision)/i.test(url) && durationMs >= 3000) {
        console.warn(`⏱️ Slow Binance request (${durationMs}ms): ${endpointKey}`);
      }
      clearTimeout(timeoutId);
      resolve(response);
    } catch (e) {
      console.error(`❌ Fetch error: ${e instanceof Error ? e.message : String(e)}`);
      reject(e);
    }
  }
  
  isProcessingQueue = false;
}

async function throttledFetch(url: string, options?: any): Promise<Response> {
  trackRequest(url);
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, options, resolve, reject });
    processRequestQueue().catch(reject);
  });
}

// =====================
// Binance klines cache
// =====================

// Cache klines to avoid redundant API calls
const klinesCache: Record<string, { data: any[]; timestamp: number }> = {};
const KLINES_CACHE_TTL = 60000; // 60 seconds - reduce API pressure
const MIN_KLINES_REFRESH_MS = 10000; // prevent burst refresh
const INDICATOR_KLINES_LIMIT = 300; // reduce per-alarm klines load
const MAX_REQUEST_RUNTIME_MS = 30000; // keep below Edge 60s timeout
const HARD_TIMEOUT_MS = 25000; // emergency hard stop
const MAX_ALARMS_PER_CRON = 1000; // safety cap per cron (high enough to avoid practical starvation)
const MAX_CLOSE_CHECKS_PER_CRON = Math.min(
  2000,
  Math.max(100, Number(Deno.env.get("MAX_CLOSE_CHECKS_PER_CRON") || "600"))
); // configurable safety cap for large backlogs
const EXTERNAL_CLOSE_GRACE_SECONDS = Math.min(
  300,
  Math.max(15, Number(Deno.env.get("EXTERNAL_CLOSE_GRACE_SECONDS") || "45"))
); // wait briefly before syncing externally closed futures positions
const FORCE_EXTERNAL_CLOSE_MAX_AGE_SECONDS = Math.min(
  24 * 60 * 60,
  Math.max(300, Number(Deno.env.get("FORCE_EXTERNAL_CLOSE_MAX_AGE_SECONDS") || "1800"))
); // hard fallback: do not leave futures signals ACTIVE forever when verification is unavailable
const DISABLE_ALARM_PROCESSING = false; // temporary: close-only mode
const CLOSE_NEAR_TARGET_PCT = 0.3; // only run heavy checks when near TP/SL
const TRIGGER_NEAR_TARGET_PCT = 0.1; // skip indicator klines if far from targets
const BAR_CLOSE_TRIGGER_GRACE_MS = 2 * 60 * 1000; // only allow open signal creation within 2 min after bar close
const OPEN_TELEGRAM_RETRY_MAX_AGE_MS = 3 * 60 * 1000; // do not deliver open-signal messages too late
const CLOSE_TELEGRAM_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // retry failed close notifications within 24h
const ACTIVE_SIGNAL_STATUSES = ["ACTIVE", "active"];
const ACTIVE_ALARM_STATUSES = ["ACTIVE", "active"];

function isActiveLikeStatus(status: any): boolean {
  const normalized = String(status || "").toUpperCase();
  return normalized === "ACTIVE" || normalized === "" || !status;
}

function sanitizeRequestBodyForLog(input: any): any {
  if (!input || typeof input !== "object") return input;
  const clone: Record<string, any> = { ...input };
  const sensitiveKeys = ["api_key", "api_secret", "password", "token", "authorization"];
  for (const key of sensitiveKeys) {
    if (key in clone && clone[key]) {
      const raw = String(clone[key]);
      clone[key] = raw.length > 8 ? `${raw.slice(0, 4)}****${raw.slice(-2)}` : "****";
    }
  }
  if ("telegram_chat_id" in clone && clone.telegram_chat_id) {
    const chat = String(clone.telegram_chat_id);
    clone.telegram_chat_id = chat.length > 4 ? `${chat.slice(0, 2)}****${chat.slice(-2)}` : "****";
  }
  return clone;
}

function extractUserIdFromJwt(token: string): string | null {
  try {
    if (!token || token.split(".").length < 2) return null;
    const payloadPart = token.split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload?.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json");
}

const symbolInfoCache: Record<string, { timestamp: number; data: any }> = {};
const SYMBOL_INFO_TTL = 10 * 60 * 1000;

function normalizeMarketType(value: any): "spot" | "futures" {
  const v = String(value || "").toLowerCase();
  return v === "futures" || v === "future" || v === "perp" || v === "perpetual" ? "futures" : "spot";
}

function timeframeToMinutes(timeframe: string): number {
  const tf = String(timeframe || "").trim().toLowerCase();
  const match = tf.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return 60;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return 60;
  switch (unit) {
    case "m":
      return value;
    case "h":
      return value * 60;
    case "d":
      return value * 1440;
    case "w":
      return value * 10080;
    default:
      return 60;
  }
}

function isWithinBarCloseTriggerWindow(nowMs: number, evaluatedBarOpenMs: number, timeframeMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(evaluatedBarOpenMs) || !Number.isFinite(timeframeMs) || timeframeMs <= 0) {
    return false;
  }
  const evaluatedBarCloseMs = evaluatedBarOpenMs + timeframeMs;
  return nowMs >= evaluatedBarCloseMs && nowMs <= (evaluatedBarCloseMs + BAR_CLOSE_TRIGGER_GRACE_MS);
}

function resolveBarCloseDisplayTimeMs(barOpenOrIso: number | string | undefined, timeframe: string): number {
  const raw = typeof barOpenOrIso === "string"
    ? Date.parse(barOpenOrIso)
    : Number(barOpenOrIso);
  const barOpenMs = Number.isFinite(raw) ? Number(raw) : Date.now();
  const timeframeMs = timeframeToMinutes(String(timeframe || "1h")) * 60 * 1000;
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) return barOpenMs;
  return barOpenMs + timeframeMs;
}


async function getCurrentPrice(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  try {
    const tickerPrice = await getTickerPrice(symbol, marketType, false);
    if (Number.isFinite(tickerPrice)) return tickerPrice;

    const klines = await getKlines(symbol, marketType, "1m", 2);
    if (!klines || klines.length === 0) {
      console.error(`❌ price fetch failed for ${symbol}: klines unavailable`);
      return null;
    }
    const lastKline = klines[klines.length - 1];
    const p = Number(lastKline?.[4]);
    return Number.isFinite(p) ? p : null;
  } catch (e) {
    console.error(`❌ price fetch error for ${symbol}:`, e);
    return null;
  }
}

async function getCurrentPriceFresh(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  try {
    if (binanceBanUntil && Date.now() < binanceBanUntil) return null;
    const tickerPrice = await getTickerPrice(symbol, marketType, true);
    if (Number.isFinite(tickerPrice)) return tickerPrice;

    const klines = await getKlines(symbol, marketType, "1m", 2, 3, true);
    if (!klines || klines.length === 0) {
      console.error(`❌ price fetch failed for ${symbol}: klines unavailable`);
      return null;
    }
    const lastKline = klines[klines.length - 1];
    const p = Number(lastKline?.[4]);
    return Number.isFinite(p) ? p : null;
  } catch (e) {
    console.error(`❌ price fetch error for ${symbol}:`, e);
    return null;
  }
}

async function getTickerPrice(symbol: string, marketType: "spot" | "futures", forceFresh: boolean): Promise<number | null> {
  const cacheKey = `${symbol}:${marketType}:ticker`;
  const now = Date.now();
  if (binanceBanUntil && now < binanceBanUntil) {
    if (priceCache[cacheKey]) return priceCache[cacheKey].price;
    console.warn(`⛔ Binance ban active. Skipping ticker for ${symbol}`);
    return null;
  }
  if (!forceFresh && priceCache[cacheKey] && (now - priceCache[cacheKey].timestamp) < PRICE_CACHE_TTL) {
    return priceCache[cacheKey].price;
  }
  if (forceFresh && priceCache[cacheKey] && (now - priceCache[cacheKey].timestamp) < 3000) {
    return priceCache[cacheKey].price;
  }

  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = `${base}/ticker/price?symbol=${symbol}`;
  const res = await throttledFetch(url);
  if (!res.ok) {
    console.error(`❌ ticker price fetch failed for ${symbol}:`, await res.text());
    return null;
  }
  const data = await res.json();
  const p = Number(data?.price);
  if (!Number.isFinite(p)) return null;
  priceCache[cacheKey] = { price: p, timestamp: now };
  return p;
}

async function getAllTickerPrices(marketType: "spot" | "futures", forceFresh: boolean): Promise<Record<string, number>> {
  const now = Date.now();
  const cached = allTickerCache[marketType];
  if (!forceFresh && cached && (now - cached.timestamp) < ALL_TICKER_TTL) {
    return cached.prices;
  }

  if (binanceBanUntil && now < binanceBanUntil) {
    return cached?.prices || {};
  }

  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = `${base}/ticker/price`;
  const res = await throttledFetch(url);
  if (!res.ok) {
    console.error(`❌ all ticker fetch failed for ${marketType}:`, await res.text());
    return cached?.prices || {};
  }
  const data = await res.json();
  const prices = Array.isArray(data)
    ? data.reduce((acc: Record<string, number>, item: any) => {
        const sym = String(item?.symbol || "").toUpperCase();
        const p = Number(item?.price);
        if (sym && Number.isFinite(p)) acc[sym] = p;
        return acc;
      }, {})
    : {};
  allTickerCache[marketType] = { timestamp: now, prices };
  return prices;
}

async function getFuturesMarkPrice(symbol: string): Promise<number | null> {
  try {
    if (binanceBanUntil && Date.now() < binanceBanUntil) return null;
    const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
    const res = await throttledFetch(url);
    if (!res.ok) {
      console.error("❌ mark price fetch failed:", await res.text());
      return null;
    }
    const data = await res.json();
    const p = Number(data?.markPrice);
    return Number.isFinite(p) ? p : null;
  } catch (e) {
    console.error("❌ mark price fetch error:", e);
    return null;
  }
}

async function getAllFuturesMarkPrices(forceFresh: boolean): Promise<Record<string, number>> {
  const now = Date.now();
  if (!forceFresh && (now - markPriceCache.timestamp) < MARK_PRICE_TTL) {
    return markPriceCache.prices;
  }
  if (binanceBanUntil && now < binanceBanUntil) {
    return markPriceCache.prices;
  }

  const url = "https://fapi.binance.com/fapi/v1/premiumIndex";
  const res = await throttledFetch(url);
  if (!res.ok) {
    console.error("❌ mark price batch fetch failed:", await res.text());
    return markPriceCache.prices;
  }
  const data = await res.json();
  const prices = Array.isArray(data)
    ? data.reduce((acc: Record<string, number>, row: any) => {
        const sym = String(row?.symbol || "").toUpperCase();
        const p = Number(row?.markPrice);
        if (sym && Number.isFinite(p)) acc[sym] = p;
        return acc;
      }, {})
    : {};
  markPriceCache.timestamp = now;
  markPriceCache.prices = prices;
  return prices;
}

// =====================
// BINANCE TRADE EXECUTION
// =====================
async function createBinanceSignature(queryString: string, apiSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = encoder.encode(apiSecret);
  const message = encoder.encode(queryString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function syncBinanceServerTime(force: boolean = false): Promise<void> {
  const now = Date.now();
  if (!force && (now - lastBinanceTimeSyncMs) < BINANCE_TIME_SYNC_TTL_MS) return;
  try {
    const res = await throttledFetch("https://fapi.binance.com/fapi/v1/time");
    if (!res.ok) return;
    const data = await res.json();
    const serverTime = Number(data?.serverTime);
    if (Number.isFinite(serverTime)) {
      binanceTimeOffsetMs = serverTime - Date.now();
      lastBinanceTimeSyncMs = Date.now();
    }
  } catch {
    // no-op
  }
}

async function buildSignedQuery(apiSecret: string, params: string = ""): Promise<{ queryString: string; signature: string }> {
  await syncBinanceServerTime(false);
  const timestamp = Date.now() + binanceTimeOffsetMs;
  const queryString = `${params ? `${params}&` : ""}timestamp=${timestamp}&recvWindow=10000`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  return { queryString, signature };
}

async function getBinanceBalance(apiKey: string, apiSecret: string, marketType: "spot" | "futures"): Promise<number> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);

  const baseUrl = marketType === "futures"
    ? "https://fapi.binance.com/fapi/v2/balance"
    : "https://api.binance.com/api/v3/account";

  const url = `${baseUrl}?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance balance error:", await response.text());
    return 0;
  }

  const data = await response.json();

  if (marketType === "futures") {
    const usdtBalance = data.find((b: any) => b.asset === "USDT");
    return parseFloat(usdtBalance?.availableBalance || "0");
  }

  const usdtBalance = data.balances?.find((b: any) => b.asset === "USDT");
  return parseFloat(usdtBalance?.free || "0");
}

async function getSymbolInfo(symbol: string, marketType: "spot" | "futures"): Promise<{ quantityPrecision: number; minQty: number; pricePrecision: number; tickSize: number; stepSize: number } | null> {
  const cacheKey = `${marketType}:${symbol}`;
  const now = Date.now();
  const cached = symbolInfoCache[cacheKey];
  if (cached && (now - cached.timestamp) < SYMBOL_INFO_TTL) {
    return cached.data;
  }

  if (binanceBanUntil && now < binanceBanUntil) {
    return null;
  }

  const baseUrl = marketType === "futures"
    ? "https://fapi.binance.com/fapi/v1/exchangeInfo"
    : "https://api.binance.com/api/v3/exchangeInfo";

  const response = await throttledFetch(baseUrl);
  if (!response.ok) return null;

  const data = await response.json();
  const symbolInfo = data.symbols?.find((s: any) => s.symbol === symbol);
  if (!symbolInfo) return null;

  const lotSizeFilter = symbolInfo.filters?.find((f: any) => f.filterType === "LOT_SIZE");
  const priceFilter = symbolInfo.filters?.find((f: any) => f.filterType === "PRICE_FILTER");

  const minQty = parseFloat(lotSizeFilter?.minQty || "0.001");
  const stepSize = lotSizeFilter?.stepSize || "0.001";
  const tickSize = priceFilter?.tickSize || "0.01";

  const quantityPrecision = stepSize.includes(".")
    ? stepSize.split(".")[1].replace(/0+$/, "").length
    : 0;

  const pricePrecision = tickSize.includes(".")
    ? tickSize.split(".")[1].replace(/0+$/, "").length
    : 0;

  const resolved = {
    quantityPrecision,
    minQty,
    pricePrecision,
    tickSize: Number(tickSize),
    stepSize: Number(stepSize)
  };

  symbolInfoCache[cacheKey] = { timestamp: now, data: resolved };
  return resolved;
}

async function setLeverage(apiKey: string, apiSecret: string, symbol: string, leverage: number): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);

  const url = `https://fapi.binance.com/fapi/v1/leverage?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Set leverage error for ${symbol}:`, error);
    return false;
  }

  return true;
}

async function getFuturesPositionMode(apiKey: string, apiSecret: string): Promise<"ONE_WAY" | "HEDGE" | "UNKNOWN"> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    return "UNKNOWN";
  }

  const data = await response.json();
  return data?.dualSidePosition ? "HEDGE" : "ONE_WAY";
}

type FuturesOrderType = "MARKET" | "LIMIT";
type OpenTradeOptions = {
  orderType?: FuturesOrderType;
  limitPrice?: string;
  limitTimeoutSeconds?: number;
  quantityPrecision?: number;
  minQty?: number;
  stepSize?: number;
};

const LIMIT_ORDER_POLL_INTERVAL_MS = 2000;

function normalizeFuturesEntryType(value: any): FuturesOrderType {
  return String(value || "MARKET").toUpperCase() === "LIMIT" ? "LIMIT" : "MARKET";
}

function normalizeLimitTimeoutSeconds(value: any): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.max(5, Math.floor(parsed));
}

function roundQuantity(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.floor(value * factor) / factor;
}

function roundToStepDown(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const scaled = Math.floor((value / step) + 1e-8) * step;
  return Number.isFinite(scaled) ? scaled : value;
}

function roundToTick(value: number, tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return value;
  const scaled = Math.round(value / tick) * tick;
  return Number.isFinite(scaled) ? scaled : value;
}

function formatOrderQuantity(
  quantity: number,
  quantityPrecision?: number,
  stepSize?: number
): string {
  let normalized = Number(quantity);
  if (!Number.isFinite(normalized) || normalized <= 0) return "0";

  if (Number.isFinite(stepSize) && Number(stepSize) > 0) {
    normalized = roundToStepDown(normalized, Number(stepSize));
  }

  const resolvedPrecision = Number.isFinite(Number(quantityPrecision))
    ? Math.max(0, Math.floor(Number(quantityPrecision)))
    : 8;

  return normalized.toFixed(resolvedPrecision);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function placeFuturesMarketOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string
): Promise<{ success: boolean; orderId?: string; error?: string; actualSymbol?: string; filledPrice?: number }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&newOrderRespType=RESULT&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  const data = await response.json();
  if (!response.ok) {
    return { success: false, error: data?.msg || "Order failed" };
  }

  const requestedSymbol = String(symbol || "").toUpperCase();
  const actualSymbol = String(data?.symbol || "").toUpperCase();
  if (actualSymbol && requestedSymbol && actualSymbol !== requestedSymbol) {
    console.error("❌ Futures order symbol mismatch", {
      requestedSymbol,
      actualSymbol,
      orderId: data?.orderId,
    });
    return { success: false, error: `Order symbol mismatch: requested ${requestedSymbol}, got ${actualSymbol}`, actualSymbol };
  }

  const avgPrice = Number(data?.avgPrice || 0);
  const fillPrice = Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined;

  return { success: true, orderId: String(data.orderId), actualSymbol, filledPrice: fillPrice };
}

async function placeFuturesLimitOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string,
  price: string
): Promise<{ success: boolean; orderId?: string; error?: string; actualSymbol?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${price}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  const data = await response.json();
  if (!response.ok) {
    return { success: false, error: data?.msg || "Limit order failed" };
  }

  const requestedSymbol = String(symbol || "").toUpperCase();
  const actualSymbol = String(data?.symbol || "").toUpperCase();
  if (actualSymbol && requestedSymbol && actualSymbol !== requestedSymbol) {
    console.error("❌ Futures limit order symbol mismatch", {
      requestedSymbol,
      actualSymbol,
      orderId: data?.orderId,
    });
    return { success: false, error: `Limit order symbol mismatch: requested ${requestedSymbol}, got ${actualSymbol}`, actualSymbol };
  }

  return { success: true, orderId: String(data.orderId), actualSymbol };
}

async function getFuturesOrderDetails(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  orderId: string
): Promise<{ status?: string; executedQty?: number; error?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: errorText || "Order status failed" };
  }

  const data = await response.json();
  return {
    status: data?.status,
    executedQty: Number(data?.executedQty || 0)
  };
}

async function cancelFuturesOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  orderId: string
): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  return response.ok;
}

async function openBinanceTrade(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  quantity: number,
  marketType: "spot" | "futures",
  options: OpenTradeOptions = {}
): Promise<{ success: boolean; orderId?: string; error?: string; filledPrice?: number }> {
  const requestedSymbol = String(symbol || "").toUpperCase();
  const timestamp = Date.now();
  const side = direction === "LONG" ? "BUY" : "SELL";
  const quantityString = formatOrderQuantity(quantity, options.quantityPrecision, options.stepSize);
  if (!Number.isFinite(Number(quantityString)) || Number(quantityString) <= 0) {
    return { success: false, error: `Invalid quantity: ${quantity}` };
  }

  if (marketType === "futures") {
    const orderType = normalizeFuturesEntryType(options.orderType);
    if (orderType === "LIMIT" && options.limitPrice) {
      const limitOrder = await placeFuturesLimitOrder(apiKey, apiSecret, requestedSymbol, side, quantityString, options.limitPrice);
      if (!limitOrder.success || !limitOrder.orderId) {
        return { success: false, error: limitOrder.error || "Limit order failed" };
      }

      const timeoutSeconds = normalizeLimitTimeoutSeconds(options.limitTimeoutSeconds);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let executedQty = 0;

      while (Date.now() < deadline) {
        const details = await getFuturesOrderDetails(apiKey, apiSecret, requestedSymbol, limitOrder.orderId);
        if (details.executedQty) {
          executedQty = details.executedQty;
        }
        if (details.status === "FILLED") {
          return { success: true, orderId: limitOrder.orderId };
        }
        if (details.status === "CANCELED" || details.status === "REJECTED" || details.status === "EXPIRED") {
          break;
        }
        await delay(LIMIT_ORDER_POLL_INTERVAL_MS);
      }

      await cancelFuturesOrder(apiKey, apiSecret, requestedSymbol, limitOrder.orderId);
      if (executedQty > 0) {
        return { success: false, error: `Limit emir dolmadi. Kismi dolum: ${executedQty}. Pozisyonu kontrol et.` };
      }

      return { success: false, error: "Limit emir dolmadi. Islem acilmadi." };
    }

    return placeFuturesMarketOrder(apiKey, apiSecret, requestedSymbol, side, quantityString);
  }

  const queryString = `symbol=${requestedSymbol}&side=${side}&type=MARKET&quantity=${quantityString}&newOrderRespType=FULL&timestamp=${timestamp}`;
  const baseUrl = "https://api.binance.com/api/v3/order";

  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `${baseUrl}?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  const data = await response.json();

  if (!response.ok) {
    return { success: false, error: data?.msg || "Order failed" };
  }

  const actualSymbol = String(data?.symbol || "").toUpperCase();
  if (actualSymbol && requestedSymbol && actualSymbol !== requestedSymbol) {
    console.error("❌ Spot order symbol mismatch", {
      requestedSymbol,
      actualSymbol,
      orderId: data?.orderId,
    });
    return { success: false, error: `Spot order symbol mismatch: requested ${requestedSymbol}, got ${actualSymbol}` };
  }

  let filledPrice: number | undefined;
  const executedQty = Number(data?.executedQty || 0);
  const cumulativeQuoteQty = Number(data?.cummulativeQuoteQty || 0);
  if (Number.isFinite(executedQty) && executedQty > 0 && Number.isFinite(cumulativeQuoteQty) && cumulativeQuoteQty > 0) {
    const weighted = cumulativeQuoteQty / executedQty;
    if (Number.isFinite(weighted) && weighted > 0) {
      filledPrice = weighted;
    }
  }
  if (!filledPrice && Array.isArray(data?.fills) && data.fills.length > 0) {
    const totalQty = data.fills.reduce((sum: number, f: any) => sum + Number(f?.qty || 0), 0);
    const totalQuote = data.fills.reduce((sum: number, f: any) => sum + (Number(f?.price || 0) * Number(f?.qty || 0)), 0);
    if (Number.isFinite(totalQty) && totalQty > 0 && Number.isFinite(totalQuote) && totalQuote > 0) {
      filledPrice = totalQuote / totalQty;
    }
  }

  return { success: true, orderId: String(data.orderId), filledPrice };
}

async function placeTakeProfitStopLoss(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  takeProfit: number,
  stopLoss: number,
  pricePrecision: number,
  quantity: number,
  quantityPrecision: number,
  tickSize: number
): Promise<{ tpOrderId?: string; slOrderId?: string; tpError?: string; slError?: string }> {
  const closeSide = direction === "LONG" ? "SELL" : "BUY";

  let tpValue = Number(takeProfit);
  let slValue = Number(stopLoss);
  const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 1 / Math.pow(10, pricePrecision);
  const currentPrice = await getCurrentPrice(symbol, "futures");
  if (Number.isFinite(currentPrice)) {
    const minOffset = Math.max(currentPrice * 0.001, safeTick * 2);
    if (direction === "LONG") {
      if (tpValue <= currentPrice + minOffset) tpValue = currentPrice + minOffset;
      if (slValue >= currentPrice - minOffset) slValue = Math.max(currentPrice - minOffset, safeTick);
    } else {
      if (tpValue >= currentPrice - minOffset) tpValue = Math.max(currentPrice - minOffset, safeTick);
      if (slValue <= currentPrice + minOffset) slValue = currentPrice + minOffset;
    }
  }

  const tpPrice = roundToTick(tpValue, safeTick).toFixed(pricePrecision);
  const slPrice = roundToTick(slValue, safeTick).toFixed(pricePrecision);

  let tpOrderId: string | undefined;
  let slOrderId: string | undefined;
  let tpError: string | undefined;
  let slError: string | undefined;

  const tpTimestamp = Date.now();
  const algoTp = await placeFuturesAlgoOrder(apiKey, apiSecret, symbol, closeSide, "TAKE_PROFIT_MARKET", tpPrice);
  if (algoTp.ok) {
    tpOrderId = algoTp.orderId;
  } else {
    const tpQuery = `symbol=${symbol}&side=${closeSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tpPrice}&closePosition=true&workingType=MARK_PRICE&priceProtect=true&timestamp=${tpTimestamp}`;
    const tpSignature = await createBinanceSignature(tpQuery, apiSecret);
    const tpResponse = await fetch(`https://fapi.binance.com/fapi/v1/order?${tpQuery}&signature=${tpSignature}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": apiKey }
    });

    if (tpResponse.ok) {
      const tpData = await tpResponse.json();
      tpOrderId = String(tpData.orderId);
    } else {
      const tpErr = await tpResponse.text();
      console.error("❌ TP order failed:", tpErr);
      tpError = algoTp.error || tpErr;
    }
  }

  const slTimestamp = Date.now();
  const algoSl = await placeFuturesAlgoOrder(apiKey, apiSecret, symbol, closeSide, "STOP_MARKET", slPrice);
  if (algoSl.ok) {
    slOrderId = algoSl.orderId;
  } else {
    const slQuery = `symbol=${symbol}&side=${closeSide}&type=STOP_MARKET&stopPrice=${slPrice}&closePosition=true&workingType=MARK_PRICE&priceProtect=true&timestamp=${slTimestamp}`;
    const slSignature = await createBinanceSignature(slQuery, apiSecret);
    const slResponse = await fetch(`https://fapi.binance.com/fapi/v1/order?${slQuery}&signature=${slSignature}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": apiKey }
    });

    if (slResponse.ok) {
      const slData = await slResponse.json();
      slOrderId = String(slData.orderId);
    } else {
      const slErr = await slResponse.text();
      console.error("❌ SL order failed:", slErr);
      slError = algoSl.error || slErr;
    }
  }

  return { tpOrderId, slOrderId, tpError, slError };
}

async function placeFuturesAlgoOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
  stopPrice: string
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const timestamp = Date.now();
  const query = `algoType=CONDITIONAL&symbol=${symbol}&side=${side}&type=${type}&triggerPrice=${stopPrice}`
    + `&closePosition=true&workingType=MARK_PRICE&priceProtect=TRUE&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(query, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/algoOrder?${query}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    console.error("❌ Algo order failed:", text);
    if (contentType.includes("text/html") || text.trim().startsWith("<!DOCTYPE")) {
      return { ok: false, error: "Algo endpoint HTML yanıtı döndü (erişim/engel olabilir)." };
    }
    return { ok: false, error: text };
  }

  const data = await response.json();
  return { ok: true, orderId: String(data?.orderId || data?.algoId || data?.clientAlgoId || "") };
}

function escapeTelegram(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function setFuturesMarginType(apiKey: string, apiSecret: string, symbol: string, marginType: "CROSS" | "ISOLATED"): Promise<void> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&marginType=${marginType}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/marginType?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const text = await response.text();
    if (text.includes("No need to change margin type")) {
      return;
    }
    throw new Error(text || "Margin type update failed");
  }
}

async function placeSpotOco(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  quantity: number,
  quantityPrecision: number,
  stepSize: number,
  takeProfit: number,
  stopLoss: number,
  pricePrecision: number,
  tickSize: number
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  let tpValue = Number(takeProfit);
  let slValue = Number(stopLoss);
  const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 1 / Math.pow(10, pricePrecision);
  const currentPrice = await getCurrentPrice(symbol, "spot");
  if (Number.isFinite(currentPrice)) {
    const minOffset = Math.max(currentPrice * 0.001, safeTick * 2);
    if (tpValue <= currentPrice + minOffset) tpValue = currentPrice + minOffset;
    if (slValue >= currentPrice - minOffset) slValue = Math.max(currentPrice - minOffset, safeTick);
  }

  const tpPrice = roundToTick(tpValue, safeTick).toFixed(pricePrecision);
  const slPrice = roundToTick(slValue, safeTick).toFixed(pricePrecision);
  const offset = Math.max(slValue * 0.001, safeTick);
  const stopLimitValue = Math.max(0, slValue - offset);
  const stopLimitPrice = roundToTick(stopLimitValue, safeTick).toFixed(pricePrecision);

  const quantityString = formatOrderQuantity(quantity, quantityPrecision, stepSize);
  const queryString = `symbol=${symbol}&side=SELL&type=OCO&quantity=${quantityString}`
    + `&price=${tpPrice}&stopPrice=${slPrice}&stopLimitPrice=${stopLimitPrice}`
    + `&stopLimitTimeInForce=GTC&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/order/oco?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: errorText };
  }

  return { success: true };
}

async function hasOpenFuturesPosition(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v2/positionRisk?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance futures position check failed:", await response.text());
    throw new Error("Futures position check failed");
  }

  const data = await response.json();
  const upperSymbol = String(symbol || "").toUpperCase();
  const positions = Array.isArray(data) ? data : [data];
  return hasAnyOpenFuturesPositionForSymbol(positions, upperSymbol);
}

function hasAnyOpenFuturesPositionForSymbol(positions: any[], symbol: string): boolean {
  const upperSymbol = String(symbol || "").toUpperCase();
  if (!upperSymbol || !Array.isArray(positions) || positions.length === 0) return false;

  const POSITION_EPSILON = 1e-10;
  return positions
    .filter((p: any) => String(p?.symbol || "").toUpperCase() === upperSymbol)
    .some((p: any) => {
      const positionAmt = Number(p?.positionAmt || 0);
      const notional = Number(p?.notional || 0);
      return Math.abs(positionAmt) > POSITION_EPSILON || Math.abs(notional) > POSITION_EPSILON;
    });
}

async function hasOpenFuturesOrders(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/openOrders?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance futures open orders check failed:", await response.text());
    throw new Error("Futures open orders check failed");
  }

  const data = await response.json();
  return Array.isArray(data) && data.length > 0;
}

async function getOpenFuturesOrdersAll(apiKey: string, apiSecret: string): Promise<any[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { queryString, signature } = await buildSignedQuery(apiSecret);
    const url = `https://fapi.binance.com/fapi/v1/openOrders?${queryString}&signature=${signature}`;
    const response = await throttledFetch(url, {
      headers: { "X-MBX-APIKEY": apiKey }
    });
    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }
    const errorText = await response.text();
    if (errorText.includes("-1021") && attempt === 0) {
      await syncBinanceServerTime(true);
      continue;
    }
    console.error("❌ Binance futures open orders (all) failed:", errorText);
    return [];
  }
  return [];
}

async function getOpenSpotOrdersAll(apiKey: string, apiSecret: string): Promise<any[]> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/openOrders?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance spot open orders (all) failed:", await response.text());
    return [];
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function getFuturesPositionsAll(apiKey: string, apiSecret: string): Promise<any[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { queryString, signature } = await buildSignedQuery(apiSecret);
    const url = `https://fapi.binance.com/fapi/v2/positionRisk?${queryString}&signature=${signature}`;
    const response = await throttledFetch(url, {
      headers: { "X-MBX-APIKEY": apiKey }
    });
    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }
    const errorText = await response.text();
    if (errorText.includes("-1021") && attempt === 0) {
      await syncBinanceServerTime(true);
      continue;
    }
    console.error("❌ Binance futures positionRisk (all) failed:", errorText);
    return [];
  }
  return [];
}

async function hasOpenFuturesAlgoOrders(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/algoOpenOrders?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.warn("⚠️ Binance futures algo orders check failed:", await response.text());
    return false;
  }

  if (!isJsonResponse(response)) {
    const contentType = response.headers.get("content-type") || "";
    const host = (() => {
      try {
        return new URL(response.url).host;
      } catch {
        return "unknown";
      }
    })();
    console.warn(`⚠️ Binance futures algo orders non-JSON response, skipping. status=${response.status} content-type=${contentType} host=${host}`);
    return false;
  }

  const data = await response.json();
  return Array.isArray(data) && data.length > 0;
}

async function hasOpenSpotOrders(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/openOrders?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance spot open orders check failed:", await response.text());
    throw new Error("Spot open orders check failed");
  }

  const data = await response.json();
  return Array.isArray(data) && data.length > 0;
}

function resolveSpotBaseAsset(symbol: string): string {
  const upper = String(symbol || "").toUpperCase();
  const quoteAssets = ["USDT", "USDC", "BUSD", "TUSD", "FDUSD", "USDP", "DAI"];
  for (const quote of quoteAssets) {
    if (upper.endsWith(quote)) {
      return upper.slice(0, -quote.length);
    }
  }
  return upper;
}

async function getSpotAssetBalance(apiKey: string, apiSecret: string, asset: string): Promise<number> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance spot balance check failed:", await response.text());
    throw new Error("Spot balance check failed");
  }

  const data = await response.json();
  const balances = Array.isArray(data?.balances) ? data.balances : [];
  const upperAsset = String(asset || "").toUpperCase();
  const row = balances.find((b: any) => String(b?.asset || "").toUpperCase() === upperAsset);
  return Number(row?.free || 0) + Number(row?.locked || 0);
}

async function isSpotPositionOpen(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const baseAsset = resolveSpotBaseAsset(symbol);
  const balance = await getSpotAssetBalance(apiKey, apiSecret, baseAsset);
  if (!Number.isFinite(balance) || balance <= 0) return false;

  const info = await getSymbolInfo(symbol, "spot");
  const minQty = Number(info?.minQty || 0);
  const price = await getTickerPrice(symbol, "spot", false);
  const notional = Number.isFinite(price) ? price * balance : NaN;

  const minNotional = 5; // USDT dust threshold
  const qtyBelow = Number.isFinite(minQty) && minQty > 0 ? balance < minQty : false;
  const notionalBelow = Number.isFinite(notional) ? notional < minNotional : true;
  if (qtyBelow && notionalBelow) return false;

  return true;
}

async function getOpenFuturesAlgoOrdersAll(apiKey: string, apiSecret: string): Promise<any[]> {
  if (futuresAlgoEndpointBlockedUntil && Date.now() < futuresAlgoEndpointBlockedUntil) {
    return [];
  }

  const { queryString, signature } = await buildSignedQuery(apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/algoOpenOrders?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    const text = await response.text();
    if (text.includes("<!DOCTYPE") || text.includes("saved from url") || text.includes("/errorPages/")) {
      futuresAlgoEndpointBlockedUntil = Date.now() + 30 * 60 * 1000;
      console.warn("⚠️ Binance futures algo endpoint unavailable (HTML response). Temporarily disabling algo-open-orders checks for 30m.");
      return [];
    }
    console.warn("⚠️ Binance futures algo orders (all) failed:", text);
    return [];
  }

  if (!isJsonResponse(response)) {
    const contentType = response.headers.get("content-type") || "";
    const host = (() => {
      try {
        return new URL(response.url).host;
      } catch {
        return "unknown";
      }
    })();
    console.warn(`⚠️ Binance futures algo orders (all) non-JSON response, skipping. status=${response.status} content-type=${contentType} host=${host}`);
    return [];
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function getSpotBalancesAll(apiKey: string, apiSecret: string): Promise<Record<string, number>> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

  const response = await throttledFetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance spot balances (all) failed:", await response.text());
    return {};
  }

  const data = await response.json();
  const balances = Array.isArray(data?.balances) ? data.balances : [];
  return balances.reduce((acc: Record<string, number>, row: any) => {
    const asset = String(row?.asset || "").toUpperCase();
    const free = Number(row?.free || 0);
    const locked = Number(row?.locked || 0);
    if (asset) acc[asset] = free + locked;
    return acc;
  }, {});
}

type UserBinanceKeys = {
  api_key: string;
  api_secret: string;
  auto_trade_enabled?: boolean | null;
  futures_enabled?: boolean | null;
  spot_enabled?: boolean | null;
};

const userBinanceCache: Record<string, UserBinanceKeys | null> = {};

async function fetchUserBinanceKeys(userId: string): Promise<UserBinanceKeys | null> {
  const { data, error } = await supabase
    .from("user_binance_keys")
    .select("api_key, api_secret, auto_trade_enabled, futures_enabled, spot_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data?.api_key || !data?.api_secret) {
    return null;
  }

  return data as UserBinanceKeys;
}

async function getUserBinanceSettings(userId: string): Promise<UserBinanceKeys | null> {
  if (!userId) return null;
  if (userBinanceCache[userId] !== undefined) return userBinanceCache[userId];
  const settings = await fetchUserBinanceKeys(userId);
  userBinanceCache[userId] = settings;
  return settings;
}

async function resolveAutoTradeEnabled(alarm: any, marketType: "spot" | "futures"): Promise<boolean> {
  if (alarm?.auto_trade_enabled === true) return true;
  const userKeys = await getUserBinanceSettings(String(alarm?.user_id || ""));
  if (!userKeys?.auto_trade_enabled) return false;
  if (marketType === "futures") return userKeys.futures_enabled === true;
  if (marketType === "spot") return userKeys.spot_enabled === true;
  return false;
}

async function executeAutoTrade(
  userId: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  takeProfit: number,
  stopLoss: number,
  marketType: "spot" | "futures"
): Promise<{ success: boolean; message: string; orderId?: string; blockedByOpenPosition?: boolean; executedEntryPrice?: number; executedTakeProfit?: number; executedStopLoss?: number }> {
  try {
    const { data: userProfile } = await supabase
      .from("user_profiles")
      .select("membership_type, is_admin")
      .eq("id", userId)
      .maybeSingle();

    const membershipType = String(userProfile?.membership_type || "standard").toLowerCase();
    const isAdmin = !!userProfile?.is_admin;
    if (!isAdmin && membershipType !== "premium") {
      return { success: false, message: "Otomatik işlem sadece Premium üyeler içindir." };
    }

    const { data: userKeys, error: keysError } = await supabase
      .from("user_binance_keys")
      .select("*")
      .eq("user_id", userId)
      .eq("auto_trade_enabled", true)
      .maybeSingle();

    if (keysError || !userKeys) {
      console.error("❌ Binance keys missing or not enabled:", keysError || "no record");
      return { success: false, message: "Binance anahtarları bulunamadı veya otomatik işlem kapalı." };
    }

    if (marketType === "futures" && !userKeys.futures_enabled) {
      return { success: false, message: "Futures auto-trade not enabled" };
    }
    if (marketType === "spot" && !userKeys.spot_enabled) {
      return { success: false, message: "Spot auto-trade not enabled" };
    }

    const {
      api_key,
      api_secret,
      futures_leverage,
      futures_position_size_percent,
      spot_position_size_percent,
      futures_margin_type,
      futures_entry_type,
      futures_limit_deviation_percent,
      futures_limit_timeout_seconds
    } = userKeys;

    if (marketType === "spot" && direction === "SHORT") {
      return { success: false, message: "Spot SHORT not supported" };
    }

    try {
      if (marketType === "futures") {
        const hasOpen = await hasOpenFuturesPosition(api_key, api_secret, symbol);
        if (hasOpen) {
          return { success: false, message: `Açık futures pozisyonu var (${symbol}). Yeni işlem açılmadı.`, blockedByOpenPosition: true };
        }
      } else {
        const hasOpenOrders = await hasOpenSpotOrders(api_key, api_secret, symbol);
        const hasBalance = await isSpotPositionOpen(api_key, api_secret, symbol);
        if (hasOpenOrders || hasBalance) {
          return { success: false, message: `Açık spot pozisyonu var (${symbol}). Yeni işlem açılmadı.`, blockedByOpenPosition: true };
        }
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : "Unknown error";
      console.error("❌ Open position check failed:", errText);
      return { success: false, message: "Açık pozisyon kontrolü başarısız. İşlem açılmadı." };
    }

    const leverage = marketType === "futures" ? Number(futures_leverage || 10) : 1;
    const positionSizeUsd = marketType === "futures"
      ? Number(futures_position_size_percent || 20)
      : Number(spot_position_size_percent || 20);

    const balance = await getBinanceBalance(api_key, api_secret, marketType);
    if (balance <= 0) {
      return { success: false, message: "Insufficient balance" };
    }

    const tradeAmount = positionSizeUsd;
    if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
      return { success: false, message: "Invalid position size" };
    }
    if (tradeAmount > balance) {
      return { success: false, message: "Insufficient balance" };
    }
    const symbolInfo = await getSymbolInfo(symbol, marketType);
    if (!symbolInfo) {
      return { success: false, message: "Symbol info not found" };
    }

    let quantity = tradeAmount / entryPrice;
    if (marketType === "futures") {
      quantity = (tradeAmount * leverage) / entryPrice;
    }

    quantity = roundToStepDown(quantity, symbolInfo.stepSize);

    if (quantity < symbolInfo.minQty) {
      return { success: false, message: `Quantity too small: ${quantity} < ${symbolInfo.minQty}` };
    }

    const futuresEntryType = normalizeFuturesEntryType(futures_entry_type);
    const deviationRaw = Number(futures_limit_deviation_percent);
    const deviationPercent = Number.isFinite(deviationRaw) ? Math.max(0, deviationRaw) : 0.3;
    const limitTimeoutSeconds = normalizeLimitTimeoutSeconds(futures_limit_timeout_seconds);
    let limitPrice: string | undefined;

    if (marketType === "futures" && futuresEntryType === "LIMIT") {
      const directionFactor = direction === "LONG" ? -1 : 1;
      const limitPriceValue = entryPrice * (1 + directionFactor * deviationPercent / 100);
      if (limitPriceValue > 0) {
        const roundedLimit = roundToTick(limitPriceValue, symbolInfo.tickSize);
        limitPrice = roundedLimit.toFixed(symbolInfo.pricePrecision);
      }
    }

    if (marketType === "futures") {
      const positionMode = await getFuturesPositionMode(api_key, api_secret);
      if (positionMode === "HEDGE") {
        return { success: false, message: "Futures Hedge mode is not supported. Use One-Way." };
      }
      const rawMarginType = String(futures_margin_type || "").trim().toUpperCase();
      const resolvedMarginType = rawMarginType === "ISOLATED" ? "ISOLATED" : "CROSS";
      try {
        await setFuturesMarginType(api_key, api_secret, symbol, resolvedMarginType as "CROSS" | "ISOLATED");
      } catch (e) {
        console.error("❌ Margin type set failed:", e);
        return { success: false, message: "Marjin türü ayarlanamadı. İşlem açılmadı." };
      }
      await setLeverage(api_key, api_secret, symbol, leverage);
    }

    const orderOptions: OpenTradeOptions = marketType === "futures"
      ? {
          orderType: futuresEntryType,
          limitPrice,
          limitTimeoutSeconds,
          quantityPrecision: symbolInfo.quantityPrecision,
          minQty: symbolInfo.minQty,
          stepSize: symbolInfo.stepSize
        }
      : {
          quantityPrecision: symbolInfo.quantityPrecision,
          minQty: symbolInfo.minQty,
          stepSize: symbolInfo.stepSize
        };
    const orderResult = await openBinanceTrade(api_key, api_secret, symbol, direction, quantity, marketType, orderOptions);
    if (!orderResult.success) {
      return { success: false, message: orderResult.error || "Order failed" };
    }

    const effectiveEntryPrice = Number.isFinite(orderResult.filledPrice) && Number(orderResult.filledPrice) > 0
      ? Number(orderResult.filledPrice)
      : entryPrice;
    const tpPercentFromSignal = Math.abs(((takeProfit - entryPrice) / entryPrice) * 100);
    const slPercentFromSignal = Math.abs(((entryPrice - stopLoss) / entryPrice) * 100);
    const adjustedRawTp = direction === "SHORT"
      ? effectiveEntryPrice * (1 - tpPercentFromSignal / 100)
      : effectiveEntryPrice * (1 + tpPercentFromSignal / 100);
    const adjustedRawSl = direction === "SHORT"
      ? effectiveEntryPrice * (1 + slPercentFromSignal / 100)
      : effectiveEntryPrice * (1 - slPercentFromSignal / 100);
    const adjustedTakeProfit = roundToTick(adjustedRawTp, symbolInfo.tickSize);
    const adjustedStopLoss = roundToTick(adjustedRawSl, symbolInfo.tickSize);

    if (marketType === "futures") {
      const tpSlResult = await placeTakeProfitStopLoss(
        api_key,
        api_secret,
        symbol,
        direction,
        adjustedTakeProfit,
        adjustedStopLoss,
        symbolInfo.pricePrecision,
        quantity,
        symbolInfo.quantityPrecision,
        symbolInfo.tickSize
      );
      let warningText = "";
      if (!tpSlResult.tpOrderId && tpSlResult.tpError) {
        warningText += ` TP oluşturulamadı: ${escapeTelegram(tpSlResult.tpError)}`;
      }
      if (!tpSlResult.slOrderId && tpSlResult.slError) {
        warningText += ` SL oluşturulamadı: ${escapeTelegram(tpSlResult.slError)}`;
      }
      if (warningText) {
        return {
          success: true,
          message: `✅ ${direction} ${quantity} ${symbol} (${leverage}x) @ $${effectiveEntryPrice.toFixed(symbolInfo.pricePrecision)}\n⚠️ ${warningText.trim()}`,
          orderId: orderResult.orderId,
          executedEntryPrice: effectiveEntryPrice,
          executedTakeProfit: adjustedTakeProfit,
          executedStopLoss: adjustedStopLoss
        };
      }
    } else {
      const ocoResult = await placeSpotOco(
        api_key,
        api_secret,
        symbol,
        quantity,
        symbolInfo.quantityPrecision,
        symbolInfo.stepSize,
        adjustedTakeProfit,
        adjustedStopLoss,
        symbolInfo.pricePrecision,
        symbolInfo.tickSize
      );
      if (!ocoResult.success) {
        return { success: false, message: `Spot TP/SL OCO failed: ${ocoResult.error || "unknown"}` };
      }
    }

    const leverageText = marketType === "futures" ? ` (${leverage}x)` : "";
    return {
      success: true,
      message: `✅ ${direction} ${quantity} ${symbol}${leverageText} @ $${effectiveEntryPrice.toFixed(symbolInfo.pricePrecision)}`,
      orderId: orderResult.orderId,
      executedEntryPrice: effectiveEntryPrice,
      executedTakeProfit: adjustedTakeProfit,
      executedStopLoss: adjustedStopLoss
    };
  } catch (e) {
    console.error(`❌ Auto-trade error for ${userId}:`, e);
    return { success: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// =====================
// Technical Indicators (Simple)
// =====================
function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period) return 50; // Default middle value

  let gains = 0;
  let losses = 0;

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateStochastic(closes: number[], highs: number[], lows: number[], period: number = 14, smoothK: number = 3): { K: number; D: number } {
  if (closes.length < period) return { K: 50, D: 50 };
  
  let lowestLow = lows[lows.length - 1];
  let highestHigh = highs[highs.length - 1];
  
  for (let i = Math.max(0, closes.length - period); i < closes.length; i++) {
    if (lows[i] < lowestLow) lowestLow = lows[i];
    if (highs[i] > highestHigh) highestHigh = highs[i];
  }
  
  const range = highestHigh - lowestLow;
  const rawK = range === 0 ? 50 : ((closes[closes.length - 1] - lowestLow) / range) * 100;
  
  const kValues: number[] = [rawK];
  for (let i = 1; i < smoothK; i++) {
    kValues.push(rawK);
  }
  const K = kValues.reduce((a, b) => a + b) / smoothK;
  const D = K;
  
  return { K: Math.max(0, Math.min(100, K)), D: Math.max(0, Math.min(100, D)) };
}

function calculateAlarmStochastic(highs: number[], lows: number[], closes: number[], period: number = 14, smoothK: number = 3): { K: number; D: number } {
  if (closes.length < period) return { K: 50, D: 50 };
  let lowestLow = lows[lows.length - 1];
  let highestHigh = highs[highs.length - 1];

  for (let i = Math.max(0, closes.length - period); i < closes.length; i++) {
    if (lows[i] < lowestLow) lowestLow = lows[i];
    if (highs[i] > highestHigh) highestHigh = highs[i];
  }

  const range = highestHigh - lowestLow;
  const rawK = range === 0 ? 50 : ((closes[closes.length - 1] - lowestLow) / range) * 100;
  const kValues: number[] = [];
  for (let i = 0; i < smoothK; i++) kValues.push(rawK);
  const K = kValues.reduce((a, b) => a + b, 0) / smoothK;
  const D = K;
  return { K: Math.max(0, Math.min(100, K)), D: Math.max(0, Math.min(100, D)) };
}

function calculateAlarmADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 25;
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);

    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const plusDI = ((plusDMs.slice(-period).reduce((a, b) => a + b, 0) / period) / atr) * 100;
  const minusDI = ((minusDMs.slice(-period).reduce((a, b) => a + b, 0) / period) / atr) * 100;
  if (!Number.isFinite(plusDI) || !Number.isFinite(minusDI) || plusDI + minusDI === 0) return 25;
  return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
}

function calculateAlarmATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  return Number.isFinite(atr) ? atr : 0;
}

function calculateAlarmMacd(closes: number[]): { macdLine: number; signalLine: number; histogram: number } {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  if (!ema12 || !ema26) return { macdLine: 0, signalLine: 0, histogram: 0 };
  const macdLine = ema12 - ema26;
  const signalLine = calculateEMA(closes.map((_, i) => {
    const window = closes.slice(0, i + 1);
    return window.length >= 26 ? calculateEMA(window, 12) - calculateEMA(window, 26) : 0;
  }), 9);
  const histogram = macdLine - (signalLine || 0);
  return { macdLine, signalLine: signalLine || 0, histogram };
}

function calculateAlarmIndicators(
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
  lastClosedTimestamp?: number
): TechnicalIndicators | null {
  if (!closes || closes.length < 2) return null;
  const lastPrice = closes[closes.length - 1];
  const macdData = calculateAlarmMacd(closes);

  let obv = 0;
  let obvTrend: "rising" | "falling" | "neutral" = "neutral";
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) obv = volumes[i];
    else if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
  }
  if (closes[closes.length - 1] > closes[closes.length - 2]) obvTrend = "rising";
  else if (closes[closes.length - 1] < closes[closes.length - 2]) obvTrend = "falling";

  const highs20 = highs.slice(-20);
  const lows20 = lows.slice(-20);
  const resistance = highs20.length ? Math.max(...highs20) : lastPrice;
  const support = lows20.length ? Math.min(...lows20) : lastPrice;
  const stoch = calculateAlarmStochastic(highs, lows, closes);
  const adx = calculateAlarmADX(highs, lows, closes) || 0;
  const atr = calculateAlarmATR(highs, lows, closes);
  const volumeMA = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

  return {
    rsi: calculateRSI(closes, 14) || 0,
    sma20: calculateSMA(closes, 20) || 0,
    sma50: calculateSMA(closes, 50) || 0,
    ema12: calculateEMA(closes, 12) || 0,
    ema26: calculateEMA(closes, 26) || 0,
    price: lastPrice,
    lastClosedTimestamp: Number.isFinite(lastClosedTimestamp) ? Number(lastClosedTimestamp) : Date.now(),
    closes,
    volumes,
    highs,
    lows,
    macd: macdData.macdLine,
    histogram: macdData.histogram,
    obv,
    obvTrend,
    resistance,
    support,
    stoch,
    adx,
    atr,
    volumeMA,
  };
}

function generateSignalScoreAligned(indicators: TechnicalIndicators, userConfidenceThreshold: number = 70): { direction: "LONG" | "SHORT"; score: number; triggered: boolean; breakdown: any } {
  const breakdown: any = {};

  let trendScore = 0;
  const trendDetails = { emaAlignment: 0, adxBonus: 0 };

  if (indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50) {
    trendScore += 30;
    trendDetails.emaAlignment = 30;
  } else if (indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50) {
    trendScore -= 30;
    trendDetails.emaAlignment = -30;
  }

  const isTrendAlignedForAdx = trendDetails.emaAlignment !== 0;
  if (indicators.adx > 20 && isTrendAlignedForAdx) {
    const adxBonus = Math.min((indicators.adx - 20) * 0.6, 12);
    trendScore += adxBonus;
    trendDetails.adxBonus = adxBonus;
  }

  breakdown.TREND_ANALIZI = {
    score: trendScore,
    weight: "40%",
    details: {
      "EMA12/EMA26 & SMA20/SMA50": `${trendDetails.emaAlignment > 0 ? "LONG" : trendDetails.emaAlignment < 0 ? "SHORT" : "-"} (${trendDetails.emaAlignment})`,
      "ADX > 20 Bonus (Aligned)": `${trendDetails.adxBonus > 0 ? "+" : ""}${trendDetails.adxBonus.toFixed(2)}`,
      "ADX Value": Number(indicators.adx || 0).toFixed(2),
      "EMA12": Number(indicators.ema12 || 0).toFixed(8),
      "EMA26": Number(indicators.ema26 || 0).toFixed(8),
      "SMA20": Number(indicators.sma20 || 0).toFixed(8),
      "SMA50": Number(indicators.sma50 || 0).toFixed(8),
    },
  };

  let momentumScore = 0;
  const momentumDetails = { rsiScore: 0, macdScore: 0, stochScore: 0 };

  if (indicators.rsi < 30) {
    momentumScore += 25;
    momentumDetails.rsiScore = 25;
  } else if (indicators.rsi < 40) {
    momentumScore += 15;
    momentumDetails.rsiScore = 15;
  } else if (indicators.rsi > 70) {
    momentumScore -= 25;
    momentumDetails.rsiScore = -25;
  } else if (indicators.rsi > 60) {
    momentumScore -= 15;
    momentumDetails.rsiScore = -15;
  }

  const macdScore = indicators.macd > 0 ? 10 : -10;
  momentumScore += macdScore;
  momentumDetails.macdScore = macdScore;

  if (indicators.stoch.K < 20) {
    momentumScore += 10;
    momentumDetails.stochScore = 10;
  } else if (indicators.stoch.K > 80) {
    momentumScore -= 10;
    momentumDetails.stochScore = -10;
  }

  breakdown.MOMENTUM_ANALIZI = {
    score: momentumScore,
    weight: "30%",
    details: {
      "RSI": `${Number(indicators.rsi || 0).toFixed(2)} → ${momentumDetails.rsiScore > 0 ? "+" : ""}${momentumDetails.rsiScore}`,
      "MACD": `${indicators.macd > 0 ? "Positive" : "Negative"} → ${momentumDetails.macdScore > 0 ? "+" : ""}${momentumDetails.macdScore}`,
      "Stochastic K": `${Number(indicators.stoch.K || 0).toFixed(2)} → ${momentumDetails.stochScore > 0 ? "+" : ""}${momentumDetails.stochScore}`,
      "MACD Value": Number(indicators.macd || 0).toFixed(8),
      "Stochastic D": Number(indicators.stoch.D || 0).toFixed(2),
    },
  };

  let volumeScore = 0;
  const volumeDetails = { obvScore: 0, volumeMAScore: 0 };

  if (indicators.obvTrend === "rising") {
    volumeScore += 10;
    volumeDetails.obvScore = 10;
  } else if (indicators.obvTrend === "falling") {
    volumeScore -= 10;
    volumeDetails.obvScore = -10;
  }

  const volumes = indicators.volumes || [];
  if (volumes.length >= 2) {
    const lastVolume = volumes[volumes.length - 1];
    const recent = volumes.slice(-10);
    const avgVolume = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
    if (lastVolume > avgVolume) {
      volumeScore += 15;
      volumeDetails.volumeMAScore = 15;
    } else {
      volumeScore -= 10;
      volumeDetails.volumeMAScore = -10;
    }
  }

  breakdown.VOLUME_ANALIZI = {
    score: volumeScore,
    weight: "15%",
    details: {
      "OBV Trend": `${indicators.obvTrend} → ${volumeDetails.obvScore > 0 ? "+" : ""}${volumeDetails.obvScore}`,
      "Volume vs Avg": `${volumeDetails.volumeMAScore > 0 ? "Above Avg" : "Below Avg"} → ${volumeDetails.volumeMAScore > 0 ? "+" : ""}${volumeDetails.volumeMAScore}`,
      "OBV Value": Number(indicators.obv || 0).toFixed(2),
    },
  };

  let srScore = 0;
  const srDetails = { supportProximity: 0, resistanceProximity: 0 };

  if (indicators.resistance > 0 && indicators.support > 0 && indicators.price > 0) {
    const distanceToSupport = (indicators.price - indicators.support) / indicators.price;
    const distanceToResistance = (indicators.resistance - indicators.price) / indicators.price;
    const atrPct = indicators.atr > 0 ? indicators.atr / indicators.price : 0;
    const srThreshold = Math.min(0.04, Math.max(0.01, atrPct * 1.5));

    if (distanceToSupport < srThreshold) {
      srScore += 15;
      srDetails.supportProximity = 15;
    }
    if (distanceToResistance < srThreshold) {
      srScore -= 15;
      srDetails.resistanceProximity = -15;
    }

    breakdown.SUPPORT_RESISTANCE_ANALIZI = {
      score: srScore,
      weight: "15%",
      details: {
        "Support Proximity": `${(distanceToSupport * 100).toFixed(2)}% → ${srDetails.supportProximity > 0 ? "+" : ""}${srDetails.supportProximity}`,
        "Resistance Proximity": `${(distanceToResistance * 100).toFixed(2)}% → ${srDetails.resistanceProximity}`,
        "SR Threshold": `${(srThreshold * 100).toFixed(2)}%`,
        "Support Level": Number(indicators.support || 0).toFixed(8),
        "Resistance Level": Number(indicators.resistance || 0).toFixed(8),
        "Current Price": Number(indicators.price || 0).toFixed(8),
      },
    };
  }

  const normalizedTrendScore = (trendScore / 50) * 40;
  const normalizedMomentumScore = (momentumScore / 50) * 30;
  const normalizedVolumeScore = (volumeScore / 25) * 15;
  const normalizedSRScore = (srScore / 30) * 15;

  const score = normalizedTrendScore + normalizedMomentumScore + normalizedVolumeScore + normalizedSRScore;
  const direction: "LONG" | "SHORT" = score > 0 ? "LONG" : "SHORT";
  const confidence = Math.min(Math.max(Math.abs(score), 0), 100);

  const isDowntrend = indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50;
  const isUptrend = indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50;
  const isAlignedTrend = isUptrend || isDowntrend;
  const trendBlocks = (direction === "LONG" && isDowntrend) || (direction === "SHORT" && isUptrend);
  const hasTrendOk = isAlignedTrend || indicators.adx >= 25;
  const triggered = confidence >= userConfidenceThreshold && hasTrendOk && !trendBlocks;

  breakdown.normalizedScore = {
    trend: normalizedTrendScore.toFixed(2),
    momentum: normalizedMomentumScore.toFixed(2),
    volume: normalizedVolumeScore.toFixed(2),
    sr: normalizedSRScore.toFixed(2),
    total: score.toFixed(2),
  };

  return {
    direction,
    score: Math.round(confidence),
    triggered,
    breakdown,
  };
}

function calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 25;
  
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
    
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    
    let plusDM = 0;
    let minusDM = 0;
    
    if (upMove > downMove && upMove > 0) {
      plusDM = upMove;
    }
    if (downMove > upMove && downMove > 0) {
      minusDM = downMove;
    }
    
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }
  
  const atrSum = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const plusDISum = plusDMs.slice(-period).reduce((a, b) => a + b, 0) / period;
  const minusDISum = minusDMs.slice(-period).reduce((a, b) => a + b, 0) / period;
  
  if (atrSum === 0) return 25;
  
  const plusDI = (plusDISum / atrSum) * 100;
  const minusDI = (minusDISum / atrSum) * 100;
  
  const diSum = plusDI + minusDI;
  const adx = diSum === 0 ? 25 : Math.abs(plusDI - minusDI) / diSum * 100;
  
  return Math.min(100, adx);
}

async function getKlines(
  symbol: string,
  marketType: "spot" | "futures",
  timeframe: string = "1h",
  limit: number = 100,
  retries: number = 3,
  forceRefresh: boolean = false
): Promise<any[] | null> {
  const cacheKey = `${symbol}:${marketType}:${timeframe}`;
  const now = Date.now();

  if (binanceBanUntil && now < binanceBanUntil) {
    const waitMs = binanceBanUntil - now;
    if (klinesCache[cacheKey]) return klinesCache[cacheKey].data;
    console.warn(`⛔ Binance ban active. Skipping klines for ${symbol} (wait ${(waitMs / 1000).toFixed(0)}s)`);
    return null;
  }
  
  // Check klines cache first
  if (!forceRefresh && klinesCache[cacheKey] && (now - klinesCache[cacheKey].timestamp) < KLINES_CACHE_TTL) {
    console.log(`💾 Klines cache hit for ${cacheKey}`);
    return klinesCache[cacheKey].data;
  }
  if (forceRefresh && klinesCache[cacheKey] && (now - klinesCache[cacheKey].timestamp) < MIN_KLINES_REFRESH_MS) {
    return klinesCache[cacheKey].data;
  }

  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = `${base}/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await throttledFetch(url);
      
      // 418 = Rate Limit, 429 = Too Many Requests
      if (res.status === 418 || res.status === 429) {
        const errorText = await res.text();

        // Parse ban-until timestamp if present
        const banMatch = errorText.match(/banned until (\d+)/i);
        if (banMatch && banMatch[1]) {
          const until = Number(banMatch[1]);
          if (Number.isFinite(until) && until > now) {
            binanceBanUntil = until;
          }
        } else if (res.status === 418) {
          // Fallback: short cooldown if no timestamp provided
          binanceBanUntil = now + 5 * 60 * 1000;
        }

        // ULTRA-AGGRESSIVE backoff: 4s, 16s, 64s with random jitter (±20%)
        const baseBackoff = Math.pow(4, attempt) * 1000; // 4s, 16s, 64s
        const jitter = baseBackoff * (0.8 + Math.random() * 0.4); // ±20% random
        const backoffMs = Math.round(jitter);
        console.warn(`⚠️ Rate limited (${res.status}) for ${symbol}, attempt ${attempt + 1}/${retries}, waiting ${backoffMs}ms (${(backoffMs / 1000).toFixed(1)}s)...`);
        
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        } else {
          // Last attempt failed - return null immediately
          console.error(`❌ klines fetch failed for ${symbol} after ${retries} attempts:`, res.status, errorText);
          return null;
        }
      }
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error(`❌ klines fetch failed for ${symbol}:`, res.status, errorText);
        return null;
      }
      
      const klines = await res.json();
      requestMetrics.klinesFetched += 1;
      // Cache the klines
      klinesCache[cacheKey] = { data: klines, timestamp: now };
      return klines;
    } catch (e) {
      console.error(`❌ klines fetch error for ${symbol} (attempt ${attempt + 1}):`, e);
      if (attempt < retries - 1) {
        const backoffMs = Math.pow(3, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  console.error(`❌ klines fetch failed after ${retries} retries for ${symbol}`);
  return null;
}

async function getKlinesRange(
  symbol: string,
  marketType: "spot" | "futures",
  timeframe: string,
  startTimeMs: number,
  endTimeMs: number,
  limit: number = 1000,
  retries: number = 2
): Promise<any[] | null> {
  if (binanceBanUntil && Date.now() < binanceBanUntil) {
    console.warn(`⛔ Binance ban active. Skipping klines range for ${symbol}`);
    return null;
  }
  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = `${base}/klines?symbol=${symbol}&interval=${timeframe}&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=${limit}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await throttledFetch(url);
      if (!res.ok) {
        const errorText = await res.text();
        console.error(`❌ klines range fetch failed for ${symbol}:`, res.status, errorText);
        return null;
      }
      requestMetrics.klinesFetched += 1;
      return await res.json();
    } catch (e) {
      console.error(`❌ klines range fetch error for ${symbol} (attempt ${attempt + 1}):`, e);
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return null;
}

interface TechnicalIndicators {
  rsi: number;
  sma20: number;
  sma50: number;
  ema12: number;
  ema26: number;
  price: number;
  lastClosedTimestamp: number;
  closes: number[];
  volumes: number[];
  highs: number[];
  lows: number[];
  macd: number;
  histogram: number;
  obv: number;
  obvTrend: "rising" | "falling" | "neutral";
  resistance: number;
  support: number;
  stoch: { K: number; D: number };
  adx: number;
  atr: number;
  volumeMA: number;
  lastOpenTimestamp?: number;
  openPrice?: number;
}

async function calculateIndicators(symbol: string, marketType: "spot" | "futures", timeframe: string = "1h"): Promise<TechnicalIndicators | null> {
  const MIN_INDICATOR_WINDOW = 100;
  let klines = await getKlines(symbol, marketType, timeframe, INDICATOR_KLINES_LIMIT);
  if (!klines || klines.length < 2) return null;

  // ✅ Backtest ile birebir uyum için açık (son) bar'ı dahil etme
  let closedKlines = klines.slice(0, -1);
  if (closedKlines.length < MIN_INDICATOR_WINDOW) return null;
  let windowSize = Math.min(1000, closedKlines.length);
  let window = closedKlines.slice(-windowSize);

  let closes = window.map((k: any) => parseFloat(k[4]));
  let volumes = window.map((k: any) => parseFloat(k[5]));
  let highs = window.map((k: any) => parseFloat(k[2]));
  let lows = window.map((k: any) => parseFloat(k[3]));
  let lastClosedKline = window[window.length - 1];
  let lastClosedTimestamp = Number(lastClosedKline?.[6] ?? lastClosedKline?.[0] ?? Date.now());

  let lastOpenTimestamp = Number(klines[klines.length - 1]?.[0] ?? Date.now());
  let openPrice = Number(klines[klines.length - 1]?.[1] ?? closes[closes.length - 1]);

  const timeframeMinutes = timeframeToMinutes(timeframe);
  const timeframeMs = timeframeMinutes * 60 * 1000;
  if (timeframeMs > 0) {
    const nowMs = Date.now();
    const expectedOpenMs = Math.floor(nowMs / timeframeMs) * timeframeMs;
    const isStale = lastOpenTimestamp < (expectedOpenMs - 2000);
    const afterOpen = nowMs >= expectedOpenMs + 1000;

    if (isStale && afterOpen) {
      klines = await getKlines(symbol, marketType, timeframe, INDICATOR_KLINES_LIMIT, 3, true);
      if (!klines || klines.length < 2) return null;
      closedKlines = klines.slice(0, -1);
      if (closedKlines.length < MIN_INDICATOR_WINDOW) return null;
      windowSize = Math.min(1000, closedKlines.length);
      window = closedKlines.slice(-windowSize);
      closes = window.map((k: any) => parseFloat(k[4]));
      volumes = window.map((k: any) => parseFloat(k[5]));
      highs = window.map((k: any) => parseFloat(k[2]));
      lows = window.map((k: any) => parseFloat(k[3]));
      lastClosedKline = window[window.length - 1];
      lastClosedTimestamp = Number(lastClosedKline?.[6] ?? lastClosedKline?.[0] ?? Date.now());
      lastOpenTimestamp = Number(klines[klines.length - 1]?.[0] ?? Date.now());
      openPrice = Number(klines[klines.length - 1]?.[1] ?? closes[closes.length - 1]);
    }
  }

  const indicators = calculateAlarmIndicators(closes, highs, lows, volumes, lastClosedTimestamp);
  if (!indicators) return null;

  return {
    ...indicators,
    lastOpenTimestamp: Number.isFinite(lastOpenTimestamp) ? lastOpenTimestamp : Date.now(),
    openPrice: Number.isFinite(openPrice) ? openPrice : indicators.price
  };
}

// =====================
// Full Signal Generation (Back Test Aligned - 40-30-15-15 weights)
// =====================
function generateSignalScore(indicators: TechnicalIndicators, userConfidenceThreshold: number = 70): { direction: "LONG" | "SHORT"; score: number; triggered: boolean; breakdown: any } {
  const breakdown: any = {};

  // ===== TREND ANALİZİ (%40) =====
  let trendScore = 0;
  let trendDetails = {
    emaAlignment: 0,
    adxBonus: 0
  };

  // Multi Timeframe trend alignment (EMA12/EMA26 + SMA20/SMA50)
  if (indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50) {
    trendScore += 30; // LONG alignment
    trendDetails.emaAlignment = 30;
  } else if (indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50) {
    trendScore -= 30; // SHORT alignment
    trendDetails.emaAlignment = -30;
  }

  // ADX trend gücü
  if (indicators.adx > 25) {
    const adxBonus = Math.min((indicators.adx - 25) * 0.8, 20);
    trendScore += adxBonus;
    trendDetails.adxBonus = adxBonus;
  }

  breakdown.TREND_ANALIZI = {
    score: trendScore,
    weight: "40%",
    details: {
      "EMA12/EMA26 & SMA20/SMA50": `${trendDetails.emaAlignment > 0 ? "✅ LONG" : trendDetails.emaAlignment < 0 ? "⚠️ SHORT" : "-"} (${trendDetails.emaAlignment})`,
      "ADX > 25 Bonus": `${trendDetails.adxBonus > 0 ? "+" : ""}${trendDetails.adxBonus.toFixed(2)}`,
      "ADX Value": indicators.adx.toFixed(2),
      "EMA12": indicators.ema12.toFixed(8),
      "EMA26": indicators.ema26.toFixed(8),
      "SMA20": indicators.sma20.toFixed(8),
      "SMA50": indicators.sma50.toFixed(8)
    }
  };

  // ===== MOMENTUM ANALİZİ (%30) =====
  let momentumScore = 0;
  let momentumDetails = {
    rsiScore: 0,
    macdScore: 0,
    stochScore: 0
  };

  // RSI
  if (indicators.rsi < 30) {
    momentumScore += 25;
    momentumDetails.rsiScore = 25;
  } else if (indicators.rsi < 40) {
    momentumScore += 15;
    momentumDetails.rsiScore = 15;
  } else if (indicators.rsi > 70) {
    momentumScore -= 25;
    momentumDetails.rsiScore = -25;
  } else if (indicators.rsi > 60) {
    momentumScore -= 15;
    momentumDetails.rsiScore = -15;
  }

  // MACD
  const macdScore = indicators.macd > 0 ? 10 : -10;
  momentumScore += macdScore;
  momentumDetails.macdScore = macdScore;

  // Stochastic
  if (indicators.stoch.K < 20) {
    momentumScore += 10; // Oversold
    momentumDetails.stochScore = 10;
  } else if (indicators.stoch.K > 80) {
    momentumScore -= 10; // Overbought
    momentumDetails.stochScore = -10;
  }

  breakdown.MOMENTUM_ANALIZI = {
    score: momentumScore,
    weight: "30%",
    details: {
      "RSI": `${indicators.rsi.toFixed(2)} → ${momentumDetails.rsiScore > 0 ? "+" : ""}${momentumDetails.rsiScore}`,
      "MACD": `${indicators.macd > 0 ? "Positive" : "Negative"} → ${momentumDetails.macdScore > 0 ? "+" : ""}${momentumDetails.macdScore}`,
      "Stochastic K": `${indicators.stoch.K.toFixed(2)} → ${momentumDetails.stochScore > 0 ? "+" : ""}${momentumDetails.stochScore}`,
      "MACD Value": indicators.macd.toFixed(8),
      "Stochastic D": indicators.stoch.D.toFixed(2)
    }
  };

  // ===== VOLUME ANALİZİ (%15) =====
  let volumeScore = 0;
  let volumeDetails = {
    obvScore: 0,
    volumeMAScore: 0
  };

  // OBV trend
  if (indicators.obvTrend === "rising") {
    volumeScore += 10;
    volumeDetails.obvScore = 10;
  } else if (indicators.obvTrend === "falling") {
    volumeScore -= 10;
    volumeDetails.obvScore = -10;
  }

  // Volume spike check (last vs recent average)
  const volumes = indicators.volumes || [];
  if (volumes.length >= 2) {
    const lastVolume = volumes[volumes.length - 1];
    const recent = volumes.slice(-10);
    const avgVolume = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
    if (lastVolume > avgVolume) {
      volumeScore += 15;
      volumeDetails.volumeMAScore = 15;
    } else {
      volumeScore -= 10;
      volumeDetails.volumeMAScore = -10;
    }
  }

  breakdown.VOLUME_ANALIZI = {
    score: volumeScore,
    weight: "15%",
    details: {
      "OBV Trend": `${indicators.obvTrend} → ${volumeDetails.obvScore > 0 ? "+" : ""}${volumeDetails.obvScore}`,
      "Volume vs Avg": `${volumeDetails.volumeMAScore > 0 ? "Above Avg" : "Below Avg"} → ${volumeDetails.volumeMAScore > 0 ? "+" : ""}${volumeDetails.volumeMAScore}`,
      "OBV Value": indicators.obv.toFixed(2)
    }
  };

  // ===== SUPPORT/RESISTANCE ANALİZİ (%15) =====
  let srScore = 0;
  let srDetails = {
    supportProximity: 0,
    resistanceProximity: 0,
    fibonacciBonus: 0
  };

  if (indicators.resistance > 0 && indicators.support > 0 && indicators.price > 0) {
    const distanceToSupport = (indicators.price - indicators.support) / indicators.price;
    const distanceToResistance = (indicators.resistance - indicators.price) / indicators.price;

    // Support'a yakınlık < 2%
    if (distanceToSupport < 0.02) {
      srScore += 15;
      srDetails.supportProximity = 15;
    }
    // Direnç'e yakınlık < 2%
    if (distanceToResistance < 0.02) {
      srScore -= 15;
      srDetails.resistanceProximity = -15;
    }

    breakdown.SUPPORT_RESISTANCE_ANALIZI = {
      score: srScore,
      weight: "15%",
      details: {
        "Support Proximity": `${(distanceToSupport * 100).toFixed(2)}% → ${srDetails.supportProximity > 0 ? "+" : ""}${srDetails.supportProximity}`,
        "Resistance Proximity": `${(distanceToResistance * 100).toFixed(2)}% → ${srDetails.resistanceProximity}`,
        "Support Level": indicators.support.toFixed(8),
        "Resistance Level": indicators.resistance.toFixed(8),
        "Current Price": indicators.price.toFixed(8)
      }
    };
  }

  // ===== NORMALIZE VE AĞIRLIKLA =====
  const normalizedTrendScore = (trendScore / 50) * 40; // -50 to +50 → ±40
  const normalizedMomentumScore = (momentumScore / 50) * 30; // -50 to +50 → ±30
  const normalizedVolumeScore = (volumeScore / 25) * 15; // -25 to +25 → ±15
  const normalizedSRScore = (srScore / 30) * 15; // -30 to +30 → ±15

  let score = normalizedTrendScore + normalizedMomentumScore + normalizedVolumeScore + normalizedSRScore;

  // Clamp to 0-100
  const direction = score > 0 ? "LONG" : "SHORT";
  const confidence = Math.min(Math.max(Math.abs(score), 0), 100);

  // Trend filtresi: downtrend LONG, uptrend SHORT engelle
  const isDowntrend = indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50;
  const isUptrend = indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50;
  const trendBlocks = (direction === "LONG" && isDowntrend) || (direction === "SHORT" && isUptrend);
  const triggered = confidence >= userConfidenceThreshold && !trendBlocks;

  breakdown.normalizedScore = {
    trend: normalizedTrendScore.toFixed(2),
    momentum: normalizedMomentumScore.toFixed(2),
    volume: normalizedVolumeScore.toFixed(2),
    sr: normalizedSRScore.toFixed(2),
    total: score.toFixed(2),
  };

  return {
    direction,
    score: Math.round(confidence),
    triggered,
    breakdown,
  };
}

// =====================
// Telegram
// =====================
type TelegramSendResult = { ok: boolean; status: "SENT" | "FAILED" | "SKIPPED"; error?: string };

async function sendTelegramNotification(userId: string, message: string): Promise<TelegramSendResult> {
  try {
    const { data: userSettings, error } = await supabase
      .from("user_settings")
      .select("telegram_chat_id, telegram_username, notifications_enabled")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ user_settings fetch error:", error);
      return { ok: false, status: "FAILED", error: "user_settings_error" };
    }
    if (userSettings?.notifications_enabled === false) {
      console.log(`⚠️ Notifications disabled for user ${userId}`);
      return { ok: false, status: "SKIPPED", error: "notifications_disabled" };
    }

    const chatId = userSettings?.telegram_chat_id || userSettings?.telegram_username;
    if (!chatId) {
      console.log(`⚠️ No Telegram chat ID for user ${userId}`);
      return { ok: false, status: "SKIPPED", error: "missing_chat_id" };
    }

    const botUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    const payload = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });

    const resp = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("❌ Telegram send failed:", resp.status, errorText);
      const retryResp = await fetch(botUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (!retryResp.ok) {
        const retryText = await retryResp.text();
        console.error("❌ Telegram retry failed:", retryResp.status, retryText);
        return { ok: false, status: "FAILED", error: `send_failed:${resp.status}` };
      }
    }

    console.log(`✅ Telegram message sent to user ${userId}`);
    return { ok: true, status: "SENT" };
  } catch (e) {
    console.error("❌ Telegram notification error:", e);
    return { ok: false, status: "FAILED", error: e instanceof Error ? e.message : "unknown_error" };
  }
}

async function buildAlarmNotificationMessage(notificationType: string, alarm: any): Promise<string> {
  const type = String(notificationType || "").toLowerCase();
  const symbol = String(alarm?.symbol || "").toUpperCase();
  if (!symbol) return "";

  const marketType = normalizeMarketType(alarm?.marketType || alarm?.market_type || alarm?.market || "spot");
  const timeframe = String(alarm?.timeframe || "1h");
  const precision = await getSymbolPricePrecision(symbol, marketType);
  const pricePrecision = Number.isFinite(precision) ? Number(precision) : 6;
  const formatPrice = (value: any) => Number.isFinite(Number(value))
    ? formatPriceWithPrecision(Number(value), pricePrecision)
    : "?";

  const directionRaw = String(alarm?.direction || "LONG").toUpperCase();
  const direction = directionRaw === "SHORT" ? "SHORT" : "LONG";
  const directionTR = direction === "SHORT" ? "🔴 SHORT" : "🟢 LONG";

  const entryPrice = alarm?.entryPrice ?? alarm?.entry_price ?? alarm?.entry;
  const takeProfit = alarm?.takeProfit ?? alarm?.take_profit;
  const stopLoss = alarm?.stopLoss ?? alarm?.stop_loss;
  const currentPrice = alarm?.currentPrice ?? alarm?.closePrice ?? alarm?.price;
  const targetPrice = alarm?.targetPrice ?? alarm?.target_price ?? alarm?.target;
  const condition = String(alarm?.condition || "");
  const triggerReason = String(alarm?.triggerReason || alarm?.reason || "");
  const timestamp = alarm?.signal_timestamp || alarm?.timestamp || new Date().toISOString();
  const formattedDate = formatTurkeyDateTime(timestamp);

  if (type === "created") {
    if (Number.isFinite(Number(targetPrice))) {
      const conditionText = condition === "below" ? "⬇️" : "⬆️";
      return `🔔 <b>ALARM OLUŞTURULDU</b> 🔔\n\n💰 Çift: <b>${escapeHtml(symbol)}</b>\n${conditionText} Hedef: <b>$${escapeHtml(formatPrice(targetPrice))}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>`;
    }
    return `🔔 <b>ALARM OLUŞTURULDU</b> 🔔\n\n💰 Çift: <b>${escapeHtml(symbol)}</b>\n📊 Piyasa: <b>${escapeHtml(String(marketType).toUpperCase())}</b> | Zaman: <b>${escapeHtml(timeframe)}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>`;
  }

  if (type === "passive") {
    return `⏹️ <b>ALARM PASİF</b>\n\n💰 Çift: <b>${escapeHtml(symbol)}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>`;
  }

  if (type === "ended") {
    return `🚫 <b>ALARM KAPATILDI</b>\n\n💰 Çift: <b>${escapeHtml(symbol)}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>`;
  }

  // trigger / default
  if (String(alarm?.type || "").toUpperCase() === "PRICE_LEVEL" && Number.isFinite(Number(targetPrice))) {
    return `🚨 <b>${escapeHtml(symbol)}</b> Alarm Tetiklendi\n\n🎯 Hedef: <b>$${escapeHtml(formatPrice(targetPrice))}</b>\n💹 Fiyat: <b>$${escapeHtml(formatPrice(currentPrice))}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>`;
  }

  return `🔔 <b>ALARM AKTİVE!</b> 🔔\n\n💰 Çift: <b>${escapeHtml(symbol)}</b>\n🎯 ${escapeHtml(directionTR)}\n📊 Piyasa: <b>${escapeHtml(String(marketType).toUpperCase())}</b> | Zaman: <b>${escapeHtml(timeframe)}</b>\n💹 Fiyat: <b>$${escapeHtml(formatPrice(entryPrice))}</b>\n🎯 Hedefler:\n  TP: <b>$${escapeHtml(formatPrice(takeProfit))}</b>\n  SL: <b>$${escapeHtml(formatPrice(stopLoss))}</b>\n⏰ Zaman: <b>${escapeHtml(formattedDate)}</b>\n${triggerReason ? `\n${escapeHtml(triggerReason)}` : ""}`;
}

async function updateActiveSignalTelegramStatus(
  signalId: string | number,
  status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED",
  error: string | null = null
): Promise<void> {
  try {
    const updatePayload: Record<string, unknown> = {
      telegram_status: status,
      telegram_error: error,
    };
    if (status === "SENT") {
      updatePayload.telegram_sent_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from("active_signals")
      .update(updatePayload)
      .eq("id", signalId);

    if (updateError) {
      console.warn(`⚠️ Failed to update telegram status for signal ${signalId}:`, updateError);
    }
  } catch (e) {
    console.warn(`⚠️ Telegram status update error for signal ${signalId}:`, e);
  }
}

async function buildActiveSignalOpenMessage(signal: any): Promise<string> {
  const symbol = String(signal?.symbol || "").toUpperCase();
  if (!symbol) return "";
  const marketType = normalizeMarketType(signal?.market_type || signal?.marketType || signal?.market || "spot");
  const precision = await getSymbolPricePrecision(symbol, marketType);
  const direction = String(signal?.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const directionTR = direction === "SHORT" ? "🔴 SHORT" : "🟢 LONG";
  const safeSymbol = escapeHtml(symbol);
  const safeDirection = escapeHtml(directionTR);
  const safeMarketType = escapeHtml(String(marketType || "spot").toUpperCase());
  const safeTimeframe = escapeHtml(String(signal?.timeframe || "1h"));
  const safeEntry = escapeHtml(formatPriceWithPrecision(Number(signal?.entry_price), precision));
  const safeTp = escapeHtml(formatPriceWithPrecision(Number(signal?.take_profit), precision));
  const safeSl = escapeHtml(formatPriceWithPrecision(Number(signal?.stop_loss), precision));
  const safeDate = escapeHtml(formatTurkeyDateTime(resolveBarCloseDisplayTimeMs(signal?.signal_timestamp || signal?.created_at, String(signal?.timeframe || "1h"))));
  const tpPercent = Number(signal?.tp_percent);
  const slPercent = Number(signal?.sl_percent);

  return `
🔔 <b>ALARM AKTİVE!</b> 🔔

💰 Çift: <b>${safeSymbol}</b>
🎯 ${safeDirection} Sinyali Tespit Edildi!

📊 Piyasa: <b>${safeMarketType}</b> | Zaman: <b>${safeTimeframe}</b>
💹 Fiyat: <b>$${safeEntry}</b>

🎯 Hedefler:
  TP: <b>$${safeTp}</b> (<b>+${Number.isFinite(tpPercent) ? tpPercent : 0}%</b>)
  SL: <b>$${safeSl}</b> (<b>-${Number.isFinite(slPercent) ? slPercent : 0}%</b>)

⏰ Zaman: <b>${safeDate}</b>
`;
}

async function retryFailedOpenTelegrams(): Promise<void> {
  const since = new Date(Date.now() - OPEN_TELEGRAM_RETRY_MAX_AGE_MS).toISOString();
  const { data: signals, error } = await supabase
    .from("active_signals")
    .select("id, user_id, symbol, market_type, timeframe, direction, entry_price, take_profit, stop_loss, tp_percent, sl_percent, signal_timestamp, created_at, telegram_status, telegram_error")
    .in("status", ACTIVE_SIGNAL_STATUSES)
    .eq("telegram_status", "FAILED")
    .gte("created_at", since);

  if (error || !signals?.length) return;

  for (const signal of signals) {
    const signalTsMs = Date.parse(String(signal?.signal_timestamp || signal?.created_at || ""));
    const signalAgeMs = Number.isFinite(signalTsMs) ? (Date.now() - signalTsMs) : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(signalTsMs) || signalAgeMs > OPEN_TELEGRAM_RETRY_MAX_AGE_MS) {
      await updateActiveSignalTelegramStatus(signal.id, "SKIPPED", "stale_retry_window_exceeded");
      continue;
    }
    const errorText = String(signal?.telegram_error || "");
    if (errorText.includes("missing_chat_id") || errorText.includes("notifications_disabled")) {
      continue;
    }
    const message = await buildActiveSignalOpenMessage(signal);
    if (!message) continue;
    await updateActiveSignalTelegramStatus(signal.id, "QUEUED", null);
    const sendResult = await sendTelegramNotification(signal.user_id, message);
    await updateActiveSignalTelegramStatus(signal.id, sendResult.status, sendResult.error ?? null);
  }
}

function buildClosedSignalTelegramMessage(signal: {
  symbol: string;
  direction: string;
  close_reason: string;
  price: number;
  profitLoss?: number;
  profit_loss?: number;
  market_type?: string;
}): Promise<string> {
  return (async () => {
    let statusMessage = "⛔ KAPANDI - STOP LOSS HIT!";
    let emoji = "⚠️";
    const reason = String(signal.close_reason || "").toUpperCase();
    if (reason === "TP_HIT") {
      statusMessage = "✅ KAPANDI - TP HIT!";
      emoji = "🎉";
    } else if (reason === "NOT_FILLED") {
      statusMessage = "⚠️ İŞLEM AÇILMADI - LIMIT DOLMADI";
      emoji = "🚫";
    } else if (reason === "TIMEOUT") {
      statusMessage = "⏱️ KAPANDI - TIMEOUT";
      emoji = "⏱️";
    } else if (reason === "EXTERNAL_CLOSE") {
      statusMessage = "🧭 KAPANDI - BINANCE'DE DIŞSAL KAPANIŞ";
      emoji = "🧭";
    }

    const precision = await getSymbolPricePrecision(
      String(signal.symbol || "").toUpperCase(),
      normalizeMarketType(signal.market_type || "spot")
    );

    const safeSymbol = escapeHtml(String(signal.symbol || ""));
    const safeDirection = escapeHtml(String(signal.direction || ""));
    const safePrice = escapeHtml(formatPriceWithPrecision(Number(signal.price), precision));
    const pnl = Number.isFinite(Number(signal.profitLoss))
      ? Number(signal.profitLoss)
      : Number(signal.profit_loss);
    const safePnL = escapeHtml(Number.isFinite(pnl)
      ? (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%"
      : "N/A");

    return `
🔔 <b>İŞLEM KAPANDI</b> 🔔

📊 Coin: <b>${safeSymbol}</b>
📈 İşlem Yönü: <b>${safeDirection}</b>
${emoji} ${statusMessage}
💰 Kapanış Fiyatı: <b>$${safePrice}</b>
    📈 Kar/Zarar: <b>${safePnL}</b>
`;
  })();
}

async function retryFailedCloseTelegrams(): Promise<void> {
  const since = new Date(Date.now() - CLOSE_TELEGRAM_RETRY_MAX_AGE_MS).toISOString();
  const { data: signals, error } = await supabase
    .from("active_signals")
    .select("id, user_id, symbol, direction, close_reason, market_type, closed_at, profit_loss, entry_price, take_profit, stop_loss, telegram_close_status, telegram_close_error")
    .eq("status", "CLOSED")
    .gte("closed_at", since)
    .order("closed_at", { ascending: false })
    .limit(200);

  if (error || !signals?.length) return;

  const retryCandidates = signals.filter((signal: any) => {
    const status = String(signal?.telegram_close_status || "").toUpperCase();
    return status === "FAILED" || status === "";
  });

  for (const signal of retryCandidates) {
    const closedMs = Date.parse(String(signal?.closed_at || ""));
    const ageMs = Number.isFinite(closedMs) ? (Date.now() - closedMs) : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(closedMs) || ageMs > CLOSE_TELEGRAM_RETRY_MAX_AGE_MS) {
      await updateActiveSignalCloseTelegramStatus(signal.id, "SKIPPED", "stale_retry_window_exceeded");
      continue;
    }
    const errorText = String(signal?.telegram_close_error || "");
    if (errorText.includes("missing_chat_id") || errorText.includes("notifications_disabled")) {
      continue;
    }

    const reason = String(signal?.close_reason || "").toUpperCase();
    if (reason === "NOT_FILLED" || reason === "EXTERNAL_CLOSE") {
      await updateActiveSignalCloseTelegramStatus(signal.id, "SKIPPED", "no_close_notification_for_non_opened_or_external_close");
      continue;
    }
    let price = Number(signal?.entry_price);
    if (reason === "TP_HIT") {
      price = Number(signal?.take_profit);
    } else if (reason === "SL_HIT") {
      price = Number(signal?.stop_loss);
    }
    if (!Number.isFinite(price) || price <= 0) {
      price = Number(signal?.entry_price);
    }
    if (!Number.isFinite(price) || price <= 0) {
      price = 0;
    }
    const message = await buildClosedSignalTelegramMessage({
      symbol: String(signal?.symbol || ""),
      direction: String(signal?.direction || ""),
      close_reason: String(signal?.close_reason || ""),
      price,
      market_type: String(signal?.market_type || "spot"),
      profit_loss: Number(signal?.profit_loss),
    });
    await updateActiveSignalCloseTelegramStatus(signal.id, "QUEUED", null);
    const sendResult = await sendTelegramNotification(signal.user_id, message);
    await updateActiveSignalCloseTelegramStatus(signal.id, sendResult.status, sendResult.error ?? null);
  }
}

async function updateActiveSignalCloseTelegramStatus(
  signalId: string | number,
  status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED",
  error: string | null = null
): Promise<void> {
  try {
    const updatePayload: Record<string, unknown> = {
      telegram_close_status: status,
      telegram_close_error: error,
    };
    if (status === "SENT") {
      updatePayload.telegram_close_sent_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from("active_signals")
      .update(updatePayload)
      .eq("id", signalId);

    if (updateError) {
      console.warn(`⚠️ Failed to update close telegram status for signal ${signalId}:`, updateError);
    }
  } catch (e) {
    console.warn(`⚠️ Close telegram status update error for signal ${signalId}:`, e);
  }
}

async function sendTelegramToChatId(chatId: string, message: string): Promise<{ ok: boolean; description?: string; error_code?: number }> {
  try {
    const botUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const resp = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("❌ Telegram test send failed:", resp.status, data);
    }
    return data;
  } catch (e) {
    console.error("❌ Telegram test notification error:", e);
    return { ok: false, description: e instanceof Error ? e.message : "Unknown error" };
  }
}

const VALID_TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);

function validateAlarm(alarm: any): boolean {
  const tpPercent = Number(alarm?.tp_percent ?? alarm?.takeProfitPercent ?? 5);
  if (!Number.isFinite(tpPercent) || tpPercent <= 0 || tpPercent > 50) {
    console.error("❌ Invalid TP:", alarm?.id, alarm?.tp_percent);
    return false;
  }

  const slPercent = Number(alarm?.sl_percent ?? alarm?.stopLossPercent ?? 3);
  if (!Number.isFinite(slPercent) || slPercent <= 0 || slPercent > 99) {
    console.error("❌ Invalid SL:", alarm?.id, alarm?.sl_percent);
    return false;
  }

  const confidence = Number(alarm?.confidence_threshold ?? alarm?.confidence_score ?? 70);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    console.error("❌ Invalid confidence:", alarm?.id, alarm?.confidence_threshold ?? alarm?.confidence_score);
    return false;
  }

  const timeframe = String(alarm?.timeframe || "").trim();
  if (!VALID_TIMEFRAMES.has(timeframe)) {
    console.error("❌ Invalid timeframe:", alarm?.id, alarm?.timeframe);
    return false;
  }

  return true;
}

// =====================
// User alarm trigger logic (WITH SIGNAL GENERATION)
// =====================
type TriggerCheckStats = {
  alarmsProcessed: number;
  triggersChecked: number;
  triggered: number;
  skippedActive: number;
};

async function checkAndTriggerUserAlarms(
  alarms: any[],
  deadlineMs?: number,
  tickerMaps?: { spot: Record<string, number>; futures: Record<string, number> }
): Promise<TriggerCheckStats> {
  console.log(`🔥 checkAndTriggerUserAlarms called with ${alarms?.length || 0} alarms`);
  
  if (!alarms || alarms.length === 0) {
    return { alarmsProcessed: 0, triggersChecked: 0, triggered: 0, skippedActive: 0 };
  }

  if (binanceBanUntil && Date.now() < binanceBanUntil) {
    console.warn("⛔ Binance ban active. Skipping alarm trigger checks.");
    return { alarmsProcessed: 0, triggersChecked: 0, triggered: 0, skippedActive: 0 };
  }

  console.log(`🔍 Fetching existing ACTIVE_TRADE alarms...`);
  // Fetch all open ACTIVE_TRADE alarms to prevent duplicate SIGNAL alarms
  const { data: activeTradeAlarms, error: activeTradeError } = await supabase
    .from("alarms")
    .select("user_id, symbol, status")
    .eq("type", "ACTIVE_TRADE")
    .in("status", ACTIVE_ALARM_STATUSES);
  
  if (activeTradeError) {
    console.error(`❌ Failed to fetch ACTIVE_TRADE alarms:`, activeTradeError);
  } else {
    console.log(`✅ Found ${activeTradeAlarms?.length || 0} ACTIVE_TRADE alarms`);
  }
  
  const openTradeSymbols = new Set();
  if (activeTradeAlarms && !activeTradeError) {
    activeTradeAlarms.forEach((at: any) => {
      const symbol = String(at.symbol || "").toUpperCase();
      const userId = String(at.user_id || "");
      if (symbol && userId) {
        openTradeSymbols.add(`${userId}:${symbol}`);
      }
    });
  }
  console.log(`📌 Open ACTIVE_TRADE count: ${openTradeSymbols.size}`);

  // 🔴 ÖNEMLI: Fetch all open auto_signal sinyalleri - spam'ı engelle
      const { data: openAutoSignals, error: openAutoSignalsError } = await supabase
        .from("active_signals")
        .select("user_id, symbol, status, alarm_id, direction")
        .in("status", ["ACTIVE", "active"])

  const openSignalKeys = new Set();
  const openSignalSymbols = new Set();
  const openSignalDirections = new Set();
  if (openAutoSignals && !openAutoSignalsError) {
    openAutoSignals.forEach((sig: any) => {
      // user_id + symbol kombinasyonu key oluştur
      const key = `${sig.user_id}:${String(sig.alarm_id || "")}`;
      openSignalKeys.add(key);
      const symbolKey = `${sig.user_id}:${String(sig.symbol || "").toUpperCase()}`;
      openSignalSymbols.add(symbolKey);
      const directionKey = `${sig.user_id}:${String(sig.symbol || "").toUpperCase()}:${String(sig.direction || "").toUpperCase()}`;
      openSignalDirections.add(directionKey);
    });
  }
  console.log(`📌 Open auto_signal count: ${openSignalKeys.size}`);

  const indicatorPromiseCache = new Map<string, Promise<TechnicalIndicators | null>>();
  const getCachedIndicators = (symbol: string, marketType: "spot" | "futures", timeframe: string) => {
    const cacheKey = `${symbol}:${marketType}:${timeframe}`;
    if (!indicatorPromiseCache.has(cacheKey)) {
      indicatorPromiseCache.set(cacheKey, calculateIndicators(symbol, marketType, timeframe));
    }
    return indicatorPromiseCache.get(cacheKey)!;
  };

  const telegramPromises: Promise<void>[] = [];
  const BATCH_SIZE = 3;
  const batches: any[][] = [];

  const rotationSeed = Math.floor(Date.now() / 60000);
  const offset = alarms.length > 0 ? (rotationSeed % alarms.length) : 0;
  const rotatedAlarms = offset > 0
    ? alarms.slice(offset).concat(alarms.slice(0, offset))
    : alarms.slice();

  for (let i = 0; i < rotatedAlarms.length; i += BATCH_SIZE) {
    batches.push(rotatedAlarms.slice(i, i + BATCH_SIZE));
  }

  const stats: TriggerCheckStats = { alarmsProcessed: 0, triggersChecked: 0, triggered: 0, skippedActive: 0 };

  const processAlarm = async (alarm: any): Promise<void> => {
    try {
      if (deadlineMs && Date.now() >= deadlineMs) {
        return;
      }
      stats.alarmsProcessed += 1;
      if (!validateAlarm(alarm)) {
        return;
      }

      const alarmSymbol = String(alarm?.symbol || "").toUpperCase();
      const alarmMarketType = normalizeMarketType(alarm.market_type || alarm.marketType || "spot");
      const alarmPricePrecision = alarmSymbol
        ? await getSymbolPricePrecision(alarmSymbol, alarmMarketType)
        : null;
      const alarmTickSize = alarmSymbol
        ? await getSymbolTickSize(alarmSymbol, alarmMarketType)
        : null;

      let indicators: TechnicalIndicators | null = null;
      let alarmIndicators: TechnicalIndicators | null = null;
      let shouldTrigger = false;
      let triggerMessage = "";
      let detectedSignal = null;

      const tickerPrice = alarmMarketType === "futures"
        ? tickerMaps?.futures?.[alarmSymbol]
        : tickerMaps?.spot?.[alarmSymbol];
      const nowMs = Date.now();
      const timeframeMinutes = timeframeToMinutes(String(alarm.timeframe || "1h"));
      const timeframeMs = timeframeMinutes * 60 * 1000;
      const barStartMs = Math.floor(nowMs / timeframeMs) * timeframeMs;
      const barEndMs = barStartMs + (Number.isFinite(timeframeMs) && timeframeMs > 0 ? timeframeMs : 60 * 60 * 1000);
      const alarmCreatedAtMs = Date.parse(String(alarm.created_at || alarm.createdAt || ""));
      const alarmCreatedBarOpenMs = Number.isFinite(alarmCreatedAtMs) && timeframeMs > 0
        ? Math.floor(alarmCreatedAtMs / timeframeMs) * timeframeMs
        : NaN;
      const lastSignalTs = alarm.signal_timestamp || alarm.signalTimestamp;
      const lastSignalMs = lastSignalTs ? Date.parse(String(lastSignalTs)) : NaN;
      const lastOpenIso = new Date(barStartMs).toISOString();
      const fallbackTrigger = Number(alarm.entry_price || alarm.entryPrice || alarm.entry || NaN);
      const triggerPrice = Number.isFinite(Number(tickerPrice))
        ? Number(tickerPrice)
        : fallbackTrigger;
      let lastOpenMs = barStartMs;
      let evaluatedBarOpenMs = barStartMs;
      let evaluatedBarIso = lastOpenIso;

      const isNearTargets = (price: number, targets: number[]): boolean => {
        if (!Number.isFinite(price) || targets.length === 0) return true;
        return targets.some((t) => {
          if (!Number.isFinite(t)) return false;
          const pct = (Math.abs(price - t) / Math.max(1e-8, Math.abs(price))) * 100;
          return pct <= TRIGGER_NEAR_TARGET_PCT;
        });
      };

      // STRATEGY 1: USER_ALARM (user-defined signals with TP/SL)
      if (alarm.type === "user_alarm") {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;
        const symbolKey = `${alarm.user_id}:${symbol}`;
        const autoTradeEnabled = await resolveAutoTradeEnabled(alarm, alarmMarketType);

        if (autoTradeEnabled && openTradeSymbols.has(symbolKey)) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: ACTIVE_TRADE in progress (user: ${alarm.user_id})`);
          stats.skippedActive += 1;
        } else if (openSignalKeys.has(signalKey)) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: signal already active for this alarm (user: ${alarm.user_id})`);
          stats.skippedActive += 1;
        } else {
          const proximityTargets = [
            Number(alarm.target_price || alarm.targetPrice || NaN),
            Number(alarm.entry_price || alarm.entryPrice || alarm.entry || NaN)
          ].filter((v) => Number.isFinite(v));
          if (!isNearTargets(triggerPrice, proximityTargets)) {
            requestMetrics.klinesSkippedByProximity += 1;
            return;
          }

          if (!alarmIndicators) {
            indicators = await getCachedIndicators(
              alarmSymbol,
              alarmMarketType,
              String(alarm.timeframe || "1h")
            );
            if (!indicators) {
              console.log(`⚠️ No indicators calculated for ${alarm.symbol}`);
              return;
            }
            alarmIndicators = indicators;
            if (Number.isFinite(indicators.lastOpenTimestamp)) {
              lastOpenMs = Number(indicators.lastOpenTimestamp);
            }
            if (Number.isFinite(indicators.lastClosedTimestamp) && timeframeMs > 0) {
              evaluatedBarOpenMs = Math.floor(Number(indicators.lastClosedTimestamp) / timeframeMs) * timeframeMs;
              evaluatedBarIso = new Date(evaluatedBarOpenMs).toISOString();
            }
          }

          if (Number.isFinite(alarmCreatedBarOpenMs) && Number.isFinite(evaluatedBarOpenMs) && evaluatedBarOpenMs < alarmCreatedBarOpenMs) {
            console.log(`⏹️ Skipping user_alarm for ${symbol}: waiting for first closed bar after creation`);
            return;
          }

          if (Number.isFinite(lastSignalMs) && Number.isFinite(evaluatedBarOpenMs) && lastSignalMs >= evaluatedBarOpenMs) {
            console.log(`⏹️ Skipping user_alarm for ${symbol}: same closed bar already processed (alarm ${alarm.id})`);
            return;
          }

          if (!isWithinBarCloseTriggerWindow(nowMs, evaluatedBarOpenMs, timeframeMs)) {
            const evaluatedBarCloseMs = Number.isFinite(evaluatedBarOpenMs) && Number.isFinite(timeframeMs)
              ? evaluatedBarOpenMs + timeframeMs
              : NaN;
            const delaySec = Number.isFinite(evaluatedBarCloseMs)
              ? Math.round((nowMs - evaluatedBarCloseMs) / 1000)
              : -1;
            console.log(`⏹️ Skipping user_alarm for ${symbol}: outside strict bar-close trigger window (delay=${delaySec}s, grace=${Math.round(BAR_CLOSE_TRIGGER_GRACE_MS / 1000)}s)`);
            return;
          }

          stats.triggersChecked += 1;
          const tpPercent = Number(alarm.tp_percent || 5);
          const slPercent = Number(alarm.sl_percent || 3);
          const entryPrice = Number.isFinite(Number(alarmIndicators.openPrice))
            ? Number(alarmIndicators.openPrice)
            : (Number.isFinite(Number(indicators.price))
              ? Number(indicators.price)
            : (Number.isFinite(triggerPrice)
              ? triggerPrice
              : Number(indicators.closes?.[indicators.closes.length - 1] ?? indicators.price)));
          
          console.log(`📊 User alarm check: ${symbol}, TP=${tpPercent}%, SL=${slPercent}%`);
          
          // Check if any signal is detected
          const signal = generateSignalScoreAligned(alarmIndicators, Number(alarm.confidence_score || 70));
          const directionFilter = String(alarm.direction_filter || "BOTH").toUpperCase();
          if (directionFilter !== "BOTH" && directionFilter !== signal.direction) {
            console.log(`⏹️ Skipping user_alarm for ${symbol}: direction_filter=${directionFilter}, signal=${signal.direction}`);
            return;
          }
          if (signal.triggered) {
            const directionKey = `${alarm.user_id}:${symbol}:${signal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping user_alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              stats.skippedActive += 1;
              return;
            }
            shouldTrigger = true;
            const rawTakeProfit = signal.direction === "SHORT"
              ? entryPrice * (1 - tpPercent / 100)
              : entryPrice * (1 + tpPercent / 100);
            const rawStopLoss = signal.direction === "SHORT"
              ? entryPrice * (1 + slPercent / 100)
              : entryPrice * (1 - slPercent / 100);
            const fallbackTick = Number.isFinite(alarmPricePrecision)
              ? 1 / Math.pow(10, Number(alarmPricePrecision))
              : 0.01;
            const tick = Number.isFinite(alarmTickSize) && Number(alarmTickSize) > 0
              ? Number(alarmTickSize)
              : fallbackTick;
            const takeProfit = roundToTick(rawTakeProfit, tick);
            const stopLoss = roundToTick(rawStopLoss, tick);
            const tpGain = tpPercent;
            const slLoss = -slPercent;

            detectedSignal = {
              direction: signal.direction,
              score: signal.score,
              triggered: true,
              breakdown: signal.breakdown,
              tp: takeProfit,
              sl: stopLoss,
              entry_price: entryPrice
            };
            
            const directionEmoji = signal.direction === "LONG" ? "🟢" : "🔴";
            const formattedDateTime = formatTurkeyDateTime(resolveBarCloseDisplayTimeMs(evaluatedBarOpenMs, String(alarm.timeframe || "1h")));
            
            triggerMessage = `🔔 ALARM AKTİVE! 🔔\n\n` +
              `💰 Çift: ${symbol}\n` +
              `🎯 ${directionEmoji} ${signal.direction} Sinyali Tespit Edildi!\n\n` +
              `📊 Piyasa: ${(alarm.market_type || "spot").toUpperCase()} | Zaman: ${alarm.timeframe || "1h"}\n` +
              `💹 Fiyat: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}\n\n` +
              `📈 Sinyal: Güven: ${Number(alarm.confidence_score || 70)}%\n` +
              `📊 Gelen Sinyalin Güveni: ${signal.score}%\n\n` +
              `🎯 Hedefler:\n` +
              `   TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)} (+${tpGain.toFixed(2)}%)\n` +
              `   SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)} (${slLoss.toFixed(2)}%)\n\n` +
              `⏰ Zaman: ${formattedDateTime}`;
            
            console.log(`✅ User alarm triggered for ${symbol}: ${signal.direction}`);
          }
        }
      }

      // STRATEGY 2: PRICE_LEVEL alarm (explicit price target)
      if (!shouldTrigger && (alarm.type === "PRICE_LEVEL" || alarm.condition)) {
        const targetPrice = Number(alarm.target_price || alarm.targetPrice);
        const condition = String(alarm.condition || "").toLowerCase();
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;

        if (openSignalKeys.has(signalKey)) {
          console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: signal already active for this alarm (user: ${alarm.user_id})`);
          stats.skippedActive += 1;
        }

        if (Number.isFinite(targetPrice) && !openSignalKeys.has(signalKey)) {
            stats.triggersChecked += 1;
            if (condition === "above" && triggerPrice >= targetPrice) {
            shouldTrigger = true;
              triggerMessage = `🚀 Price ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$ reached! (Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: triggerPrice > targetPrice ? "LONG" : "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
            const directionKey = `${alarm.user_id}:${symbol}:${detectedSignal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              stats.skippedActive += 1;
              shouldTrigger = false;
              detectedSignal = null;
            }
          } else if (condition === "below" && triggerPrice <= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `📉 Price dropped below ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$! (Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: triggerPrice < targetPrice ? "SHORT" : "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
            const directionKey = `${alarm.user_id}:${symbol}:${detectedSignal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              stats.skippedActive += 1;
              shouldTrigger = false;
              detectedSignal = null;
            }
          }
        }
      }

      // STRATEGY 2: TECHNICAL SIGNAL alarm (confidence-based)
      // ⏹️ Skip SIGNAL alarms if there's an open ACTIVE_TRADE OR open auto_signal for this symbol
      if (!shouldTrigger && alarm.type === "SIGNAL") {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;
        const symbolKey = `${alarm.user_id}:${symbol}`;

        if (openTradeSymbols.has(symbolKey)) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: ACTIVE_TRADE in progress (user: ${alarm.user_id})`);
          stats.skippedActive += 1;
        } else if (openSignalKeys.has(signalKey)) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: signal already active for this alarm (user: ${alarm.user_id})`);
          stats.skippedActive += 1;
        } else {
          const proximityTargets = [
            Number(alarm.target_price || alarm.targetPrice || NaN),
            Number(alarm.entry_price || alarm.entryPrice || alarm.entry || NaN)
          ].filter((v) => Number.isFinite(v));
          if (!isNearTargets(triggerPrice, proximityTargets)) {
            requestMetrics.klinesSkippedByProximity += 1;
            return;
          }

          if (!alarmIndicators) {
            indicators = await getCachedIndicators(
              alarmSymbol,
              alarmMarketType,
              String(alarm.timeframe || "1h")
            );
            if (!indicators) {
              console.log(`⚠️ No indicators calculated for ${alarm.symbol}`);
              return;
            }
            alarmIndicators = indicators;
            if (Number.isFinite(indicators.lastOpenTimestamp)) {
              lastOpenMs = Number(indicators.lastOpenTimestamp);
            }
            if (Number.isFinite(indicators.lastClosedTimestamp) && timeframeMs > 0) {
              evaluatedBarOpenMs = Math.floor(Number(indicators.lastClosedTimestamp) / timeframeMs) * timeframeMs;
              evaluatedBarIso = new Date(evaluatedBarOpenMs).toISOString();
            }
          }

          if (Number.isFinite(alarmCreatedBarOpenMs) && Number.isFinite(evaluatedBarOpenMs) && evaluatedBarOpenMs < alarmCreatedBarOpenMs) {
            console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: waiting for first closed bar after creation`);
            return;
          }

          if (Number.isFinite(lastSignalMs) && Number.isFinite(evaluatedBarOpenMs) && lastSignalMs >= evaluatedBarOpenMs) {
            console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: same closed bar already processed (alarm ${alarm.id})`);
            return;
          }

          if (!isWithinBarCloseTriggerWindow(nowMs, evaluatedBarOpenMs, timeframeMs)) {
            const evaluatedBarCloseMs = Number.isFinite(evaluatedBarOpenMs) && Number.isFinite(timeframeMs)
              ? evaluatedBarOpenMs + timeframeMs
              : NaN;
            const delaySec = Number.isFinite(evaluatedBarCloseMs)
              ? Math.round((nowMs - evaluatedBarCloseMs) / 1000)
              : -1;
            console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: outside strict bar-close trigger window (delay=${delaySec}s, grace=${Math.round(BAR_CLOSE_TRIGGER_GRACE_MS / 1000)}s)`);
            return;
          }

          stats.triggersChecked += 1;
          const userConfidenceThreshold = Number(alarm.confidence_score || 70);
          const signal = generateSignalScoreAligned(alarmIndicators, userConfidenceThreshold);
          const directionFilter = String(alarm.direction_filter || "BOTH").toUpperCase();
          if (directionFilter !== "BOTH" && directionFilter !== signal.direction) {
            console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: direction_filter=${directionFilter}, signal=${signal.direction}`);
            return;
          }

          console.log(
            `📊 ${alarm.symbol}: ` +
            `RSI=${indicators.rsi.toFixed(1)} | ` +
            `EMA12=${indicators.ema12.toFixed(2)} vs EMA26=${indicators.ema26.toFixed(2)} | ` +
            `Price=$${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)} | ` +
            `[Trend:${signal.breakdown.trend} Momentum:${signal.breakdown.momentum} Volume:${signal.breakdown.volume} SR:${signal.breakdown.sr}] ` +
            `→ ${signal.direction}(${signal.score}%)`
          );

          if (signal.triggered) {
            const directionKey = `${alarm.user_id}:${symbol}:${signal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              stats.skippedActive += 1;
              return;
            }
            shouldTrigger = true;
            // Use signal's calculated confidence (market analysis), NOT alarm.confidence_score (user threshold)
            detectedSignal = {
              direction: signal.direction,
              score: signal.score,
              triggered: true,
              breakdown: signal.breakdown,
              entry_price: Number.isFinite(Number(alarmIndicators.openPrice))
                ? Number(alarmIndicators.openPrice)
                : (Number.isFinite(Number(alarmIndicators.price)) ? Number(alarmIndicators.price) : triggerPrice)
            };
            triggerMessage = `🎯 <b>${signal.direction}</b> Signal detected!\n` +
              `Confidence: <b>${signal.score}%</b>\n` +
              `RSI: ${indicators.rsi.toFixed(1)} | Price: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)}\n` +
              `📈 Analysis: Trend=${signal.breakdown.trend} Momentum=${signal.breakdown.momentum} Volume=${signal.breakdown.volume} SR=${signal.breakdown.sr}`;
          }
        }
      }

      // STRATEGY 3: ACTIVE_TRADE alarm (TP/SL hit)
      if (!shouldTrigger && (alarm.type === "ACTIVE_TRADE" || alarm.direction)) {
        const direction = String(alarm.direction || "").toUpperCase();
        const entryPrice = Number(alarm.entry_price || alarm.entryPrice);
        const takeProfit = Number(alarm.take_profit || alarm.takeProfit);
        const stopLoss = Number(alarm.stop_loss || alarm.stopLoss);

        if (direction === "LONG" && Number.isFinite(entryPrice) && Number.isFinite(takeProfit) && Number.isFinite(stopLoss)) {
          stats.triggersChecked += 1;
          if (triggerPrice >= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ LONG TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (triggerPrice <= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ LONG SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          }
        } else if (direction === "SHORT" && Number.isFinite(entryPrice) && Number.isFinite(takeProfit) && Number.isFinite(stopLoss)) {
          stats.triggersChecked += 1;
          if (triggerPrice <= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ SHORT TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (triggerPrice >= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ SHORT SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(triggerPrice, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          }
        }
      }

      if (shouldTrigger && triggerMessage) {
        const signalBarMs = Number.isFinite(evaluatedBarOpenMs) ? evaluatedBarOpenMs : lastOpenMs;
        const signalBarIso = Number.isFinite(evaluatedBarOpenMs) ? evaluatedBarIso : lastOpenIso;

        try {
          const { data: lastSignal } = await supabase
            .from("active_signals")
            .select("id, status, close_reason, closed_at, signal_timestamp")
            .eq("user_id", alarm.user_id)
            .eq("alarm_id", alarm.id)
            .order("signal_timestamp", { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastSignalMs = lastSignal?.signal_timestamp
            ? Date.parse(String(lastSignal.signal_timestamp))
            : NaN;
          if (Number.isFinite(lastSignalMs) && lastSignalMs >= signalBarMs) {
            console.log(`⏹️ Skipping ${alarm.symbol}: last signal already in this bar (alarm ${alarm.id})`);
            return;
          }

        } catch (e) {
          console.warn(`⚠️ Failed to check last signal for ${alarm.symbol}:`, e);
        }

        try {
          await supabase
            .from("alarms")
            .update({ signal_timestamp: signalBarIso })
            .eq("id", alarm.id);
        } catch (e) {
          console.warn(`⚠️ Failed to pre-update alarm signal_timestamp for ${alarm.symbol}:`, e);
        }

        const symbol = String(alarm.symbol || "").toUpperCase();
        const marketType = String(alarm.market_type || "spot").toLowerCase() === "futures" ? "Futures" : "Spot";
        const timeframe = String(alarm.timeframe || "1h");
        const tpPercent = Number(alarm.tp_percent || 5);
        const slPercent = Number(alarm.sl_percent || 3);
        const direction = detectedSignal?.direction || "LONG";
        const directionTR = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";

        const computedEntryPrice = Number(detectedSignal?.entry_price);
        const entryPrice = Number.isFinite(computedEntryPrice)
          ? computedEntryPrice
          : (Number.isFinite(triggerPrice)
            ? Number(triggerPrice)
            : (Number.isFinite(fallbackTrigger) ? Number(fallbackTrigger) : NaN));

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
          console.warn(`⚠️ Skipping active_signals insert for ${symbol}: invalid entry_price`, {
            triggerPrice,
            fallbackTrigger,
            computedEntryPrice,
            alarmId: alarm.id,
            userId: alarm.user_id
          });
          return;
        }
        
        const decimals = alarmPricePrecision;
        
        // Calculate TP/SL prices based on current price and percentages
        const rawTpPrice = direction === "SHORT"
          ? entryPrice * (1 - tpPercent / 100)
          : entryPrice * (1 + tpPercent / 100);
        const rawSlPrice = direction === "SHORT"
          ? entryPrice * (1 + slPercent / 100)
          : entryPrice * (1 - slPercent / 100);
        const fallbackTick = Number.isFinite(decimals)
          ? 1 / Math.pow(10, Number(decimals))
          : 0.01;
        const tick = Number.isFinite(alarmTickSize) && Number(alarmTickSize) > 0
          ? Number(alarmTickSize)
          : fallbackTick;
        const tpPrice = roundToTick(rawTpPrice, tick);
        const slPrice = roundToTick(rawSlPrice, tick);

        // 🚀 INSERT active signal INTO DATABASE
        let signalInserted = false;
        let insertedSignalId: string | number | null = null;
        try {
          const marketTypeNorm = normalizeMarketType(alarm.market_type || "spot");
          const newActiveSignal = {
            user_id: alarm.user_id,
            alarm_id: alarm.id,
            symbol: symbol,
            market_type: marketTypeNorm,
            timeframe: String(alarm.timeframe || "1h"),
            direction,
            entry_price: entryPrice,
            take_profit: tpPrice,
            stop_loss: slPrice,
            tp_percent: tpPercent,
            sl_percent: slPercent,
            signal_timestamp: signalBarIso,
            status: "ACTIVE",
            score: detectedSignal?.score || 50  // ✅ ADD SCORE
          };

          const { data, error } = await supabase
            .from("active_signals")
            .insert(newActiveSignal)
            .select()
            .single();
          if (error) {
            if (error.code === "23505") {
              console.log("Duplicate signal prevented:", symbol, direction);
              return;
            }
            console.error("Insert failed:", alarm.id, error);
            return;
          }

          if (data) {
            console.log(`✅ Signal created in active_signals for ${symbol}`);
            signalInserted = true;
            insertedSignalId = data.id;
            openSignalSymbols.add(`${alarm.user_id}:${symbol}`);
            openSignalKeys.add(`${alarm.user_id}:${String(alarm.id || "")}`);
            openSignalDirections.add(`${alarm.user_id}:${symbol}:${direction}`);
            stats.triggered += 1;
          }
        } catch (e) {
          console.error(`❌ Error creating signal for ${symbol}:`, e);
              return;
        }

        if (!signalInserted) {
          console.warn(`⚠️ active_signals insert failed for ${symbol} - telegram skipped`);
          return;
        }

        // 🚀 AUTO TRADE EXECUTION
        let tradeResult = {
          success: false,
          message: "Auto-trade not triggered"
        } as {
          success: boolean;
          message: string;
          orderId?: string;
          blockedByOpenPosition?: boolean;
          executedEntryPrice?: number;
          executedTakeProfit?: number;
          executedStopLoss?: number;
        };
        let tradeNotificationText = "";
        const autoTradeEnabled = await resolveAutoTradeEnabled(alarm, alarmMarketType);
        let autoTradeAttempted = false;

        if (autoTradeEnabled) {
          autoTradeAttempted = true;
          tradeResult = await executeAutoTrade(
            alarm.user_id,
            symbol,
            direction,
            entryPrice,
            tpPrice,
            slPrice,
            alarmMarketType
          );

          if (tradeResult.success) {
            tradeNotificationText = `\n\n🤖 <b>OTOMATİK İŞLEM:</b>\n${escapeHtml(tradeResult.message)}`;

            if (insertedSignalId && Number.isFinite(tradeResult.executedEntryPrice) && Number(tradeResult.executedEntryPrice) > 0) {
              try {
                await supabase
                  .from("active_signals")
                  .update({
                    entry_price: Number(tradeResult.executedEntryPrice),
                    take_profit: Number.isFinite(tradeResult.executedTakeProfit)
                      ? Number(tradeResult.executedTakeProfit)
                      : tpPrice,
                    stop_loss: Number.isFinite(tradeResult.executedStopLoss)
                      ? Number(tradeResult.executedStopLoss)
                      : slPrice,
                  })
                  .eq("id", insertedSignalId)
                  .in("status", ACTIVE_SIGNAL_STATUSES);
              } catch (e) {
                console.warn(`⚠️ Failed to sync executed prices for signal ${insertedSignalId}:`, e);
              }
            }

            if (tradeResult.orderId) {
              await supabase
                .from("alarms")
                .update({ binance_order_id: tradeResult.orderId })
                .eq("id", alarm.id);
            }
          } else if (
            tradeResult.message !== "Auto-trade not enabled" &&
            tradeResult.message !== "Futures auto-trade not enabled" &&
            tradeResult.message !== "Spot auto-trade not enabled"
          ) {
            tradeNotificationText = `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${escapeHtml(tradeResult.message)}`;
            try {
              await supabase
                .from("alarms")
                .update({ binance_order_id: null })
                .eq("id", alarm.id);
            } catch (e) {
              console.warn(`⚠️ Failed to clear stale binance_order_id after auto-trade failure for ${symbol}:`, e);
            }
          }
        }

        if (!tradeNotificationText) {
          tradeNotificationText = autoTradeEnabled
            ? `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${escapeHtml(tradeResult.message)}`
            : `\n\nℹ️ <b>Otomatik işlem:</b> Kapalı`;
        }

        const autoTradeOpenFailed = autoTradeAttempted && !tradeResult.success;
        if (autoTradeOpenFailed && insertedSignalId) {
          try {
            const closeResult = await supabase
              .from("active_signals")
              .update({
                status: "CLOSED",
                close_reason: "NOT_FILLED",
                profit_loss: 0,
                closed_at: new Date().toISOString()
              })
              .eq("id", insertedSignalId)
                .in("status", ACTIVE_SIGNAL_STATUSES)
                .select("id");

            if (!closeResult.error) {
              const updatedRows = Array.isArray(closeResult.data) ? closeResult.data.length : 0;
              if (updatedRows === 0) {
                const forceCloseResult = await supabase
                  .from("active_signals")
                  .update({
                    status: "CLOSED",
                    close_reason: "NOT_FILLED",
                    profit_loss: 0,
                    closed_at: new Date().toISOString()
                  })
                  .eq("id", insertedSignalId)
                  .select("id");

                if (forceCloseResult.error) {
                  console.warn(`⚠️ Force-close failed for NOT_FILLED signal ${insertedSignalId}:`, forceCloseResult.error);
                }
              }
            } else {
              console.warn(`⚠️ Failed to close signal after auto-trade open failure for ${symbol}:`, closeResult.error);
            }
          } catch (e) {
            console.warn(`⚠️ Failed to close signal after auto-trade open failure for ${symbol}:`, e);
          }
        }
        
        const formattedDateTime = formatTurkeyDateTime(resolveBarCloseDisplayTimeMs(signalBarMs, timeframe));

        // Get signal analysis score for market strength
        const userConfidenceThreshold = Number(alarm.confidence_score || 70);
        const signalAnalysis = alarmIndicators
          ? generateSignalScoreAligned(alarmIndicators, userConfidenceThreshold)
          : { score: userConfidenceThreshold };

        const safeSymbol = escapeHtml(symbol);
        const safeDirection = escapeHtml(directionTR);
        const safeMarketType = escapeHtml(marketType);
        const safeTimeframe = escapeHtml(timeframe);
        const displayEntryPrice = Number.isFinite(tradeResult.executedEntryPrice)
          ? Number(tradeResult.executedEntryPrice)
          : entryPrice;
        const displayTpPrice = Number.isFinite(tradeResult.executedTakeProfit)
          ? Number(tradeResult.executedTakeProfit)
          : tpPrice;
        const displaySlPrice = Number.isFinite(tradeResult.executedStopLoss)
          ? Number(tradeResult.executedStopLoss)
          : slPrice;
        const safePrice = escapeHtml(formatPriceWithPrecision(displayEntryPrice, decimals));
        const safeConfidence = escapeHtml(String(userConfidenceThreshold));
        const safeSignalScore = escapeHtml(String(signalAnalysis.score));
        const safeTpPrice = escapeHtml(formatPriceWithPrecision(displayTpPrice, decimals));
        const safeSlPrice = escapeHtml(formatPriceWithPrecision(displaySlPrice, decimals));
        const safeDate = escapeHtml(formattedDateTime);

        let telegramMessage = `
🔔 <b>ALARM AKTİVE!</b> 🔔

💰 Çift: <b>${safeSymbol}</b>
🎯 ${safeDirection} Sinyali Tespit Edildi!

📊 Piyasa: <b>${safeMarketType}</b> | Zaman: <b>${safeTimeframe}</b>
💹 Fiyat: <b>$${safePrice}</b>

📈 Sinyal: Güven: <b>${safeConfidence}%</b>
📊 Gelen Sinyalin Güveni: <b>${safeSignalScore}%</b>

🎯 Hedefler:
  TP: <b>$${safeTpPrice}</b> (<b>+${tpPercent}%</b>)
  SL: <b>$${safeSlPrice}</b> (<b>-${slPercent}%</b>)

⏰ Zaman: <b>${safeDate}</b>
${tradeNotificationText}

<i>Not:</i> Otomatik al-sat işlemleri market fiyatından anlık alındığı için, sinyalin giriş fiyatına göre farklılık gösterebilir.
`;

        try {
          await supabase
            .from("alarms")
            .update({ signal_timestamp: signalBarIso })
            .eq("id", alarm.id);
        } catch (e) {
          console.warn(`⚠️ Failed to update alarm signal_timestamp for ${symbol}:`, e);
        }

        if (insertedSignalId) {
          await updateActiveSignalTelegramStatus(insertedSignalId, "QUEUED", null);
          console.log(`📨 Telegram queued for signal ${insertedSignalId} (user ${alarm.user_id})`);
        }

        telegramPromises.push((async () => {
          const sendResult = await sendTelegramNotification(alarm.user_id, telegramMessage);
          if (insertedSignalId) {
            await updateActiveSignalTelegramStatus(insertedSignalId, sendResult.status, sendResult.error ?? null);
          }
        })());
        console.log(`✅ User alarm triggered for ${symbol}: ${triggerMessage}`);
      }
    } catch (e) {
      console.error(`❌ Error checking user alarm ${alarm?.id}:`, e);
    }
  };

  for (const batch of batches) {
    if (deadlineMs && Date.now() >= deadlineMs) {
      console.warn("⏱️ Alarm processing stopped due to time budget");
      break;
    }
    await Promise.all(batch.map(processAlarm));
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  // 🚀 PARALLELIZED: Send all Telegram messages in parallel
  await Promise.all(telegramPromises);
  return stats;
}
type ClosedSignal = {
  id: string | number;
  symbol: string;
  direction: "LONG" | "SHORT";
  close_reason: "TP_HIT" | "SL_HIT" | "TIMEOUT" | "NOT_FILLED" | "TP_HIT_NO_POSITION" | "SL_HIT_NO_POSITION" | "ORPHAN_ACTIVE_NO_TRADE" | "EXTERNAL_CLOSE";
  price: number;
  user_id: string;
  profitLoss?: number;
  market_type?: string;
};

type CloseCheckStats = {
  closesChecked: number;
  closed: number;
};

function normalizeCloseReasonForDb(reason: string): "TP_HIT" | "SL_HIT" | "TIMEOUT" | "NOT_FILLED" | "EXTERNAL_CLOSE" {
  if (reason === "TP_HIT") return "TP_HIT";
  if (reason === "SL_HIT") return "SL_HIT";
  if (reason === "TP_HIT_NO_POSITION" || reason === "SL_HIT_NO_POSITION" || reason === "ORPHAN_ACTIVE_NO_TRADE") return "NOT_FILLED";
  if (reason === "NOT_FILLED") return "NOT_FILLED";
  if (reason === "EXTERNAL_CLOSE") return "EXTERNAL_CLOSE";
  if (reason === "TIMEOUT") return "TIMEOUT";
  return "TIMEOUT";
}

function resolveSameCandleHit(
  open: number,
  takeProfit: number,
  stopLoss: number
): "TP_HIT" | "SL_HIT" {
  if (!Number.isFinite(open)) return "SL_HIT";
  const distToTp = Math.abs(takeProfit - open);
  const distToSl = Math.abs(open - stopLoss);
  if (distToTp < distToSl) return "TP_HIT";
  return "SL_HIT";
}

async function resolveFirstTouch(
  symbol: string,
  marketType: "spot" | "futures",
  timeframe: string,
  startMs: number,
  endMs: number,
  direction: "LONG" | "SHORT",
  takeProfit: number,
  stopLoss: number
): Promise<"TP_HIT" | "SL_HIT" | ""> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return "";

  const durationMin = Math.max(1, Math.ceil((endMs - startMs) / 60000));
  const useInterval = durationMin <= 1000 ? "1m" : "5m";
  const intervalMin = useInterval === "1m" ? 1 : 5;
  const limit = Math.min(1000, Math.ceil(durationMin / intervalMin));
  const klines = await getKlinesRange(symbol, marketType, useInterval, startMs, endMs, limit);
  if (!klines || klines.length === 0) return "";

  for (const k of klines) {
    const open = Number(k?.[1]);
    const high = Number(k?.[2]);
    const low = Number(k?.[3]);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (direction === "LONG") {
      const hitSl = low <= stopLoss;
      const hitTp = high >= takeProfit;
      if (hitSl && hitTp) return resolveSameCandleHit(open, takeProfit, stopLoss);
      if (hitSl) return "SL_HIT";
      if (hitTp) return "TP_HIT";
    } else {
      const hitSl = high >= stopLoss;
      const hitTp = low <= takeProfit;
      if (hitSl && hitTp) return resolveSameCandleHit(open, takeProfit, stopLoss);
      if (hitSl) return "SL_HIT";
      if (hitTp) return "TP_HIT";
    }
  }

  return "";
}

async function resolveFirstTouchRange(
  symbol: string,
  marketType: "spot" | "futures",
  timeframe: string,
  startMs: number,
  endMs: number,
  direction: "LONG" | "SHORT",
  takeProfit: number,
  stopLoss: number
): Promise<"TP_HIT" | "SL_HIT" | ""> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return "";

  const durationMin = Math.max(1, Math.ceil((endMs - startMs) / 60000));
  const useInterval = durationMin <= 1000 ? "1m" : "5m";
  const intervalMin = useInterval === "1m" ? 1 : 5;
  const maxWindowMs = intervalMin * 60 * 1000 * 1000;

  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(endMs, cursor + maxWindowMs);
    const hit = await resolveFirstTouch(
      symbol,
      marketType,
      useInterval,
      cursor,
      windowEnd,
      direction,
      takeProfit,
      stopLoss
    );
    if (hit) return hit;
    cursor = windowEnd;
  }

  return "";
}

async function checkAndCloseSignals(deadlineMs?: number): Promise<{ closedSignals: ClosedSignal[]; stats: CloseCheckStats }> {
  try {
    const { data: rawSignals, error: signalsError } = await supabase
      .from("active_signals")
      .select("*")
      .in("status", ACTIVE_SIGNAL_STATUSES);

    if (signalsError) {
      console.error("❌ Error fetching signals:", signalsError);
      return { closedSignals: [], stats: { closesChecked: 0, closed: 0 } };
    }

    let signals = (rawSignals || []).slice().sort((a: any, b: any) => {
      const aTs = Date.parse(String(a?.created_at || a?.signal_timestamp || ""));
      const bTs = Date.parse(String(b?.created_at || b?.signal_timestamp || ""));
      const aSafe = Number.isFinite(aTs) ? aTs : Number.MAX_SAFE_INTEGER;
      const bSafe = Number.isFinite(bTs) ? bTs : Number.MAX_SAFE_INTEGER;
      return aSafe - bSafe;
    });
    if (!signals || signals.length === 0) {
      return { closedSignals: [], stats: { closesChecked: 0, closed: 0 } };
    }
    if (signals.length > MAX_CLOSE_CHECKS_PER_CRON) {
      const oldestCount = Math.max(50, Math.floor(MAX_CLOSE_CHECKS_PER_CRON * 0.2));
      const newestCount = Math.max(50, MAX_CLOSE_CHECKS_PER_CRON - oldestCount);
      const oldest = signals.slice(0, oldestCount);
      const newest = signals.slice(-newestCount);
      const merged = [...oldest, ...newest];
      const deduped = merged.filter((s, idx, arr) => arr.findIndex(x => String(x?.id) === String(s?.id)) === idx);
      console.warn(`⚠️ Close check truncated: ${signals.length} -> ${deduped.length} (oldest=${oldest.length}, newest=${newest.length})`);
      signals = deduped;
    }
    console.log(`🔍 Close check starting for ${signals.length} active signals`);
    const spotTickerMap = await getAllTickerPrices("spot", true);
    const futuresTickerMap = await getAllTickerPrices("futures", true);
    const futuresMarkPriceMap = await getAllFuturesMarkPrices(true);
    const futuresPositionsCache = new Map<string, any[]>();
    const futuresOpenOrdersCache = new Map<string, any[]>();
    const futuresAlgoOrdersCache = new Map<string, any[]>();
    const spotOpenOrdersCache = new Map<string, any[]>();
    const spotBalancesCache = new Map<string, Record<string, number>>();
    const userKeysMap = new Map<string, UserBinanceKeys>();
    const userFetchCounts = new Map<string, { positionRisk: number; openOrders: number; algoOrders: number; spotOpenOrders: number; spotBalances: number }>();

    const userIds = Array.from(new Set(signals.map(signal => String(signal?.user_id || "")).filter(Boolean)));
    const hasFuturesSignals = signals.some(signal => normalizeMarketType(signal.market_type || signal.marketType || signal.market) === "futures");
    const hasSpotSignals = signals.some(signal => normalizeMarketType(signal.market_type || signal.marketType || signal.market) === "spot");

    await Promise.all(userIds.map(async (userId) => {
      const keys = await getUserBinanceSettings(userId);
      if (!keys?.api_key || !keys?.api_secret) return;
      userKeysMap.set(userId, keys);
      userFetchCounts.set(userId, { positionRisk: 0, openOrders: 0, algoOrders: 0, spotOpenOrders: 0, spotBalances: 0 });
    }));

    const ensureFuturesPositions = async (userId: string, userKeys: UserBinanceKeys): Promise<any[]> => {
      const apiKey = userKeys.api_key;
      if (futuresPositionsCache.has(apiKey)) return futuresPositionsCache.get(apiKey) || [];
      const data = await getFuturesPositionsAll(apiKey, userKeys.api_secret);
      futuresPositionsCache.set(apiKey, data);
      const counts = userFetchCounts.get(userId);
      if (counts) counts.positionRisk += 1;
      return data;
    };

    const ensureFuturesOpenOrders = async (userId: string, userKeys: UserBinanceKeys): Promise<any[]> => {
      const apiKey = userKeys.api_key;
      if (futuresOpenOrdersCache.has(apiKey)) return futuresOpenOrdersCache.get(apiKey) || [];
      const data = await getOpenFuturesOrdersAll(apiKey, userKeys.api_secret);
      futuresOpenOrdersCache.set(apiKey, data);
      const counts = userFetchCounts.get(userId);
      if (counts) counts.openOrders += 1;
      return data;
    };

    const ensureFuturesAlgoOrders = async (userId: string, userKeys: UserBinanceKeys): Promise<any[]> => {
      const apiKey = userKeys.api_key;
      if (futuresAlgoOrdersCache.has(apiKey)) return futuresAlgoOrdersCache.get(apiKey) || [];
      const data = await getOpenFuturesAlgoOrdersAll(apiKey, userKeys.api_secret);
      futuresAlgoOrdersCache.set(apiKey, data);
      const counts = userFetchCounts.get(userId);
      if (counts) counts.algoOrders += 1;
      return data;
    };

    const ensureSpotOpenOrders = async (userId: string, userKeys: UserBinanceKeys): Promise<any[]> => {
      const apiKey = userKeys.api_key;
      if (spotOpenOrdersCache.has(apiKey)) return spotOpenOrdersCache.get(apiKey) || [];
      const data = await getOpenSpotOrdersAll(apiKey, userKeys.api_secret);
      spotOpenOrdersCache.set(apiKey, data);
      const counts = userFetchCounts.get(userId);
      if (counts) counts.spotOpenOrders += 1;
      return data;
    };

    const ensureSpotBalances = async (userId: string, userKeys: UserBinanceKeys): Promise<Record<string, number>> => {
      const apiKey = userKeys.api_key;
      if (spotBalancesCache.has(apiKey)) return spotBalancesCache.get(apiKey) || {};
      const data = await getSpotBalancesAll(apiKey, userKeys.api_secret);
      spotBalancesCache.set(apiKey, data);
      const counts = userFetchCounts.get(userId);
      if (counts) counts.spotBalances += 1;
      return data;
    };

    console.log(`👤 uniqueUsers=${userIds.length}`);
    for (const userId of userIds) {
      const counts = userFetchCounts.get(userId);
      if (counts) {
        console.log(`👤 user ${userId}: positionRisk=${counts.positionRisk} openOrders=${counts.openOrders} algoOrders=${counts.algoOrders} spotOpenOrders=${counts.spotOpenOrders} spotBalances=${counts.spotBalances}`);
      }
    }

    const getFuturesCloseState = async (
      signal: any,
      alarmData: { user_id: string; auto_trade_enabled?: boolean | null } | null
    ): Promise<{ position: boolean; openOrders: boolean; algoOrders: boolean; canCheck: boolean }> => {
      if (binanceBanUntil && Date.now() < binanceBanUntil) {
        return { position: false, openOrders: false, algoOrders: false, canCheck: false };
      }
      const alarmPayload = alarmData || { user_id: String(signal?.user_id || "") };
      const autoTradeEnabled = await resolveAutoTradeEnabled(alarmPayload, "futures");
      if (!autoTradeEnabled) return { position: false, openOrders: false, algoOrders: false, canCheck: false };

      const userId = String(signal?.user_id || "");
      const userKeys = userKeysMap.get(userId);
      if (!userKeys?.api_key) return { position: false, openOrders: false, algoOrders: false, canCheck: false };

      const futuresSymbol = String(signal?.symbol || "");
      const upperSymbol = futuresSymbol.toUpperCase();
      const positions = await ensureFuturesPositions(userId, userKeys);
      const position = hasAnyOpenFuturesPositionForSymbol(positions, upperSymbol);

      const openOrders = (await ensureFuturesOpenOrders(userId, userKeys))
        .some((o: any) => String(o?.symbol || "").toUpperCase() === upperSymbol);
      const algoOrders = (await ensureFuturesAlgoOrders(userId, userKeys))
        .some((o: any) => String(o?.symbol || "").toUpperCase() === upperSymbol);

      return { position, openOrders, algoOrders, canCheck: true };
    };

    const alarmIds = Array.from(
      new Set(
        signals
          .map(signal => (signal.alarm_id ? String(signal.alarm_id) : ""))
          .filter(id => id)
      )
    );

    const alarmMap = new Map<string, { id: string; user_id: string; market_type?: string | null; auto_trade_enabled?: boolean | null; binance_order_id?: string | null }>();
    if (alarmIds.length > 0) {
      const { data: alarmsData, error: alarmsError } = await supabase
        .from("alarms")
        .select("id, user_id, market_type, auto_trade_enabled, binance_order_id")
        .in("id", alarmIds);

      if (alarmsError) {
        console.error("❌ Error fetching alarms for close verification:", alarmsError);
      }

      (alarmsData || []).forEach(alarm => {
        if (alarm?.id) {
          alarmMap.set(String(alarm.id), alarm as { id: string; user_id: string; market_type?: string | null; auto_trade_enabled?: boolean | null; binance_order_id?: string | null });
        }
      });
    }

    const activeTradeSet = new Set<string>();
    try {
      const { data: activeTrades, error: activeTradeError } = await supabase
        .from("alarms")
        .select("user_id, symbol")
        .eq("type", "ACTIVE_TRADE")
        .in("status", ACTIVE_ALARM_STATUSES);

      if (activeTradeError) {
        console.error("❌ Error fetching ACTIVE_TRADE alarms for orphan check:", activeTradeError);
      }

      (activeTrades || []).forEach((row: any) => {
        const userId = String(row?.user_id || "");
        const symbol = String(row?.symbol || "").toUpperCase();
        if (userId && symbol) activeTradeSet.add(`${userId}:${symbol}`);
      });
    } catch (e) {
      console.warn("⚠️ ACTIVE_TRADE lookup failed for orphan check:", e);
    }

    const shouldSkipCloseForBinance = async (
      signal: any,
      alarmData: { user_id: string; auto_trade_enabled?: boolean | null } | null,
      marketType: "spot" | "futures"
    ): Promise<boolean> => {
      try {
        if (binanceBanUntil && Date.now() < binanceBanUntil) {
          console.warn(`⛔ Binance ban active. Skipping close verification for ${signal?.symbol || ""}`);
          return false;
        }
        const alarmPayload = alarmData || { user_id: String(signal?.user_id || "") };
        const autoTradeEnabled = await resolveAutoTradeEnabled(alarmPayload, marketType);
        if (!autoTradeEnabled) return false;

        const userId = String(signal?.user_id || "");
        let userKeys = userKeysMap.get(userId);
        if (!userKeys) {
          userKeys = await getUserBinanceSettings(userId) || undefined;
          if (userKeys) userKeysMap.set(userId, userKeys);
        }
        if (!userKeys?.api_key || !userKeys?.api_secret) return false;

        if (marketType === "futures") {
          const futuresSymbol = String(signal?.symbol || "");
          let positions = await ensureFuturesPositions(userId, userKeys);
          const upperSymbol = futuresSymbol.toUpperCase();
          const hasOpen = hasAnyOpenFuturesPositionForSymbol(positions, upperSymbol);
          if (!hasOpen) return false;
          let openOrders = await ensureFuturesOpenOrders(userId, userKeys);
          const hasOrders = openOrders.some((o: any) => String(o?.symbol || "").toUpperCase() === upperSymbol);
          let algoOrders = await ensureFuturesAlgoOrders(userId, userKeys);
          const hasAlgoOrders = algoOrders.some((o: any) => String(o?.symbol || "").toUpperCase() === upperSymbol);
          if (!hasOrders && !hasAlgoOrders) {
            try {
              const symbolInfo = await getSymbolInfo(futuresSymbol, "futures");
              if (symbolInfo) {
                await placeTakeProfitStopLoss(
                  userKeys.api_key,
                  userKeys.api_secret,
                  futuresSymbol,
                  String(signal?.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG",
                  Number(signal?.take_profit),
                  Number(signal?.stop_loss),
                  symbolInfo.pricePrecision,
                  0,
                  symbolInfo.quantityPrecision,
                  symbolInfo.tickSize
                );
                console.log(`🔁 Re-placed TP/SL orders for ${futuresSymbol}`);
              }
            } catch (e) {
              console.warn(`⚠️ Failed to re-place TP/SL for ${futuresSymbol}:`, e);
            }
          }
          console.log(`⏳ Skip reason ${futuresSymbol}: position=${hasOpen} openOrders=${hasOrders} algoOrders=${hasAlgoOrders}`);
          return true;
        }

        const spotSymbol = String(signal?.symbol || "");
        let spotOrders = await ensureSpotOpenOrders(userId, userKeys);
        const hasOpenOrders = spotOrders.some((o: any) => String(o?.symbol || "").toUpperCase() === String(spotSymbol).toUpperCase());
        const baseAsset = resolveSpotBaseAsset(spotSymbol);
        const balances = await ensureSpotBalances(userId, userKeys);
        const balance = Number(balances[String(baseAsset).toUpperCase()] || 0);
        let hasBalance = false;
        if (Number.isFinite(balance) && balance > 0) {
          const info = await getSymbolInfo(spotSymbol, "spot");
          const minQty = Number(info?.minQty || 0);
          const price = spotTickerMap[String(spotSymbol).toUpperCase()];
          const notional = Number.isFinite(price) ? price * balance : NaN;
          const minNotional = 5;
          const qtyBelow = Number.isFinite(minQty) && minQty > 0 ? balance < minQty : false;
          const notionalBelow = Number.isFinite(notional) ? notional < minNotional : true;
          hasBalance = !(qtyBelow && notionalBelow);
        }
        if (hasOpenOrders || hasBalance) {
          console.log(`⏳ Skip reason ${spotSymbol}: position=${hasBalance} openOrders=${hasOpenOrders} algoOrders=false`);
          return true;
        }
        return false;
      } catch (e) {
        console.warn(`⚠️ Binance close verification failed for ${signal?.symbol || ""}:`, e);
        return true;
      }
    };

    const closedSignals: ClosedSignal[] = [];
    const stats: CloseCheckStats = { closesChecked: 0, closed: 0 };

    for (let idx = 0; idx < signals.length; idx++) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.warn(`⏱️ Close checks stopped by deadline. processed=${stats.closesChecked}/${signals.length}`);
        break;
      }
      try {
        const signal = signals[idx];
        stats.closesChecked += 1;
        const symbol = String(signal.symbol || "");
        console.log(`🔎 Close check ${signal.id} ${symbol}`);
        const direction = (signal.condition || signal.direction) as "LONG" | "SHORT";
        
        if (direction !== "LONG" && direction !== "SHORT") {
          console.error(`❌ Invalid direction for signal ${signal.id}`);
          continue;
        }
        const tp = Number(signal.take_profit);
        const sl = Number(signal.stop_loss);

        if (!Number.isFinite(tp) || !Number.isFinite(sl)) {
          console.error(`❌ Invalid TP/SL for signal ${signal.id}`);
          continue;
        }

        const takeProfit = tp;
        const stopLoss = sl;

        const alarmId = signal.alarm_id ? String(signal.alarm_id) : "";
        const alarmData = alarmId ? alarmMap.get(alarmId) || null : null;
        const marketType = normalizeMarketType(
          signal.market_type || signal.marketType || signal.market || alarmData?.market_type || "spot"
        );
        let effectiveMarketType: "spot" | "futures" = marketType;

        let shouldClose = false;
        let closeReason: "TP_HIT" | "SL_HIT" | "TIMEOUT" | "TP_HIT_NO_POSITION" | "SL_HIT_NO_POSITION" | "ORPHAN_ACTIVE_NO_TRADE" | "EXTERNAL_CLOSE" | "" = "";
        let closePrice: number | null = null;

        const symbolKey = String(symbol).toUpperCase();
        const lastPrice = effectiveMarketType === "futures"
          ? futuresTickerMap[symbolKey]
          : spotTickerMap[symbolKey];
        let markPrice: number | undefined;
        let priceForClose = lastPrice;
        if (effectiveMarketType === "futures") {
          markPrice = futuresMarkPriceMap[symbolKey];
          if (Number.isFinite(markPrice)) {
            priceForClose = markPrice;
          } else if (Number.isFinite(lastPrice)) {
            console.warn(`⚠️ markPrice unavailable, fallback to lastPrice for ${symbol}`);
          }
          console.log(`🔎 Close price source: ${JSON.stringify({ symbol, lastPrice, markPrice, priceUsed: "markPrice" })}`);
        }

        if (Number.isFinite(priceForClose)) {
          if (direction === "LONG") {
            if (priceForClose >= takeProfit) {
              shouldClose = true;
              closeReason = "TP_HIT";
              closePrice = takeProfit;
            } else if (priceForClose <= stopLoss) {
              shouldClose = true;
              closeReason = "SL_HIT";
              closePrice = stopLoss;
            }
          } else {
            if (priceForClose <= takeProfit) {
              shouldClose = true;
              closeReason = "TP_HIT";
              closePrice = takeProfit;
            } else if (priceForClose >= stopLoss) {
              shouldClose = true;
              closeReason = "SL_HIT";
              closePrice = stopLoss;
            }
          }
        }

        const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
        const createdAtMs = Date.parse(String(signal.created_at || ""));
        const ageSeconds = Number.isFinite(createdAtMs)
          ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000))
          : 0;
        if (Number.isFinite(createdAtMs) && (Date.now() - createdAtMs) > maxAgeMs) {
          const updateResult = await supabase
            .from("active_signals")
            .update({
              status: "CLOSED",
              close_reason: "TIMEOUT",
              profit_loss: 0,
              closed_at: new Date().toISOString()
            })
            .eq("id", signal.id)
            .in("status", ACTIVE_SIGNAL_STATUSES);

          if (updateResult.error) {
            console.error(`❌ updateError for signal ${signal.id}:`, updateResult.error);
            continue;
          }

          closedSignals.push({
            id: signal.id,
            symbol,
            direction,
            close_reason: "TIMEOUT",
            price: Number(signal.entry_price),
            user_id: signal.user_id,
            market_type: signal.market_type || signal.marketType || signal.market,
            profitLoss: 0,
          });
          continue;
        }

        const shouldRunHeavyChecks = !Number.isFinite(priceForClose)
          || (Math.min(Math.abs(Number(priceForClose) - takeProfit), Math.abs(Number(priceForClose) - stopLoss))
            / Math.max(1e-8, Math.abs(Number(priceForClose)))) * 100 <= CLOSE_NEAR_TARGET_PCT;

        if (!shouldClose && !shouldRunHeavyChecks) {
          if (effectiveMarketType === "futures" && ageSeconds >= EXTERNAL_CLOSE_GRACE_SECONDS) {
            const state = await getFuturesCloseState(signal, alarmData);
            if (state.canCheck && !state.position && !state.openOrders && !state.algoOrders) {
              console.log(`🧭 External close sync: ${JSON.stringify({ signalId: signal.id, symbol, ageSeconds, reason: "EXTERNAL_CLOSE" })}`);
              shouldClose = true;
              closeReason = "EXTERNAL_CLOSE";
              closePrice = Number(signal.entry_price);
            } else if (!state.canCheck && ageSeconds >= FORCE_EXTERNAL_CLOSE_MAX_AGE_SECONDS) {
              console.warn(`🧯 Forced stale close fallback: ${JSON.stringify({ signalId: signal.id, symbol, ageSeconds, reason: "EXTERNAL_CLOSE", mode: "no_verification_available" })}`);
              shouldClose = true;
              closeReason = "EXTERNAL_CLOSE";
              closePrice = Number(signal.entry_price);
            }
          }
        }

        if (!shouldClose && !shouldRunHeavyChecks) {
          continue;
        }

        if (effectiveMarketType === "futures" && !shouldClose) {
          continue;
        }

        const timeframe = String(signal.timeframe || "1h");

        if (!shouldClose) {
          // Kapanis kontrolu: sinyal acildigindan beri TP/SL hit kontrolu.
          const signalStartMs = Date.parse(String(signal.signal_timestamp || signal.created_at || ""));
          if (Number.isFinite(signalStartMs)) {
            const historicalHit = await resolveFirstTouchRange(
              symbol,
              effectiveMarketType,
              timeframe,
              signalStartMs,
              Date.now(),
              direction,
              takeProfit,
              stopLoss
            );
            if (historicalHit) {
              shouldClose = true;
              closeReason = historicalHit;
              closePrice = historicalHit === "TP_HIT" ? takeProfit : stopLoss;
            }
          }
        }

        if (shouldClose && closeReason) {
          // continue to close update section
        } else {
          // Kapanis kontrolu: son kapanan bar + aktif barin high/low degerleri ile anlik TP/SL yakala.
          const timeframeMinutes = timeframeToMinutes(timeframe);
          const timeframeMs = timeframeMinutes * 60 * 1000;
          let klines = await getKlines(symbol, effectiveMarketType, timeframe, 2, 2, true);
          if ((!klines || klines.length < 2) && effectiveMarketType === "spot") {
            effectiveMarketType = "futures";
            klines = await getKlines(symbol, effectiveMarketType, timeframe, 2, 2, true);
          }
          if (klines && klines.length >= 2) {
            const lastClosed = klines[klines.length - 2];
            const currentBar = klines[klines.length - 1];
            const lastClosedHigh = Number(lastClosed?.[2]);
            const lastClosedLow = Number(lastClosed?.[3]);
            const currentHigh = Number(currentBar?.[2]);
            const currentLow = Number(currentBar?.[3]);
            const highCandidates = [lastClosedHigh, currentHigh].filter(v => Number.isFinite(v));
            const lowCandidates = [lastClosedLow, currentLow].filter(v => Number.isFinite(v));
            let barHigh = highCandidates.length ? Math.max(...highCandidates) : NaN;
            let barLow = lowCandidates.length ? Math.min(...lowCandidates) : NaN;

            let currentPrice = await getCurrentPriceFresh(symbol, effectiveMarketType);
            if (effectiveMarketType === "futures") {
              const markFallback = futuresMarkPriceMap[String(symbol).toUpperCase()];
              if (Number.isFinite(markFallback)) currentPrice = markFallback;
            }
            if (Number.isFinite(currentPrice)) {
              barHigh = Number.isFinite(barHigh) ? Math.max(barHigh, currentPrice) : currentPrice;
              barLow = Number.isFinite(barLow) ? Math.min(barLow, currentPrice) : currentPrice;
            }

            if (Number.isFinite(barHigh) && Number.isFinite(barLow)) {
              if (direction === "LONG") {
                const hitSl = barLow <= stopLoss;
                const hitTp = barHigh >= takeProfit;
                if (hitSl && hitTp) {
                  const lastClosedStart = Number(lastClosed?.[0]);
                  const lastClosedEnd = Number(lastClosed?.[6]) || (Number.isFinite(timeframeMs) ? lastClosedStart + timeframeMs : lastClosedStart);
                  let resolved = await resolveFirstTouch(symbol, effectiveMarketType, timeframe, lastClosedStart, lastClosedEnd, direction, takeProfit, stopLoss);
                  if (!resolved && Number.isFinite(Number(currentBar?.[0]))) {
                    const currentStart = Number(currentBar?.[0]);
                    const currentEnd = Math.min(Date.now(), Number.isFinite(timeframeMs) ? currentStart + timeframeMs : Date.now());
                    resolved = await resolveFirstTouch(symbol, effectiveMarketType, timeframe, currentStart, currentEnd, direction, takeProfit, stopLoss);
                  }
                  closeReason = resolved || resolveSameCandleHit(Number(lastClosed?.[1]), takeProfit, stopLoss);
                  shouldClose = true;
                  closePrice = closeReason === "TP_HIT" ? takeProfit : stopLoss;
                } else if (hitSl) {
                  shouldClose = true;
                  closeReason = "SL_HIT";
                  closePrice = stopLoss;
                } else if (hitTp) {
                  shouldClose = true;
                  closeReason = "TP_HIT";
                  closePrice = takeProfit;
                }
              } else if (direction === "SHORT") {
                const hitSl = barHigh >= stopLoss;
                const hitTp = barLow <= takeProfit;
                if (hitSl && hitTp) {
                  const lastClosedStart = Number(lastClosed?.[0]);
                  const lastClosedEnd = Number(lastClosed?.[6]) || (Number.isFinite(timeframeMs) ? lastClosedStart + timeframeMs : lastClosedStart);
                  let resolved = await resolveFirstTouch(symbol, effectiveMarketType, timeframe, lastClosedStart, lastClosedEnd, direction, takeProfit, stopLoss);
                  if (!resolved && Number.isFinite(Number(currentBar?.[0]))) {
                    const currentStart = Number(currentBar?.[0]);
                    const currentEnd = Math.min(Date.now(), Number.isFinite(timeframeMs) ? currentStart + timeframeMs : Date.now());
                    resolved = await resolveFirstTouch(symbol, effectiveMarketType, timeframe, currentStart, currentEnd, direction, takeProfit, stopLoss);
                  }
                  closeReason = resolved || resolveSameCandleHit(Number(lastClosed?.[1]), takeProfit, stopLoss);
                  shouldClose = true;
                  closePrice = closeReason === "TP_HIT" ? takeProfit : stopLoss;
                } else if (hitSl) {
                  shouldClose = true;
                  closeReason = "SL_HIT";
                  closePrice = stopLoss;
                } else if (hitTp) {
                  shouldClose = true;
                  closeReason = "TP_HIT";
                  closePrice = takeProfit;
                }
              }
            }
          } else {
            let currentPrice = await getCurrentPriceFresh(symbol, effectiveMarketType);
            if (effectiveMarketType === "futures") {
              const markFallback = futuresMarkPriceMap[String(symbol).toUpperCase()];
              if (Number.isFinite(markFallback)) currentPrice = markFallback;
            }
            if (Number.isFinite(currentPrice)) {
              if (direction === "LONG") {
                if (currentPrice <= stopLoss) {
                  shouldClose = true;
                  closeReason = "SL_HIT";
                  closePrice = stopLoss;
                } else if (currentPrice >= takeProfit) {
                  shouldClose = true;
                  closeReason = "TP_HIT";
                  closePrice = takeProfit;
                }
              } else if (direction === "SHORT") {
                if (currentPrice >= stopLoss) {
                  shouldClose = true;
                  closeReason = "SL_HIT";
                  closePrice = stopLoss;
                } else if (currentPrice <= takeProfit) {
                  shouldClose = true;
                  closeReason = "TP_HIT";
                  closePrice = takeProfit;
                }
              }
            }
          }
        }

        if (!shouldClose || !closeReason) continue;

        const hasActiveTrade = activeTradeSet.has(`${String(signal?.user_id || "")}:${String(symbol).toUpperCase()}`);
        const tpHit = closeReason === "TP_HIT";
        const slHit = closeReason === "SL_HIT";
        if ((tpHit || slHit) && !hasActiveTrade && ageSeconds > 300) {
          console.log(`🧹 Orphan cleanup: ${JSON.stringify({ signalId: signal.id, symbol, ageSeconds, tpHit, slHit, hasActiveTrade: false })}`);
          closeReason = "ORPHAN_ACTIVE_NO_TRADE";
          closePrice = tpHit ? takeProfit : stopLoss;
        }

        if (effectiveMarketType === "futures" && (closeReason === "TP_HIT" || closeReason === "SL_HIT")) {
          const state = await getFuturesCloseState(signal, alarmData);
          if (state.canCheck) {
            const tpHit = closeReason === "TP_HIT";
            const slHit = closeReason === "SL_HIT";
            console.log(`🧩 TP/SL reconciliation ${JSON.stringify({ symbol, tpHit, slHit, position: state.position, openOrders: state.openOrders, algoOrders: state.algoOrders })}`);
            if ((tpHit || slHit) && !state.position && !state.openOrders && !state.algoOrders) {
              closeReason = tpHit ? "TP_HIT_NO_POSITION" : "SL_HIT_NO_POSITION";
            }
          }
        }

        if (closeReason !== "ORPHAN_ACTIVE_NO_TRADE" && closeReason !== "EXTERNAL_CLOSE") {
          const skipClose = await shouldSkipCloseForBinance(signal, alarmData, effectiveMarketType);
          if (skipClose) {
            console.log(`⏳ Skipping close for ${signal.symbol}: Binance position/orders still open`);
            continue;
          }
        }

        const effectiveClosePrice = Number.isFinite(closePrice) ? Number(closePrice) : Number(signal.entry_price);
        const rawProfitLoss = direction === "LONG"
          ? ((effectiveClosePrice - Number(signal.entry_price)) / Number(signal.entry_price)) * 100
          : ((Number(signal.entry_price) - effectiveClosePrice) / Number(signal.entry_price)) * 100;

        const tpPercent = Number(signal.tp_percent);
        const slPercent = Number(signal.sl_percent);
        let profitLoss = rawProfitLoss;
        if (closeReason === "TP_HIT" && Number.isFinite(tpPercent)) {
          profitLoss = Math.abs(tpPercent);
        } else if (closeReason === "SL_HIT" && Number.isFinite(slPercent)) {
          profitLoss = -Math.abs(slPercent);
        } else if (closeReason === "TP_HIT_NO_POSITION" || closeReason === "SL_HIT_NO_POSITION" || closeReason === "ORPHAN_ACTIVE_NO_TRADE" || closeReason === "NOT_FILLED" || closeReason === "EXTERNAL_CLOSE") {
          profitLoss = 0;
        }

        const closeReasonForDb = normalizeCloseReasonForDb(closeReason);

        const updateResult = await supabase
          .from("active_signals")
          .update({
            status: "CLOSED",
            close_reason: closeReasonForDb,
            profit_loss: profitLoss,
            closed_at: new Date().toISOString()
          })
          .eq("id", signal.id)
          .in("status", ACTIVE_SIGNAL_STATUSES)
          .select("id");

        if (updateResult.error) {
          console.error(`❌ updateError for signal ${signal.id}:`, updateResult.error);
          continue;
        }

        const updatedRows = Array.isArray(updateResult.data) ? updateResult.data.length : 0;
        if (updatedRows === 0) {
          console.log(`⏭️ Skip close notify for ${signal.symbol}: already closed by another run`);
          continue;
        }

        try {
          if (signal.alarm_id) {
            await supabase
              .from("alarms")
              .update({ binance_order_id: null })
              .eq("id", signal.alarm_id);
          }
        } catch (e) {
          console.warn(`⚠️ Failed to clear binance_order_id for alarm ${signal.alarm_id}:`, e);
        }

        console.log(`✅ Signal ${signal.id} (${signal.symbol}) CLOSED: ${closeReason} | P&L: ${profitLoss.toFixed(2)}%`);

        closedSignals.push({
          id: signal.id,
          symbol,
          direction,
          close_reason: closeReasonForDb,
          price: Number.isFinite(closePrice) ? Number(closePrice) : Number(signal.entry_price),
          user_id: signal.user_id,
          market_type: signal.market_type || signal.marketType || signal.market,
          profitLoss,
        });
        stats.closed += 1;
      } catch (e) {
        console.error(`❌ Error checking signal ${signals[idx]?.id}:`, e);
      }
    }

    return { closedSignals, stats };
  } catch (e) {
    console.error("❌ Error in checkAndCloseSignals:", e);
    return { closedSignals: [], stats: { closesChecked: 0, closed: 0 } };
  }
}

// =====================
// Insert new signal (optional incoming body)
// =====================
type NewSignal = {
  user_id: string;
  alarm_id?: string | null;
  market_type?: "spot" | "futures";
  symbol: string; // e.g. BTCUSDT
  timeframe: string;
  signal_direction: "LONG" | "SHORT";
  entry_price: number;
  take_profit: number;
  stop_loss: number;
  confidence_score: number;
  tp_percent: number;
  sl_percent: number;
  signal_timestamp: string;
  status?: "ACTIVE";
  created_at?: string;
  current_price?: number | null;
  telegram_sent_at?: string | null;
  close_price?: number | null;
  close_reason?: string | null;
  profit_loss?: number | null;
  closed_price?: number | null;
  type?: "auto_signal";
};

async function insertSignalIfProvided(body: any): Promise<{ inserted: boolean; duplicate: boolean }> {
  if (!body || !body.symbol || !body.direction || !body.user_id) {
    return { inserted: false, duplicate: false };
  }

  const userId = String(body.user_id);
  const symbol = String(body.symbol).toUpperCase();
  const rawDirection = String(body.direction ?? body.signal_direction ?? body.signalDirection ?? "").toUpperCase();
  const direction = rawDirection === "SHORT" ? "SHORT" : "LONG";
  const marketType = normalizeMarketType(body.market_type ?? body.marketType ?? body.market);

  const entryPrice = Number(body.entry_price ?? body.entryPrice ?? body.entry);
  const takeProfit = Number(body.take_profit ?? body.takeProfit);
  const stopLoss = Number(body.stop_loss ?? body.stopLoss);
  const timeframe = String(body.timeframe ?? "").trim();

  if (!timeframe || !Number.isFinite(entryPrice) || !Number.isFinite(takeProfit) || !Number.isFinite(stopLoss)) {
    throw new Error("Missing or invalid fields: timeframe, entry_price, take_profit, stop_loss");
  }
  if (entryPrice <= 0) {
    throw new Error("Invalid entry_price: must be > 0");
  }

  const tpPercentRaw = Number(body.tp_percent ?? body.tpPercent);
  const slPercentRaw = Number(body.sl_percent ?? body.slPercent);
  const tpPercent = Number.isFinite(tpPercentRaw)
    ? tpPercentRaw
    : Math.abs(((takeProfit - entryPrice) / entryPrice) * 100);
  const slPercent = Number.isFinite(slPercentRaw)
    ? slPercentRaw
    : Math.abs(((entryPrice - stopLoss) / entryPrice) * 100);

  const confidenceRaw = Number(body.confidence_score ?? body.confidenceScore ?? 0);
  const confidenceScore = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;

  const signalTimestamp = String(body.signal_timestamp ?? body.signalTimestamp ?? new Date().toISOString());

  const newSignal: NewSignal = {
    user_id: userId,
    alarm_id: body.alarm_id ? String(body.alarm_id) : null,
    market_type: marketType,
    symbol,
    timeframe,
    signal_direction: direction,
    entry_price: entryPrice,
    take_profit: takeProfit,
    stop_loss: stopLoss,
    confidence_score: confidenceScore,
    tp_percent: tpPercent,
    sl_percent: slPercent,
    signal_timestamp: signalTimestamp,
    status: "ACTIVE",
    created_at: new Date().toISOString(),
    current_price: null,
    telegram_sent_at: null,
    close_price: null,
    close_reason: null,
    profit_loss: null,
    closed_price: null,
    type: "auto_signal",
  };

  // ✅ Alarm exists check: skip orphan signals
  try {
    if (newSignal.alarm_id) {
      const alarmIdNum = Number(newSignal.alarm_id);
      if (!Number.isFinite(alarmIdNum)) {
        console.warn("⚠️ Invalid alarm_id for signal insert, skipping:", newSignal.alarm_id);
        return { inserted: false, duplicate: false };
      }
      const { data: alarmRow, error: alarmError } = await supabase
        .from("alarms")
        .select("id, is_active, status")
        .eq("id", alarmIdNum)
        .eq("user_id", newSignal.user_id)
        .eq("type", "user_alarm")
        .maybeSingle();

      if (alarmError) {
        console.error("❌ Alarm lookup failed:", alarmError);
        return { inserted: false, duplicate: false };
      }
      const status = String(alarmRow?.status || "").toUpperCase();
      if (!alarmRow || alarmRow.is_active === false || (status && status !== "ACTIVE")) {
        console.warn("⚠️ Alarm not active/exists, skipping signal insert:", newSignal.alarm_id);
        return { inserted: false, duplicate: false };
      }
    } else {
      const { data: activeAlarm, error: activeAlarmError } = await supabase
        .from("alarms")
        .select("id")
        .eq("user_id", newSignal.user_id)
        .eq("type", "user_alarm")
        .eq("is_active", true)
        .eq("symbol", newSignal.symbol)
        .maybeSingle();

      if (activeAlarmError) {
        console.error("❌ Active alarm lookup failed:", activeAlarmError);
        return { inserted: false, duplicate: false };
      }
      if (!activeAlarm?.id) {
        console.warn("⚠️ No active alarm for user/symbol, skipping signal insert:", newSignal.symbol);
        return { inserted: false, duplicate: false };
      }
      newSignal.alarm_id = String(activeAlarm.id);
    }
  } catch (e) {
    console.error("❌ Alarm validation error:", e);
    return { inserted: false, duplicate: false };
  }

  // Duplicate check - prevent same signal from being inserted twice
  const { data: existing, error } = await supabase
    .from("active_signals")
    .select("id")
    .eq("user_id", newSignal.user_id)
    .eq("symbol", newSignal.symbol)
    .eq("direction", newSignal.signal_direction)
    .in("status", ACTIVE_SIGNAL_STATUSES)
    .maybeSingle();

  if (error) {
    console.error("❌ duplicate check error:", error);
  }

  if (existing?.id) {
    console.log(`⚠️ Duplicate signal attempt: ${newSignal.symbol} ${newSignal.signal_direction}`);
    const duplicateMessage = `⚠️ <b>AKTIF SİNYAL VAR</b>\n\n💰 Çift: <b>${escapeHtml(newSignal.symbol)}</b>\n🎯 Yön: <b>${escapeHtml(newSignal.signal_direction)}</b>\n⏰ Zaman: <b>${escapeHtml(formatTurkeyDateTime(resolveBarCloseDisplayTimeMs(newSignal.signal_timestamp, String(newSignal.timeframe || "1h"))))}</b>`;
    await sendTelegramNotification(newSignal.user_id, duplicateMessage);
    return { inserted: false, duplicate: true };
  }

  // Prepare signal data for active_signals table
  const activeSignalData = {
    user_id: newSignal.user_id,
    alarm_id: newSignal.alarm_id,
    symbol: newSignal.symbol,
    market_type: newSignal.market_type,
    timeframe: newSignal.timeframe,
    direction: newSignal.signal_direction,
    entry_price: newSignal.entry_price,
    take_profit: newSignal.take_profit,
    stop_loss: newSignal.stop_loss,
    tp_percent: newSignal.tp_percent,
    sl_percent: newSignal.sl_percent,
    signal_timestamp: newSignal.signal_timestamp,
    status: "ACTIVE",
    created_at: newSignal.created_at
  };

  const { data: insertedSignal, error: insertError } = await supabase
    .from("active_signals")
    .insert(activeSignalData)
    .select("id")
    .single();

  if (insertError) {
    console.error("❌ insertError:", insertError);
    throw new Error("Failed to insert new signal");
  }

  if (insertedSignal?.id) {
    await updateActiveSignalTelegramStatus(insertedSignal.id, "QUEUED", null);
    console.log(`📨 Telegram queued for inserted signal ${insertedSignal.id} (${newSignal.symbol})`);

    const pricePrecision = await getSymbolPricePrecision(newSignal.symbol, newSignal.market_type || "spot");
    const directionTR = newSignal.signal_direction === "SHORT" ? "🔴 SHORT" : "🟢 LONG";
    const safeSymbol = escapeHtml(newSignal.symbol);
    const safeDirection = escapeHtml(directionTR);
    const safeMarketType = escapeHtml(String(newSignal.market_type || "spot").toUpperCase());
    const safeTimeframe = escapeHtml(String(newSignal.timeframe || "1h"));
    const safeEntry = escapeHtml(formatPriceWithPrecision(newSignal.entry_price, pricePrecision));
    const safeTp = escapeHtml(formatPriceWithPrecision(newSignal.take_profit, pricePrecision));
    const safeSl = escapeHtml(formatPriceWithPrecision(newSignal.stop_loss, pricePrecision));
    const safeDate = escapeHtml(formatTurkeyDateTime(resolveBarCloseDisplayTimeMs(newSignal.signal_timestamp, String(newSignal.timeframe || "1h"))));

    const telegramMessage = `
🔔 <b>ALARM AKTİVE!</b> 🔔

💰 Çift: <b>${safeSymbol}</b>
🎯 ${safeDirection} Sinyali Tespit Edildi!

📊 Piyasa: <b>${safeMarketType}</b> | Zaman: <b>${safeTimeframe}</b>
💹 Fiyat: <b>$${safeEntry}</b>

🎯 Hedefler:
  TP: <b>$${safeTp}</b> (<b>+${newSignal.tp_percent}%</b>)
  SL: <b>$${safeSl}</b> (<b>-${newSignal.sl_percent}%</b>)

⏰ Zaman: <b>${safeDate}</b>
`;

    const sendResult = await sendTelegramNotification(newSignal.user_id, telegramMessage);
    await updateActiveSignalTelegramStatus(insertedSignal.id, sendResult.status, sendResult.error ?? null);
  }

  return { inserted: true, duplicate: false };
}

// =====================
// Handler
// =====================
serve(async (req: any) => {
  const requestStartMs = Date.now();
  const hardDeadlineMs = requestStartMs + HARD_TIMEOUT_MS;
  const startRequestCount = requestCount;
  const startBinanceCount = binanceRequestCount;
  requestMetrics = { klinesFetched: 0, klinesSkippedByProximity: 0, exchangeInfoFetches: 0 };
  let closeStats: CloseCheckStats = { closesChecked: 0, closed: 0 };
  let triggerStats: TriggerCheckStats = { alarmsProcessed: 0, triggersChecked: 0, triggered: 0, skippedActive: 0 };
  // CORS headers
  const origin = req.headers.get("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-requested-with",
    "Access-Control-Max-Age": "86400",
  };

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!supabase) {
    supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    console.log("🚀 [CRON] Starting alarm signals check");

    // Body optional
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    body = body || {};
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const authToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (body?.action === "alarm_notification") {
      if (!authToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: authData, error: authError } = await supabase.auth.getUser(authToken);
      if (authError || !authData?.user?.id) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const message = await buildAlarmNotificationMessage(body?.notification_type, body?.alarm || {});
      if (!message) {
        return new Response(JSON.stringify({ ok: false, error: "Empty message" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const sendResult = await sendTelegramNotification(authData.user.id, message);
      return new Response(JSON.stringify(sendResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ Auth guard (optional - enforced only if CRON_SECRET is set)
    if (cronSecret) {
      if (authToken !== cronSecret) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    console.log("📥 [DEBUG] Request body:", JSON.stringify(sanitizeRequestBodyForLog(body), null, 2));
    console.log("📥 [DEBUG] body?.user_id:", body?.user_id);
    console.log("📥 [DEBUG] typeof body?.user_id:", typeof body?.user_id);
    console.log("📥 [DEBUG] Boolean(body?.user_id):", Boolean(body?.user_id));

    // Try to get user_id from auth header if not in body
    if (!body?.user_id && authToken) {
      const extractedUserId = extractUserIdFromJwt(authToken);
      if (extractedUserId) {
        body.user_id = extractedUserId;
        console.log("📥 [DEBUG] Extracted user_id from JWT:", body.user_id);
      } else {
        console.log("📥 [DEBUG] Could not decode JWT token");
      }
    }

    // ✅ Test notification request
    if (body?.action === "test_notification") {
      if (!telegramBotToken) {
        return new Response(JSON.stringify({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const chatId = String(body?.telegramUsername || body?.telegram_chat_id || body?.chatId || "").trim();
      if (!chatId) {
        return new Response(JSON.stringify({ ok: false, error: "Missing telegram chat id" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const now = new Date().toLocaleString("tr-TR");
      const message = `✅ Test bildirimi başarılı!\n\n⏰ Zaman: ${now}`;
      const result = await sendTelegramToChatId(chatId, message);

      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ Test Binance connection request
    if (body?.action === "test_binance_connection") {
      const apiKey = String(body?.api_key || "").trim();
      const apiSecret = String(body?.api_secret || "").trim();

      if (!apiKey || !apiSecret) {
        return new Response(JSON.stringify({
          success: false,
          error: "Missing API key or secret"
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      try {
        const futuresBalance = await getBinanceBalance(apiKey, apiSecret, "futures");
        const spotBalance = await getBinanceBalance(apiKey, apiSecret, "spot");

        return new Response(JSON.stringify({
          success: true,
          futures_balance: futuresBalance,
          spot_balance: spotBalance
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          error: e instanceof Error ? e.message : "Connection failed"
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    if (body?.action === "health_check") {
      const nowIso = new Date().toISOString();
      const staleCutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const [
        activeSignalsCount,
        staleActiveSignalsCount,
        recentClosedCount,
        failedOpenTelegramCount,
        failedCloseTelegramCount,
      ] = await Promise.all([
        supabase
          .from("active_signals")
          .select("id", { count: "exact", head: true })
          .in("status", ACTIVE_SIGNAL_STATUSES),
        supabase
          .from("active_signals")
          .select("id", { count: "exact", head: true })
          .in("status", ACTIVE_SIGNAL_STATUSES)
          .lt("created_at", staleCutoffIso),
        supabase
          .from("active_signals")
          .select("id", { count: "exact", head: true })
          .eq("status", "CLOSED")
          .gte("closed_at", oneHourAgoIso),
        supabase
          .from("active_signals")
          .select("id", { count: "exact", head: true })
          .in("status", ACTIVE_SIGNAL_STATUSES)
          .eq("telegram_status", "FAILED"),
        supabase
          .from("active_signals")
          .select("id", { count: "exact", head: true })
          .eq("status", "CLOSED")
          .eq("telegram_close_status", "FAILED")
          .gte("closed_at", oneHourAgoIso),
      ]);

      return new Response(JSON.stringify({
        success: true,
        timestamp: nowIso,
        health: {
          active_signals: activeSignalsCount.count || 0,
          stale_active_signals_30m: staleActiveSignalsCount.count || 0,
          closed_last_1h: recentClosedCount.count || 0,
          open_telegram_failed_active: failedOpenTelegramCount.count || 0,
          close_telegram_failed_last_1h: failedCloseTelegramCount.count || 0,
        },
        runtime: {
          binance_ban_active: binanceBanUntil > Date.now(),
          binance_ban_remaining_sec: binanceBanUntil > Date.now() ? Math.ceil((binanceBanUntil - Date.now()) / 1000) : 0,
          binance_time_offset_ms: binanceTimeOffsetMs,
          algo_endpoint_cooldown_active: futuresAlgoEndpointBlockedUntil > Date.now(),
          algo_endpoint_cooldown_remaining_sec: futuresAlgoEndpointBlockedUntil > Date.now() ? Math.ceil((futuresAlgoEndpointBlockedUntil - Date.now()) / 1000) : 0,
        }
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ✅ If request includes a new signal, insert it (with duplicate prevention)
    let insertResult = { inserted: false, duplicate: false };
    try {
      if (body) insertResult = await insertSignalIfProvided(body);
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Bad request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Active alarms check (using user_alarms table)
    // Check alarms for specific user or all active alarms for cron
    let alarms = null;
    let alarmsError = null;

    if (body?.user_id) {
      const result = await supabase
        .from("alarms")
        .select("*")
        .eq("user_id", body.user_id)
        .eq("type", "user_alarm")
        .eq("is_active", true)
        .not("user_id", "is", null);

      alarms = result.data?.filter((alarm: any) => isActiveLikeStatus(alarm.status));
      alarmsError = result.error;
    } else {
      // Cron mode: get all active alarms
      console.log("🔄 [CRON] Getting all active alarms for monitoring");
      
      const result = await supabase
        .from("alarms")
        .select("*")
        .eq("type", "user_alarm")
        .eq("is_active", true);

      alarms = result.data?.filter((alarm: any) => isActiveLikeStatus(alarm.status));
      alarmsError = result.error;
      console.log(`📥 Cron alarms: raw=${result.data?.length || 0}, activeLike=${alarms?.length || 0}`);
    }

    if (alarmsError) {
      console.error("❌ Error fetching alarms:", alarmsError);
      // Don't fail the request, just log the error
    }

    if (alarms && alarms.length > 1) {
      alarms = alarms.slice().sort((a: any, b: any) => {
        const aTs = Date.parse(String(a?.signal_timestamp || a?.created_at || ""));
        const bTs = Date.parse(String(b?.signal_timestamp || b?.created_at || ""));
        const aSafe = Number.isFinite(aTs) ? aTs : Number.MAX_SAFE_INTEGER;
        const bSafe = Number.isFinite(bTs) ? bTs : Number.MAX_SAFE_INTEGER;
        return aSafe - bSafe;
      });
    }

    const totalAlarms = alarms?.length || 0;
    if (alarms && totalAlarms > MAX_ALARMS_PER_CRON) {
      alarms = alarms.slice(0, MAX_ALARMS_PER_CRON);
      console.warn(`⚠️ Alarm list truncated: ${totalAlarms} -> ${alarms.length}`);
    }

    console.log(`📊 Found ${alarms?.length || 0} active alarms${body?.user_id ? ' for user' : ' (cron mode)'}`);

    // ✅ Close signals that hit TP/SL (prioritize before heavy alarm scans)
    const closeResult = await checkAndCloseSignals(hardDeadlineMs);
    const closedSignals = closeResult.closedSignals;
    closeStats = closeResult.stats;

    if (DISABLE_ALARM_PROCESSING) {
      console.warn("⚠️ Alarm processing disabled (close-only mode)");
    } else if (alarms && alarms.length > 0) {
      const deadlineMs = requestStartMs + MAX_REQUEST_RUNTIME_MS;
      const tickerMaps = { spot: allTickerCache.spot.prices, futures: allTickerCache.futures.prices };
      triggerStats = await checkAndTriggerUserAlarms(alarms, deadlineMs, tickerMaps);
    }

    // ✅ Notify - 🚀 PARALLELIZED
    const notificationPromises = closedSignals.map(async signal => {
      const closeReason = String(signal.close_reason || "").toUpperCase();
      if (closeReason === "NOT_FILLED" || closeReason === "EXTERNAL_CLOSE") {
        await updateActiveSignalCloseTelegramStatus(signal.id, "SKIPPED", "no_close_notification_for_non_opened_or_external_close");
        return;
      }
      const telegramMessage = await buildClosedSignalTelegramMessage(signal);
      await updateActiveSignalCloseTelegramStatus(signal.id, "QUEUED", null);
      const sendResult = await sendTelegramNotification(signal.user_id, telegramMessage);
      await updateActiveSignalCloseTelegramStatus(signal.id, sendResult.status, sendResult.error ?? null);
      return;
    });
    
    await Promise.all(notificationPromises);

    await retryFailedOpenTelegrams();
    await retryFailedCloseTelegrams();

    const elapsedMs = Date.now() - requestStartMs;
    console.log(`📊 Request counts: total=${requestCount - startRequestCount}, binance=${binanceRequestCount - startBinanceCount}`);
    const endpointSummary = Object.entries(endpointStats)
      .map(([key, stat]) => `${key}=${stat.count} (${Math.round(stat.totalMs / Math.max(1, stat.count))}ms avg)`)
      .join(" | ");
    if (endpointSummary) {
      console.log(`📊 Endpoint stats: ${endpointSummary}`);
    }
    console.log(`📊 Klines stats: fetched=${requestMetrics.klinesFetched} skippedByProximity=${requestMetrics.klinesSkippedByProximity} exchangeInfoFetches=${requestMetrics.exchangeInfoFetches}`);
    console.log(`✅ Summary: alarmsProcessed=${triggerStats.alarmsProcessed} closesChecked=${closeStats.closesChecked} closed=${closeStats.closed} triggersChecked=${triggerStats.triggersChecked} triggered=${triggerStats.triggered} skippedActive=${triggerStats.skippedActive}`);
    console.log(`⏱️ Request duration: ${elapsedMs}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        alarms_checked: alarms?.length || 0,
        inserted_signal: insertResult.inserted,
        duplicate_signal: insertResult.duplicate,
        closed_signals: closedSignals.length,
        message: "Alarm signals check completed",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("❌ Fatal error:", e);
    const elapsedMs = Date.now() - requestStartMs;
    console.log(`📊 Request counts (error): total=${requestCount - startRequestCount}, binance=${binanceRequestCount - startBinanceCount}`);
    const endpointSummary = Object.entries(endpointStats)
      .map(([key, stat]) => `${key}=${stat.count} (${Math.round(stat.totalMs / Math.max(1, stat.count))}ms avg)`)
      .join(" | ");
    if (endpointSummary) {
      console.log(`📊 Endpoint stats (error): ${endpointSummary}`);
    }
    console.log(`📊 Klines stats (error): fetched=${requestMetrics.klinesFetched} skippedByProximity=${requestMetrics.klinesSkippedByProximity} exchangeInfoFetches=${requestMetrics.exchangeInfoFetches}`);
    console.log(`✅ Summary: alarmsProcessed=${triggerStats.alarmsProcessed} closesChecked=${closeStats.closesChecked} closed=${closeStats.closed} triggersChecked=${triggerStats.triggersChecked} triggered=${triggerStats.triggered} skippedActive=${triggerStats.skippedActive}`);
    console.log(`⏱️ Request duration (error): ${elapsedMs}ms`);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
