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

// CRITICAL: Fail fast if env vars missing
if (!supabaseUrl) {
  throw new Error("❌ FATAL: SUPABASE_URL not set in Edge Function environment variables");
}
if (!supabaseServiceRoleKey) {
  throw new Error("❌ FATAL: SUPABASE_SERVICE_ROLE_KEY not set in Edge Function environment variables");
}
if (!telegramBotToken) {
  throw new Error("❌ FATAL: TELEGRAM_BOT_TOKEN not set in Edge Function environment variables");
}

// Single supabase client for whole function (more efficient)
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// =====================
// CRON Lock Helpers (prevent duplicate runs)
// =====================
async function acquireCronLock(lockName: string, ttlSeconds: number = 55): Promise<{ acquired: boolean; requestId: string }> {
  const requestId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - ttlSeconds * 1000).toISOString();

  try {
    await supabase
      .from("cron_locks")
      .upsert({ name: lockName }, { onConflict: "name", ignoreDuplicates: true });

    const { data, error } = await supabase
      .from("cron_locks")
      .update({
        last_started_at: nowIso,
        last_status: "RUNNING",
        last_request_id: requestId,
        updated_at: nowIso
      })
      .eq("name", lockName)
      .or(`last_started_at.lt.${cutoffIso},last_started_at.is.null`)
      .select("name");

    if (error) {
      console.error("❌ Cron lock update error:", error);
      return { acquired: true, requestId };
    }

    const acquired = Array.isArray(data) && data.length > 0;
    return { acquired, requestId };
  } catch (e) {
    console.error("❌ Cron lock exception:", e);
    return { acquired: true, requestId };
  }
}

async function releaseCronLock(lockName: string, requestId: string, status: "DONE" | "ERROR"): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await supabase
      .from("cron_locks")
      .update({
        last_finished_at: nowIso,
        last_status: status,
        updated_at: nowIso
      })
      .eq("name", lockName)
      .eq("last_request_id", requestId);
  } catch (e) {
    console.error("❌ Cron lock release error:", e);
  }
}

// =====================
// Binance API bases & price cache
// =====================
const BINANCE_SPOT_API_BASE = "https://api.binance.com/api/v3";
const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com/fapi/v1";

// Exchange info cache (tick size / price precision)
const exchangeInfoCache: Record<string, { timestamp: number; symbols: Record<string, any> }> = {};
const EXCHANGE_INFO_TTL = 10 * 60 * 1000; // 10 minutes

function getTickSizeDecimals(tickSize: string): number {
  if (!tickSize || !tickSize.includes(".")) return 0;
  const fraction = tickSize.split(".")[1] || "";
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length;
}

function roundToTick(value: number, tickSize: number, mode: "NEAREST" | "UP" | "DOWN" = "NEAREST"): number {
  if (!Number.isFinite(value) || !Number.isFinite(tickSize) || tickSize <= 0) return value;
  const scaled = value / tickSize;
  const epsilon = 1e-12;
  let rounded: number;
  if (mode === "UP") {
    rounded = Math.ceil(scaled - epsilon);
  } else if (mode === "DOWN") {
    rounded = Math.floor(scaled + epsilon);
  } else {
    rounded = Math.round(scaled);
  }
  return rounded * tickSize;
}

async function getSymbolPricePrecision(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  const cacheKey = marketType;
  const now = Date.now();
  const cached = exchangeInfoCache[cacheKey];
  if (cached && (now - cached.timestamp) < EXCHANGE_INFO_TTL) {
    const info = cached.symbols?.[symbol];
    if (info) return info.pricePrecision ?? null;
  }

  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = `${base}/exchangeInfo`;
  const res = await throttledFetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const symbols = (data?.symbols || []).reduce((acc: Record<string, any>, item: any) => {
    const priceFilter = (item.filters || []).find((f: any) => f.filterType === "PRICE_FILTER");
    const tickSize = priceFilter?.tickSize;
    const pricePrecision = typeof item.pricePrecision === "number"
      ? item.pricePrecision
      : (tickSize ? getTickSizeDecimals(String(tickSize)) : null);
    acc[String(item.symbol)] = { pricePrecision };
    return acc;
  }, {});

  exchangeInfoCache[cacheKey] = { timestamp: now, symbols };
  const info = symbols?.[symbol];
  return info ? info.pricePrecision ?? null : null;
}

function formatPriceWithPrecision(value: number, precision: number | null): string {
  if (!Number.isFinite(value)) return "0";
  if (precision === null || precision === undefined) {
    return value.toFixed(8);
  }
  return value.toFixed(Math.max(0, precision));
}

function formatQuantityWithPrecision(value: number, precision: number): string {
  const safePrecision = Math.max(0, precision);
  const fixed = value.toFixed(safePrecision);
  if (safePrecision === 0) return fixed;
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

// Global ban cooldown (Binance 418)
let binanceBanUntil = 0;

// Cache prices to avoid redundant API calls
const priceCache: Record<string, { price: number; timestamp: number }> = {};
const PRICE_CACHE_TTL = 5000; // 5 seconds - refresh every 5s max

// =====================
// Request throttling & queueing (prevent rate limiting)
// =====================
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2000ms (2s) minimum between ALL requests - CRITICAL for Binance
let requestQueue: Array<{ url: string; options?: any; resolve: Function; reject: Function }> = [];
let isProcessingQueue = false;

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
      
      const response = await fetch(url, { ...options, signal: controller.signal });
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
const KLINES_CACHE_TTL = 30000; // 30 seconds - reduce API pressure

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


async function getCurrentPrice(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  try {
    // Check price cache first
    const cacheKey = `${symbol}:${marketType}`;
    const now = Date.now();
    if (priceCache[cacheKey] && (now - priceCache[cacheKey].timestamp) < PRICE_CACHE_TTL) {
      console.log(`💾 Cache hit for ${symbol} (${priceCache[cacheKey].price})`);
      return priceCache[cacheKey].price;
    }

    const klines = await getKlines(symbol, marketType, "1m", 2);
    if (!klines || klines.length === 0) {
      console.error(`❌ price fetch failed for ${symbol}: klines unavailable`);
      return null;
    }
    const lastKline = klines[klines.length - 1];
    const p = Number(lastKline?.[4]);
    if (!Number.isFinite(p)) return null;
    
    // Cache the price
    priceCache[cacheKey] = { price: p, timestamp: now };
    
    return p;
  } catch (e) {
    console.error(`❌ price fetch error for ${symbol}:`, e);
    return null;
  }
}

async function getFuturesMarkPrice(symbol: string): Promise<number | null> {
  try {
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

async function getLivePrice(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  if (marketType === "futures") {
    const markPrice = await getFuturesMarkPrice(symbol);
    if (markPrice !== null) return markPrice;
  }
  return await getCurrentPrice(symbol, marketType);
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

async function getSymbolInfo(symbol: string, marketType: "spot" | "futures"): Promise<{ quantityPrecision: number; minQty: number; pricePrecision: number; tickSize: number } | null> {
  const baseUrl = marketType === "futures"
    ? "https://fapi.binance.com/fapi/v1/exchangeInfo"
    : "https://api.binance.com/api/v3/exchangeInfo";

  const response = await fetch(baseUrl);
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

  return { quantityPrecision, minQty, pricePrecision, tickSize: parseFloat(tickSize) };
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

async function openBinanceTrade(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  quantity: string,
  marketType: "spot" | "futures",
  positionSide?: "LONG" | "SHORT",
  orderType: "MARKET" | "LIMIT" = "MARKET",
  limitPrice?: string
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const timestamp = Date.now();
  const side = direction === "LONG" ? "BUY" : "SELL";

  let queryString: string;
  let baseUrl: string;

  if (marketType === "futures") {
    const positionSideParam = positionSide ? `&positionSide=${positionSide}` : "";
    if (orderType === "LIMIT") {
      if (!limitPrice || !String(limitPrice).length) {
        return { success: false, error: "Limit price required" };
      }
      queryString = `symbol=${symbol}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${limitPrice}${positionSideParam}&timestamp=${timestamp}`;
    } else {
      queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}${positionSideParam}&timestamp=${timestamp}`;
    }
    baseUrl = "https://fapi.binance.com/fapi/v1/order";
  } else {
    queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    baseUrl = "https://api.binance.com/api/v3/order";
  }

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

  return { success: true, orderId: String(data.orderId) };
}

async function placeTakeProfitStopLoss(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  takeProfit: number,
  stopLoss: number,
  pricePrecision: number,
  tickSize: number,
  positionSide?: "LONG" | "SHORT"
): Promise<{ tpOrderId?: string; slOrderId?: string; tpError?: string; slError?: string }> {
  const closeSide = direction === "LONG" ? "SELL" : "BUY";
  const positionSideParam = positionSide ? `&positionSide=${positionSide}` : "";
  const tpRounded = roundToTick(
    takeProfit,
    tickSize,
    direction === "LONG" ? "UP" : "DOWN"
  );
  const slRounded = roundToTick(
    stopLoss,
    tickSize,
    direction === "LONG" ? "DOWN" : "UP"
  );
  const tpPrice = tpRounded.toFixed(pricePrecision);
  const slPrice = slRounded.toFixed(pricePrecision);

  // Prevent immediate-trigger errors (Binance -2021)
  const markPrice = await getFuturesMarkPrice(symbol) ?? await getCurrentPrice(symbol, "futures");
  const isTpImmediate = Number.isFinite(markPrice)
    ? (direction === "LONG" ? markPrice >= tpRounded : markPrice <= tpRounded)
    : false;
  const isSlImmediate = Number.isFinite(markPrice)
    ? (direction === "LONG" ? markPrice <= slRounded : markPrice >= slRounded)
    : false;

  let tpOrderId: string | undefined;
  let slOrderId: string | undefined;
  let tpError: string | undefined;
  let slError: string | undefined;

  if (isTpImmediate) {
    tpError = `TP zaten tetiklenmiş olabilir (mark: ${formatPriceWithPrecision(markPrice as number, pricePrecision)})`;
  } else {
    const tpTimestamp = Date.now();
    const algoTp = await placeFuturesAlgoOrder(apiKey, apiSecret, symbol, closeSide, "TAKE_PROFIT_MARKET", tpPrice, positionSide);
    if (algoTp.ok) {
      tpOrderId = algoTp.orderId;
    } else {
      const tpQueryBase = `symbol=${symbol}&side=${closeSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tpPrice}&closePosition=true&workingType=MARK_PRICE&priceProtect=true`;
      const tpQuery = `${tpQueryBase}${positionSideParam}&timestamp=${tpTimestamp}`;
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
  }

  if (isSlImmediate) {
    slError = `SL zaten tetiklenmiş olabilir (mark: ${formatPriceWithPrecision(markPrice as number, pricePrecision)})`;
  } else {
    const slTimestamp = Date.now();
    const algoSl = await placeFuturesAlgoOrder(apiKey, apiSecret, symbol, closeSide, "STOP_MARKET", slPrice, positionSide);
    if (algoSl.ok) {
      slOrderId = algoSl.orderId;
    } else {
      const slQueryBase = `symbol=${symbol}&side=${closeSide}&type=STOP_MARKET&stopPrice=${slPrice}&closePosition=true&workingType=MARK_PRICE&priceProtect=true`;
      const slQuery = `${slQueryBase}${positionSideParam}&timestamp=${slTimestamp}`;
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
  }

  return { tpOrderId, slOrderId, tpError, slError };
}

async function placeFuturesAlgoOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
  stopPrice: string,
  positionSide?: "LONG" | "SHORT"
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const timestamp = Date.now();
  const positionSideParam = positionSide ? `&positionSide=${positionSide}` : "";
  const query = `algoType=CONDITIONAL&symbol=${symbol}&side=${side}&type=${type}&triggerPrice=${stopPrice}`
    + `&closePosition=true&workingType=MARK_PRICE&priceProtect=TRUE${positionSideParam}&timestamp=${timestamp}`;
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
  takeProfit: number,
  stopLoss: number,
  pricePrecision: number,
  tickSize: number
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  const tpRounded = roundToTick(takeProfit, tickSize, "UP");
  const slRounded = roundToTick(stopLoss, tickSize, "DOWN");
  const tpPrice = tpRounded.toFixed(pricePrecision);
  const slPrice = slRounded.toFixed(pricePrecision);
  const slValue = Number(slRounded);
  const offset = Math.max(slValue * 0.001, 1 / Math.pow(10, pricePrecision));
  const stopLimitValue = Math.max(0, slValue - offset);
  const stopLimitRounded = roundToTick(stopLimitValue, tickSize, "DOWN");
  const stopLimitPrice = stopLimitRounded.toFixed(pricePrecision);

  const queryString = `symbol=${symbol}&side=SELL&type=OCO&quantity=${quantity}`
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
  const position = Array.isArray(data) ? data[0] : data;
  const positionAmt = Number(position?.positionAmt || 0);
  return Math.abs(positionAmt) > 0;
}

async function hasOpenSpotOrders(apiKey: string, apiSecret: string, symbol: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://api.binance.com/api/v3/openOrders?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance spot open orders check failed:", await response.text());
    throw new Error("Spot open orders check failed");
  }

  const data = await response.json();
  return Array.isArray(data) && data.length > 0;
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

async function getFuturesOrderStatus(apiKey: string, apiSecret: string, symbol: string, orderId: string): Promise<string | null> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance futures order status failed:", await response.text());
    return null;
  }

  const data = await response.json();
  return String(data?.status || "");
}

async function cancelFuturesOrder(apiKey: string, apiSecret: string, symbol: string, orderId: string): Promise<boolean> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = await createBinanceSignature(queryString, apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": apiKey }
  });

  if (!response.ok) {
    console.error("❌ Binance futures cancel order failed:", await response.text());
    return false;
  }

  return true;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function executeAutoTrade(
  userId: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  takeProfit: number,
  stopLoss: number,
  marketType: "spot" | "futures"
): Promise<{ success: boolean; message: string; orderId?: string }> {
  try {
    const { data: userKeys, error: keysError } = await supabase
      .from("user_binance_keys")
      .select("*")
      .eq("user_id", userId)
      .eq("auto_trade_enabled", true)
      .maybeSingle();

    if (keysError || !userKeys) {
      return { success: false, message: "Auto-trade not enabled" };
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
      futures_order_type,
      futures_limit_tolerance_percent,
      futures_limit_timeout_seconds,
      futures_limit_fallback_to_market
    } = userKeys;

    if (marketType === "spot" && direction === "SHORT") {
      return { success: false, message: "Spot SHORT not supported" };
    }

    try {
      if (marketType === "futures") {
        const [hasPosition, hasOrders] = await Promise.all([
          hasOpenFuturesPosition(api_key, api_secret, symbol),
          hasOpenFuturesOrders(api_key, api_secret, symbol)
        ]);
        if (hasPosition) {
          return { success: false, message: `Açık futures pozisyonu var (${symbol}). Yeni işlem açılmadı.` };
        }
        if (hasOrders) {
          return { success: false, message: `Açık futures emri var (${symbol}). Yeni işlem açılmadı.` };
        }
      } else {
        const hasOpen = await hasOpenSpotOrders(api_key, api_secret, symbol);
        if (hasOpen) {
          return { success: false, message: `Açık spot emri var (${symbol}). Yeni işlem açılmadı.` };
        }
      }
    } catch (e) {
      return { success: false, message: "Açık pozisyon/emtir kontrolü başarısız. İşlem açılmadı." };
    }

    const leverage = marketType === "futures" ? Number(futures_leverage || 10) : 1;
    const positionSizePercent = marketType === "futures" ? Number(futures_position_size_percent || 5) : Number(spot_position_size_percent || 5);

    const balance = await getBinanceBalance(api_key, api_secret, marketType);
    if (balance <= 0) {
      return { success: false, message: "Insufficient balance" };
    }

    const tradeAmount = balance * (positionSizePercent / 100);
    const symbolInfo = await getSymbolInfo(symbol, marketType);
    if (!symbolInfo) {
      return { success: false, message: "Symbol info not found" };
    }

    const executionPrice = marketType === "futures"
      ? (await getFuturesMarkPrice(symbol)) ?? entryPrice
      : entryPrice;

    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      return { success: false, message: "Geçersiz fiyat. İşlem açılmadı." };
    }

    if (marketType === "futures") {
      if (direction === "LONG") {
        if (executionPrice >= takeProfit) {
          return { success: false, message: "TP zaten tetiklenmiş olabilir. İşlem açılmadı." };
        }
        if (executionPrice <= stopLoss) {
          return { success: false, message: "SL zaten tetiklenmiş olabilir. İşlem açılmadı." };
        }
      } else {
        if (executionPrice <= takeProfit) {
          return { success: false, message: "TP zaten tetiklenmiş olabilir. İşlem açılmadı." };
        }
        if (executionPrice >= stopLoss) {
          return { success: false, message: "SL zaten tetiklenmiş olabilir. İşlem açılmadı." };
        }
      }
    }

    let quantity = tradeAmount / executionPrice;
    if (marketType === "futures") {
      quantity = (tradeAmount * leverage) / executionPrice;
    }

    quantity = Math.floor(quantity * Math.pow(10, symbolInfo.quantityPrecision)) / Math.pow(10, symbolInfo.quantityPrecision);

    if (quantity < symbolInfo.minQty) {
      return { success: false, message: `Quantity too small: ${quantity} < ${symbolInfo.minQty}` };
    }

    let positionSide: "LONG" | "SHORT" | undefined;
    if (marketType === "futures") {
      const positionMode = await getFuturesPositionMode(api_key, api_secret);
      if (positionMode === "HEDGE") {
        positionSide = direction === "LONG" ? "LONG" : "SHORT";
      }
      const resolvedMarginType = String(futures_margin_type || "CROSS").toUpperCase() === "ISOLATED" ? "ISOLATED" : "CROSS";
      try {
        await setFuturesMarginType(api_key, api_secret, symbol, resolvedMarginType as "CROSS" | "ISOLATED");
      } catch (e) {
        console.error("❌ Margin type set failed:", e);
        return { success: false, message: "Marjin türü ayarlanamadı. İşlem açılmadı." };
      }
      await setLeverage(api_key, api_secret, symbol, leverage);
    }

    let orderType: "MARKET" | "LIMIT" = "MARKET";
    let limitPrice: number | undefined;
    let limitPriceStr: string | undefined;
    if (marketType === "futures") {
      const rawOrderType = String(futures_order_type || "market").toLowerCase();
      orderType = rawOrderType === "limit" ? "LIMIT" : "MARKET";
      if (orderType === "LIMIT") {
        const tolerance = Number(futures_limit_tolerance_percent ?? 0.3);
        const toleranceRatio = Number.isFinite(tolerance) ? Math.max(0, tolerance) / 100 : 0.003;
        const rawLimit = direction === "LONG"
          ? executionPrice * (1 + toleranceRatio)
          : executionPrice * (1 - toleranceRatio);
        const rounded = roundToTick(rawLimit, symbolInfo.tickSize, direction === "LONG" ? "UP" : "DOWN");
        limitPrice = rounded;
        limitPriceStr = formatPriceWithPrecision(rounded, symbolInfo.pricePrecision);
      }
    }

    const quantityStr = formatQuantityWithPrecision(quantity, symbolInfo.quantityPrecision);

    const orderResult = await openBinanceTrade(
      api_key,
      api_secret,
      symbol,
      direction,
      quantityStr,
      marketType,
      positionSide,
      orderType,
      limitPriceStr
    );
    if (!orderResult.success) {
      return { success: false, message: orderResult.error || "Order failed" };
    }

    let finalOrderId = orderResult.orderId;
    if (marketType === "futures" && orderType === "LIMIT") {
      const timeoutSecondsRaw = Number(futures_limit_timeout_seconds ?? 60);
      const timeoutSeconds = Number.isFinite(timeoutSecondsRaw) ? Math.min(Math.max(timeoutSecondsRaw, 10), 300) : 60;
      const fallbackToMarket = futures_limit_fallback_to_market !== false;

      await sleep(timeoutSeconds * 1000);
      const status = finalOrderId ? await getFuturesOrderStatus(api_key, api_secret, symbol, String(finalOrderId)) : null;
      if (status && status !== "FILLED") {
        if (!fallbackToMarket) {
          return { success: true, message: `⏳ Limit emir beklemede (${status}). TP/SL kurulmadı.`, orderId: finalOrderId };
        }
        if (finalOrderId) {
          await cancelFuturesOrder(api_key, api_secret, symbol, String(finalOrderId));
        }
        const marketFallback = await openBinanceTrade(
          api_key,
          api_secret,
          symbol,
          direction,
          quantityStr,
          marketType,
          positionSide,
          "MARKET"
        );
        if (!marketFallback.success) {
          return { success: false, message: marketFallback.error || "Market fallback failed" };
        }
        finalOrderId = marketFallback.orderId;
      }
    }

    if (marketType === "futures") {
      const tpSlResult = await placeTakeProfitStopLoss(api_key, api_secret, symbol, direction, takeProfit, stopLoss, symbolInfo.pricePrecision, symbolInfo.tickSize, positionSide);
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
          message: `✅ ${direction} ${quantity} ${symbol} (${leverage}x) @ $${entryPrice.toFixed(symbolInfo.pricePrecision)}\n⚠️ ${warningText.trim()}`,
          orderId: finalOrderId
        };
      }
    } else {
      const ocoResult = await placeSpotOco(api_key, api_secret, symbol, quantity, takeProfit, stopLoss, symbolInfo.pricePrecision, symbolInfo.tickSize);
      if (!ocoResult.success) {
        return { success: false, message: `Spot TP/SL OCO failed: ${ocoResult.error || "unknown"}` };
      }
    }

    const leverageText = marketType === "futures" ? ` (${leverage}x)` : "";
    return {
      success: true,
      message: `✅ ${direction} ${quantity} ${symbol}${leverageText} @ $${executionPrice.toFixed(symbolInfo.pricePrecision)}`,
      orderId: finalOrderId
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

function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }

  const recent = trueRanges.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
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

async function getKlines(symbol: string, marketType: "spot" | "futures", timeframe: string = "1h", limit: number = 100, retries: number = 3): Promise<any[] | null> {
  const cacheKey = `${symbol}:${marketType}:${timeframe}`;
  const now = Date.now();

  if (binanceBanUntil && now < binanceBanUntil) {
    const waitMs = binanceBanUntil - now;
    console.warn(`⛔ Binance ban active. Skipping klines for ${symbol} (wait ${(waitMs / 1000).toFixed(0)}s)`);
    return null;
  }
  
  // Check klines cache first
  if (klinesCache[cacheKey] && (now - klinesCache[cacheKey].timestamp) < KLINES_CACHE_TTL) {
    console.log(`💾 Klines cache hit for ${cacheKey}`);
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

interface TechnicalIndicators {
  rsi: number;
  sma20: number;
  sma50: number;
  ema12: number;
  ema26: number;
  price: number;
  lastClosedCandleCloseTime: number;
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
  volumeMA: number;
  atr: number;
}

function formatTurkeyTimeFromMs(timestampMs: number): string {
  const turkeyTime = new Date(new Date(timestampMs).toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
  const day = String(turkeyTime.getDate()).padStart(2, "0");
  const month = String(turkeyTime.getMonth() + 1).padStart(2, "0");
  const year = turkeyTime.getFullYear();
  const hours = String(turkeyTime.getHours()).padStart(2, "0");
  const minutes = String(turkeyTime.getMinutes()).padStart(2, "0");
  const seconds = String(turkeyTime.getSeconds()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

async function calculateIndicators(symbol: string, marketType: "spot" | "futures", timeframe: string = "1h"): Promise<TechnicalIndicators | null> {
  const klines = await getKlines(symbol, marketType, timeframe, 100);
  if (!klines || klines.length < 2) return null;

  // ✅ Backtest ile birebir uyum için açık (son) bar'ı dahil etme
  const closedKlines = klines.slice(0, -1);
  if (closedKlines.length < 50) return null;

  const lastClosedKline = closedKlines[closedKlines.length - 1];
  const lastClosedCandleCloseTime = Number(lastClosedKline?.[6] ?? lastClosedKline?.[0]);

  const closes = closedKlines.map((k: any) => parseFloat(k[4]));
  const volumes = closedKlines.map((k: any) => parseFloat(k[5]));
  const highs = closedKlines.map((k: any) => parseFloat(k[2]));
  const lows = closedKlines.map((k: any) => parseFloat(k[3]));
  const lastPrice = closes[closes.length - 1];

  // Calculate MACD
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12 - ema26;
  const signalLine = calculateEMA(closes.map((_, i) => {
    const c = closes.slice(0, i + 1);
    return c.length >= 26 ? calculateEMA(c, 12) - calculateEMA(c, 26) : 0;
  }), 9);
  const histogram = macdLine - signalLine;

  // Calculate OBV
  let obv = 0;
  let obvTrend = "neutral";
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) obv = volumes[i];
    else if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
  }
  if (closes[closes.length - 1] > closes[closes.length - 2]) obvTrend = "rising";
  else if (closes[closes.length - 1] < closes[closes.length - 2]) obvTrend = "falling";

  // Support/Resistance
  const highs20 = highs.slice(-20);
  const lows20 = lows.slice(-20);
  const resistance = Math.max(...highs20);
  const support = Math.min(...lows20);

  // Calculate Stochastic and ADX
  const stoch = calculateStochastic(closes, highs, lows);
  const adx = calculateADX(highs, lows, closes);
  const atr = calculateATR(highs, lows, closes, 14);
  
  // Calculate Volume Moving Average
  const volumeMA = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

  return {
    rsi: calculateRSI(closes, 14),
    sma20: calculateSMA(closes, 20),
    sma50: calculateSMA(closes, 50),
    ema12: ema12,
    ema26: ema26,
    price: lastPrice,
    lastClosedCandleCloseTime: Number.isFinite(lastClosedCandleCloseTime) ? lastClosedCandleCloseTime : Date.now(),
    closes: closes,
    volumes: volumes,
    highs: highs,
    lows: lows,
    macd: macdLine,
    histogram: histogram,
    obv: obv,
    obvTrend: obvTrend,
    resistance: resistance,
    support: support,
    stoch: stoch,
    adx: adx,
    volumeMA: volumeMA,
    atr: atr,
  };
}

// =====================
// Full Signal Generation (Back Test Aligned - 40-30-15-15 weights)
// =====================
function generateSignalScore(indicators: TechnicalIndicators, userConfidenceThreshold: number = 70): { direction: "LONG" | "SHORT"; score: number; triggered: boolean; breakdown: any } {
  const breakdown: any = {};

  const atrPercent = indicators.price > 0 ? (indicators.atr / indicators.price) : 0;
  const isTrending = indicators.adx >= 25;
  const regime = isTrending ? "trend" : "range";

  let trendWeight = 40;
  let momentumWeight = 30;
  let volumeWeight = 15;
  let srWeight = 15;

  if (regime === "trend") {
    trendWeight = 50;
    momentumWeight = 20;
    volumeWeight = 20;
    srWeight = 10;
  } else {
    trendWeight = 25;
    momentumWeight = 35;
    volumeWeight = 15;
    srWeight = 25;
  }

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
    weight: `${trendWeight}%`,
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
    weight: `${momentumWeight}%`,
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

  // Volume MA check
  if (indicators.volumeMA > 0) {
    volumeScore += 15;
    volumeDetails.volumeMAScore = 15;
  } else {
    volumeScore -= 10;
    volumeDetails.volumeMAScore = -10;
  }

  breakdown.VOLUME_ANALIZI = {
    score: volumeScore,
    weight: `${volumeWeight}%`,
    details: {
      "OBV Trend": `${indicators.obvTrend} → ${volumeDetails.obvScore > 0 ? "+" : ""}${volumeDetails.obvScore}`,
      "Volume MA": `${indicators.volumeMA > 0 ? "Positive" : "Negative"} → ${volumeDetails.volumeMAScore > 0 ? "+" : ""}${volumeDetails.volumeMAScore}`,
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
      weight: `${srWeight}%`,
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
  const normalizedTrendScore = (trendScore / 50) * trendWeight; // -50 to +50 → ±weight
  const normalizedMomentumScore = (momentumScore / 50) * momentumWeight; // -50 to +50 → ±weight
  const normalizedVolumeScore = (volumeScore / 25) * volumeWeight; // -25 to +25 → ±weight
  const normalizedSRScore = (srScore / 30) * srWeight; // -30 to +30 → ±weight

  let score = normalizedTrendScore + normalizedMomentumScore + normalizedVolumeScore + normalizedSRScore;

  // Clamp to 0-100
  const direction = score > 0 ? "LONG" : "SHORT";
  const confidence = Math.min(Math.max(Math.abs(score), 0), 100);

  let adjustedThreshold = userConfidenceThreshold;
  if (atrPercent > 0 && atrPercent < 0.001) adjustedThreshold += 20;
  else if (atrPercent > 0 && atrPercent < 0.002) adjustedThreshold += 10;
  adjustedThreshold = Math.min(95, adjustedThreshold);

  const triggered = confidence >= adjustedThreshold;

  breakdown.normalizedScore = {
    trend: normalizedTrendScore.toFixed(2),
    momentum: normalizedMomentumScore.toFixed(2),
    volume: normalizedVolumeScore.toFixed(2),
    sr: normalizedSRScore.toFixed(2),
    total: score.toFixed(2),
  };

  breakdown.regime = {
    type: regime,
    atrPercent: (atrPercent * 100).toFixed(3) + "%",
    adjustedThreshold: adjustedThreshold,
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
async function sendTelegramNotification(userId: string, message: string): Promise<void> {
  try {
    const { data: userSettings, error } = await supabase
      .from("user_settings")
      .select("telegram_chat_id, telegram_username, notifications_enabled")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ user_settings fetch error:", error);
      return;
    }
    if (userSettings?.notifications_enabled === false) {
      console.log(`⚠️ Notifications disabled for user ${userId}`);
      return;
    }

    const chatId = userSettings?.telegram_chat_id || userSettings?.telegram_username;
    if (!chatId) {
      console.log(`⚠️ No Telegram chat ID for user ${userId}`);
      return;
    }

    const botUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    const resp = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!resp.ok) {
      console.error("❌ Telegram send failed:", resp.status, await resp.text());
      return;
    }

    console.log(`✅ Telegram message sent to user ${userId}`);
  } catch (e) {
    console.error("❌ Telegram notification error:", e);
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

async function hasSignalForCandle(
  userId: string,
  symbol: string,
  timeframe: string,
  candleCloseTimeMs: number
): Promise<boolean> {
  const tfMinutes = timeframeToMinutes(timeframe);
  if (!Number.isFinite(tfMinutes) || tfMinutes <= 0) return false;
  const windowStart = new Date(candleCloseTimeMs).toISOString();
  const windowEnd = new Date(candleCloseTimeMs + tfMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("active_signals")
    .select("id")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .gte("created_at", windowStart)
    .lt("created_at", windowEnd)
    .limit(1);

  if (error) {
    console.error("❌ Candle dedupe lookup error:", error);
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

// =====================
// User alarm trigger logic (WITH SIGNAL GENERATION)
// =====================
async function checkAndTriggerUserAlarms(alarms: any[]): Promise<void> {
  console.log(`🔥 checkAndTriggerUserAlarms called with ${alarms?.length || 0} alarms`);
  
  if (!alarms || alarms.length === 0) return;

  console.log(`🔍 Fetching existing ACTIVE_TRADE alarms...`);
  // Fetch all open ACTIVE_TRADE alarms to prevent duplicate SIGNAL alarms
  const { data: activeTradeAlarms, error: activeTradeError } = await supabase
    .from("alarms")
    .select("symbol, status")
    .eq("type", "ACTIVE_TRADE")
    .eq("status", "ACTIVE");
  
  if (activeTradeError) {
    console.error(`❌ Failed to fetch ACTIVE_TRADE alarms:`, activeTradeError);
  } else {
    console.log(`✅ Found ${activeTradeAlarms?.length || 0} ACTIVE_TRADE alarms`);
  }
  
  const openTradeSymbols = new Set();
  if (activeTradeAlarms && !activeTradeError) {
    activeTradeAlarms.forEach((at: any) => {
      openTradeSymbols.add(String(at.symbol || "").toUpperCase());
    });
  }
  console.log(`📌 Open ACTIVE_TRADE symbols: ${Array.from(openTradeSymbols).join(", ") || "None"}`);

  // 🔴 ÖNEMLI: Fetch all open auto_signal sinyalleri - spam'ı engelle
    const { data: openAutoSignals, error: openAutoSignalsError } = await supabase
      .from("active_signals")
      .select("user_id, symbol, status, alarm_id")
      .eq("status", "ACTIVE")

  const openSignalKeys = new Set();
  const openSignalSymbols = new Set();
  if (openAutoSignals && !openAutoSignalsError) {
    openAutoSignals.forEach((sig: any) => {
      // user_id + symbol kombinasyonu key oluştur
      const key = `${sig.user_id}:${String(sig.alarm_id || "")}`;
      openSignalKeys.add(key);
      const symbolKey = `${sig.user_id}:${String(sig.symbol || "").toUpperCase()}`;
      openSignalSymbols.add(symbolKey);
    });
  }
  console.log(`📌 Open auto_signal count: ${openSignalKeys.size}`);

  const openPositionCache = new Map<string, boolean>();
  const userKeysCache = new Map<string, { api_key: string; api_secret: string; futures_enabled: boolean }>();

  // ⚠️ SEQUENTIAL (NOT parallel): Calculate indicators one-by-one to avoid rate limiting
  // 🔴 ÖNEMLİ: Back test'e göre hep 100 bar kullanılıyor, AMA o barların timeframe'i user'ın alarm.timeframe'i ile aynı olmalı!
  const indicatorsResults: (any)[] = [];
  const delayMs = Math.max(50, Math.min(250, Math.floor(3000 / Math.max(1, alarms.length))));
  console.log(`📊 Starting to calculate indicators for ${alarms.length} alarms...`);
  for (const alarm of alarms) {
    console.log(`  ⏳ Calculating indicators for ${alarm.symbol}...`);
    try {
      const indicators = await calculateIndicators(
        String(alarm.symbol || "").toUpperCase(),
        normalizeMarketType(alarm.market_type || alarm.marketType || "spot"),
        String(alarm.timeframe || "1h")  // ✅ BACK TEST ALİNMENT: User'ın timeframe'ini kullan
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (indicators) {
        console.log(`  ✅ Indicators calculated for ${alarm.symbol}`);
      } else {
        console.log(`  ⚠️ Indicators NULL for ${alarm.symbol}`);
      }
      indicatorsResults.push(indicators);
    } catch (e) {
      console.error(`❌ CRITICAL: Failed to calculate indicators for ${alarm.symbol}:`, e);
      indicatorsResults.push(null);
    }
  }
  console.log(`📊 Indicator calculation completed. Results: ${indicatorsResults.filter(i => i).length}/${alarms.length} calculated`);

  // Process alarms with calculated indicators
  const telegramPromises: Promise<void>[] = [];
  const candleDedupCache = new Map<string, number>();

  for (let i = 0; i < (alarms || []).length; i++) {
    try {
      const alarm = alarms[i];
      const indicators = indicatorsResults[i];
      const alarmSymbol = String(alarm?.symbol || "").toUpperCase();
      const alarmMarketType = normalizeMarketType(alarm.market_type || alarm.marketType || "spot");
      const alarmPricePrecision = alarmSymbol
        ? await getSymbolPricePrecision(alarmSymbol, alarmMarketType)
        : null;
      if (!indicators) {
        console.log(`⚠️ No indicators calculated for ${alarm.symbol}`);
        continue;
      }

      const livePrice = await getLivePrice(alarmSymbol, alarmMarketType);
      const candleCloseTimeMs = indicators.lastClosedCandleCloseTime;
      const candleTimeKey = `${alarm.user_id}:${alarmSymbol}:${String(alarm.timeframe || "1h")}`;
      const signalPrice = indicators.price;
      const priceForSignal = signalPrice;
      const priceForPriceAlarm = Number.isFinite(livePrice as number) ? (livePrice as number) : signalPrice;
      const priceForActiveTrade = Number.isFinite(livePrice as number) ? (livePrice as number) : signalPrice;

      if (alarm.created_at) {
        const createdAtMs = new Date(alarm.created_at).getTime();
        if (Number.isFinite(createdAtMs) && candleCloseTimeMs <= createdAtMs) {
          console.log(`⏭️ Skipping alarm ${alarm.id}: candle close before alarm creation.`);
          continue;
        }
      }

      if (alarmMarketType === "futures" && alarm.auto_trade_enabled === true) {
        const positionKey = `${alarm.user_id}:${alarmSymbol}`;
        if (!openPositionCache.has(positionKey)) {
          try {
            let keys = userKeysCache.get(String(alarm.user_id));
            if (!keys) {
              const { data: userKeys, error: keysError } = await supabase
                .from("user_binance_keys")
                .select("api_key, api_secret, futures_enabled")
                .eq("user_id", alarm.user_id)
                .eq("auto_trade_enabled", true)
                .maybeSingle();

              if (!keysError && userKeys) {
                keys = {
                  api_key: userKeys.api_key,
                  api_secret: userKeys.api_secret,
                  futures_enabled: userKeys.futures_enabled === true
                };
                userKeysCache.set(String(alarm.user_id), keys);
              }
            }

            if (keys && keys.futures_enabled) {
              const hasOpen = await hasOpenFuturesPosition(keys.api_key, keys.api_secret, alarmSymbol);
              openPositionCache.set(positionKey, hasOpen);
            } else {
              openPositionCache.set(positionKey, false);
            }
          } catch (e) {
            console.error(`❌ Open position check failed for ${alarmSymbol}:`, e);
            openPositionCache.set(positionKey, false);
          }
        }

        if (openPositionCache.get(positionKey)) {
          console.log(`⏹️ Skipping alarm ${alarm.id} for ${alarmSymbol}: open futures position exists.`);
          continue;
        }
      }

      let shouldTrigger = false;
      let triggerMessage = "";
      let detectedSignal = null;

      // STRATEGY 1: USER_ALARM (user-defined signals with TP/SL)
      if (alarm.type === "user_alarm") {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;
        const symbolKey = `${alarm.user_id}:${symbol}`;
        
        // 🔴 ÖNEMLİ: Aynı user'ın aynı symbol'ü için açık sinyal varsa SKIP!
        if (openSignalSymbols.has(symbolKey)) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: signal already active for this symbol (user: ${alarm.user_id})`);
        } else {
          const tpPercent = Math.abs(Number(alarm.tp_percent || 5));
          const slPercent = Math.abs(Number(alarm.sl_percent || 3));
          const entryPrice = priceForSignal;
          
          console.log(`📊 User alarm check: ${symbol}, TP=${tpPercent}%, SL=${slPercent}%`);
          
          // Check if any signal is detected
          const signal = generateSignalScore(indicators, Number(alarm.confidence_score || 70));
          if (signal.triggered) {
            shouldTrigger = true;
            const takeProfit = signal.direction === "SHORT"
              ? entryPrice * (1 - tpPercent / 100)
              : entryPrice * (1 + tpPercent / 100);
            const stopLoss = signal.direction === "SHORT"
              ? entryPrice * (1 + slPercent / 100)
              : entryPrice * (1 - slPercent / 100);
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
            const now = formatTurkeyTimeFromMs(candleCloseTimeMs);
            
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
              `⏱️ Bar Sınırı: ${alarm.bar_close_limit || 5}\n\n` +
              `⏰ Zaman: ${now}`;
            
            console.log(`✅ User alarm triggered for ${symbol}: ${signal.direction}`);
          }
        }
      }

      // STRATEGY 2: PRICE_LEVEL alarm (explicit price target)
      if (!shouldTrigger && (alarm.type === "PRICE_LEVEL" || alarm.condition)) {
        const targetPrice = Number(alarm.target_price || alarm.targetPrice);
        const condition = String(alarm.condition || "").toLowerCase();
        const symbol = String(alarm.symbol || "").toUpperCase();
        const symbolKey = `${alarm.user_id}:${symbol}`;

        if (openSignalSymbols.has(symbolKey)) {
          console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: signal already active for this symbol (user: ${alarm.user_id})`);
        }

        if (Number.isFinite(targetPrice) && !openSignalSymbols.has(symbolKey)) {
          if (condition === "above" && priceForPriceAlarm >= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `🚀 Price ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$ reached! (Current: $${formatPriceWithPrecision(priceForPriceAlarm, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: priceForPriceAlarm > targetPrice ? "LONG" : "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (condition === "below" && priceForPriceAlarm <= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `📉 Price dropped below ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$! (Current: $${formatPriceWithPrecision(priceForPriceAlarm, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: priceForPriceAlarm < targetPrice ? "SHORT" : "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          }
        }
      }

      // STRATEGY 2: TECHNICAL SIGNAL alarm (confidence-based)
      // ⏹️ Skip SIGNAL alarms if there's an open ACTIVE_TRADE OR open auto_signal for this symbol
      if (!shouldTrigger && alarm.type === "SIGNAL") {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;
        const symbolKey = `${alarm.user_id}:${symbol}`;

        if (openTradeSymbols.has(symbol)) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: ACTIVE_TRADE in progress`);
        } else if (openSignalSymbols.has(symbolKey)) {
          // 🔴 ÖNEMLI: Aynı symbol için açık auto_signal varsa skip!
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: auto_signal already active for this symbol (user: ${alarm.user_id})`);
        } else {
          const userConfidenceThreshold = Number(alarm.confidence_score || 70);
          const signal = generateSignalScore(indicators, userConfidenceThreshold);

          console.log(
            `📊 ${alarm.symbol}: ` +
            `RSI=${indicators.rsi.toFixed(1)} | ` +
            `EMA12=${indicators.ema12.toFixed(2)} vs EMA26=${indicators.ema26.toFixed(2)} | ` +
            `Price=$${formatPriceWithPrecision(priceForSignal, alarmPricePrecision)} | ` +
            `[Trend:${signal.breakdown.trend} Momentum:${signal.breakdown.momentum} Volume:${signal.breakdown.volume} SR:${signal.breakdown.sr}] ` +
            `→ ${signal.direction}(${signal.score}%)`
          );

          if (signal.triggered) {
            shouldTrigger = true;
            // Use signal's calculated confidence (market analysis), NOT alarm.confidence_score (user threshold)
            detectedSignal = {
              direction: signal.direction,
              score: signal.score,
              triggered: true,
              breakdown: signal.breakdown
            };
            triggerMessage = `🎯 <b>${signal.direction}</b> Signal detected!\n` +
              `Confidence: <b>${signal.score}%</b>\n` +
              `RSI: ${indicators.rsi.toFixed(1)} | Price: $${formatPriceWithPrecision(priceForSignal, alarmPricePrecision)}\n` +
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
          if (priceForActiveTrade >= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ LONG TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(priceForActiveTrade, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (priceForActiveTrade <= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ LONG SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(priceForActiveTrade, alarmPricePrecision)})`;
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
          if (priceForActiveTrade <= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ SHORT TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(priceForActiveTrade, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (priceForActiveTrade >= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ SHORT SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(priceForActiveTrade, alarmPricePrecision)})`;
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
        if (Number.isFinite(candleCloseTimeMs)) {
          const cached = candleDedupCache.get(candleTimeKey);
          if (cached === candleCloseTimeMs) {
            console.log(`⏹️ Skipping duplicate candle trigger for ${alarmSymbol} (${alarm.timeframe})`);
            continue;
          }
          const alreadyHasSignal = await hasSignalForCandle(
            String(alarm.user_id),
            alarmSymbol,
            String(alarm.timeframe || "1h"),
            candleCloseTimeMs
          );
          if (alreadyHasSignal) {
            console.log(`⏹️ Signal already exists for candle ${alarmSymbol} (${alarm.timeframe})`);
            candleDedupCache.set(candleTimeKey, candleCloseTimeMs);
            continue;
          }
        }

        const symbol = String(alarm.symbol || "").toUpperCase();
        const marketType = String(alarm.market_type || "spot").toLowerCase() === "futures" ? "Futures" : "Spot";
        const timeframe = String(alarm.timeframe || "1h");
        const tpPercent = Math.abs(Number(alarm.tp_percent || 5));
        const slPercent = Math.abs(Number(alarm.sl_percent || 3));
        const barClose = alarm.bar_close_limit === null ? null : Number(alarm.bar_close_limit || 5);
        const direction = detectedSignal?.direction || "LONG";
        const directionTR = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        
        const decimals = alarmPricePrecision;
        
        // Calculate TP/SL prices based on current price and percentages
        const rawTpPrice = direction === "SHORT"
          ? priceForSignal * (1 - tpPercent / 100)
          : priceForSignal * (1 + tpPercent / 100);
        const rawSlPrice = direction === "SHORT"
          ? priceForSignal * (1 + slPercent / 100)
          : priceForSignal * (1 - slPercent / 100);
        const tpPrice = rawTpPrice;
        const slPrice = rawSlPrice;

        // 🚀 AUTO TRADE EXECUTION
        let tradeResult = { success: false, message: "Otomatik işlem tetiklenmedi (auto-trade kapalı/izin yok/açık pozisyon/işlem hatası)" } as { success: boolean; message: string; orderId?: string };
        let tradeNotificationText = "";
        const autoTradeEnabled = alarm.auto_trade_enabled === true;

        if (autoTradeEnabled) {
          tradeResult = await executeAutoTrade(
            alarm.user_id,
            symbol,
            direction,
            priceForSignal,
            tpPrice,
            slPrice,
            normalizeMarketType(alarm.market_type || "spot")
          );

          if (tradeResult.success) {
            tradeNotificationText = `\n\n🤖 <b>OTOMATİK İŞLEM:</b>\n${tradeResult.message}`;
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
            const needsWidenHint = /TP zaten tetiklenmiş olabilir|SL zaten tetiklenmiş olabilir/i.test(tradeResult.message || "");
            const hintText = needsWidenHint
              ? "\n<i>Not:</i> Fiyat hızlı hareket etti. TP/SL oranını biraz genişletmeyi veya limit toleransını artırmayı deneyin."
              : "";
            tradeNotificationText = `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${tradeResult.message}${hintText}`;
          }
        }

        if (!tradeNotificationText) {
          tradeNotificationText = autoTradeEnabled
            ? `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${tradeResult.message}`
            : `\n\nℹ️ <b>Otomatik işlem:</b> Kapalı`;
        }
        
        // Format date as DD.MM.YYYY HH:MM:SS in GMT+3 (Turkey timezone)
        const formattedDateTime = formatTurkeyTimeFromMs(candleCloseTimeMs);

        // Get signal analysis score for market strength
        const userConfidenceThreshold = Number(alarm.confidence_score || 70);
        const signalAnalysis = generateSignalScore(indicators, userConfidenceThreshold);

        let telegramMessage = `
🔔 <b>ALARM AKTİVE!</b> 🔔

💰 Çift: <b>${symbol}</b>
🎯 ${directionTR} Sinyali Tespit Edildi!

📊 Piyasa: <b>${marketType}</b> | Zaman: <b>${timeframe}</b>
💹 Fiyat: <b>$${formatPriceWithPrecision(priceForSignal, decimals)}</b>

📈 Sinyal: Güven: <b>${userConfidenceThreshold}%</b>
📊 Gelen Sinyalin Güveni: <b>${signalAnalysis.score}%</b>

🎯 Hedefler:
  TP: <b>$${formatPriceWithPrecision(tpPrice, decimals)}</b> (<b>+${tpPercent}%</b>)
  SL: <b>$${formatPriceWithPrecision(slPrice, decimals)}</b> (<b>-${slPercent}%</b>)

${barClose === null ? "" : `⏱️ Bar Sınırı: <b>${barClose}</b>\n`}

⏰ Zaman: <b>${formattedDateTime}</b>
${tradeNotificationText}

<i>Not:</i> Otomatik al-sat işlemleri market fiyatından anlık alındığı için, sinyalin giriş fiyatına göre farklılık gösterebilir.
`;

        // 🚀 INSERT active signal INTO DATABASE
        let signalInserted = false;
        try {
          const { data: alarmCheck, error: alarmCheckError } = await supabase
            .from("alarms")
            .select("id, is_active, status")
            .eq("id", alarm.id)
            .eq("user_id", alarm.user_id)
            .eq("type", "user_alarm")
            .maybeSingle();

          const alarmStatus = String(alarmCheck?.status || "").toUpperCase();
          const alarmStillActive = !!alarmCheck && alarmCheck.is_active !== false && (!alarmStatus || alarmStatus === "ACTIVE");

          if (alarmCheckError || !alarmStillActive) {
            console.warn(`⚠️ Alarm artık aktif değil veya yok (id=${alarm.id}). Sinyal kaydı atlandı.`);
            continue;
          }

          const marketTypeNorm = normalizeMarketType(alarm.market_type || "spot");
          const signalCreatedAt = Number.isFinite(candleCloseTimeMs)
            ? new Date(candleCloseTimeMs).toISOString()
            : new Date().toISOString();
          const newActiveSignal = {
            user_id: alarm.user_id,
            alarm_id: alarm.id,
            symbol: symbol,
            market_type: marketTypeNorm,
            timeframe: String(alarm.timeframe || "1h"),
            direction,
            entry_price: priceForSignal,
            take_profit: tpPrice,
            stop_loss: slPrice,
            tp_percent: tpPercent,
            sl_percent: slPercent,
            bar_close_limit: barClose,
            status: "ACTIVE",
            score: detectedSignal?.score || 50,
            created_at: signalCreatedAt,
            signal_timestamp: signalCreatedAt
          };

          const { error: insertError } = await supabase.from("active_signals").insert(newActiveSignal);
          if (insertError) {
            console.error(`❌ Failed to insert signal for ${symbol}:`, insertError);
            signalInserted = false;
          } else {
            console.log(`✅ Signal created in active_signals for ${symbol}`);
            signalInserted = true;
          }
        } catch (e) {
          console.error(`❌ Error creating signal for ${symbol}:`, e);
          signalInserted = false;
        }

        if (!signalInserted) {
          console.warn(`⚠️ active_signals insert failed for ${symbol}`);
          telegramMessage += `\n\n⚠️ <b>Not:</b> Sinyal kaydı oluşturulamadı. Sistem yöneticisine bildirin.`;
        }

        telegramPromises.push(sendTelegramNotification(alarm.user_id, telegramMessage));
        if (Number.isFinite(candleCloseTimeMs)) {
          candleDedupCache.set(candleTimeKey, candleCloseTimeMs);
        }
        console.log(`✅ User alarm triggered for ${symbol}: ${triggerMessage}`);
      }
    } catch (e) {
      console.error(`❌ Error checking user alarm ${alarms[i]?.id}:`, e);
    }
  }

  // 🚀 PARALLELIZED: Send all Telegram messages in parallel
  await Promise.all(telegramPromises);
}
type ClosedSignal = {
  id: string | number;
  symbol: string;
  direction: "LONG" | "SHORT";
  close_reason: "TP_HIT" | "SL_HIT" | "BAR_CLOSE";
  price: number;
  user_id: string;
  profitLoss?: number;
  market_type?: string;
};

async function checkAndCloseSignals(): Promise<ClosedSignal[]> {
  try {
    const { data: rawSignals, error: signalsError } = await supabase
      .from("active_signals")
      .select("*")
      .eq("status", "ACTIVE");

    if (signalsError) {
      console.error("❌ Error fetching signals:", signalsError);
      return [];
    }

    const signals = rawSignals || [];
    if (!signals || signals.length === 0) return [];

    const alarmIdList = Array.from(new Set(
      signals
        .map(signal => signal.alarm_id)
        .filter(id => id !== null && id !== undefined)
        .map(id => Number(id))
        .filter(id => Number.isFinite(id))
    ));
    const alarmBarMap = new Map<string, number | null>();
    if (alarmIdList.length > 0) {
      const { data: alarmRows, error: alarmError } = await supabase
        .from("alarms")
        .select("id, bar_close_limit")
        .in("id", alarmIdList);

      if (alarmError) {
        console.warn("⚠️ Alarm bar_close_limit fetch failed:", alarmError);
      } else {
        (alarmRows || []).forEach(row => {
          const rawBar = row?.bar_close_limit;
          const barValue = (rawBar === null || rawBar === undefined) ? null : Number(rawBar);
          alarmBarMap.set(String(row.id), Number.isFinite(barValue) ? barValue : null);
        });
      }
    }

    // 🚀 PARALLELIZED: Fetch all prices in parallel
    const pricePromises = signals.map(signal => {
      const marketType = normalizeMarketType(signal.market_type || signal.marketType || signal.market);
      const symbol = String(signal.symbol || "");
      if (marketType === "futures") {
        return getFuturesMarkPrice(symbol).then(p => (p === null ? getCurrentPrice(symbol, marketType) : p));
      }
      return getCurrentPrice(symbol, marketType);
    });
    const prices = await Promise.all(pricePromises);

    const closedSignals: ClosedSignal[] = [];

    for (let idx = 0; idx < signals.length; idx++) {
      try {
        const signal = signals[idx];
        const rawPrice = prices[idx];
        
        if (rawPrice === null) continue;

        const symbol = String(signal.symbol || "");
        const direction = (signal.condition || signal.direction) as "LONG" | "SHORT";
        
        if (direction !== "LONG" && direction !== "SHORT") {
          console.error(`❌ Invalid direction for signal ${signal.id}`);
          continue;
        }

        const currentPrice = rawPrice;

        const tp = Number(signal.take_profit);
        const sl = Number(signal.stop_loss);

        if (!Number.isFinite(tp) || !Number.isFinite(sl)) {
          console.error(`❌ Invalid TP/SL for signal ${signal.id}`);
          continue;
        }

        const takeProfit = tp;
        const stopLoss = sl;

        let shouldClose = false;
        let closeReason: "TP_HIT" | "SL_HIT" | "BAR_CLOSE" | "" = "";
        let closePrice = currentPrice;

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

        if (!shouldClose) {
          let candleHigh: number | null = null;
          let candleLow: number | null = null;
          try {
            const recentKlines = await getKlines(symbol, normalizeMarketType(signal.market_type || signal.marketType || signal.market), "1m", 2, 1);
            if (recentKlines && recentKlines.length >= 2) {
              const lastClosed = recentKlines[recentKlines.length - 2];
              const high = Number(lastClosed?.[2]);
              const low = Number(lastClosed?.[3]);
              candleHigh = Number.isFinite(high) ? high : null;
              candleLow = Number.isFinite(low) ? low : null;
            }
          } catch (e) {
            console.warn(`⚠️ 1m kline read failed for ${symbol}:`, e);
          }

          if (direction === "LONG") {
            const hitSl = candleLow !== null && candleLow <= stopLoss;
            const hitTp = candleHigh !== null && candleHigh >= takeProfit;
            if (hitSl) {
              shouldClose = true;
              closeReason = "SL_HIT";
              closePrice = stopLoss;
            } else if (hitTp) {
              shouldClose = true;
              closeReason = "TP_HIT";
              closePrice = takeProfit;
            }
          } else if (direction === "SHORT") {
            const hitSl = candleHigh !== null && candleHigh >= stopLoss;
            const hitTp = candleLow !== null && candleLow <= takeProfit;
            if (hitSl) {
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

        if (!shouldClose) {
          const rawBarCloseLimit = signal.bar_close_limit;
          let barCloseLimit = (rawBarCloseLimit === null || rawBarCloseLimit === undefined)
            ? NaN
            : Number(rawBarCloseLimit);
          if (!Number.isFinite(barCloseLimit) || barCloseLimit <= 0) {
            const fallbackBar = alarmBarMap.get(String(signal.alarm_id));
            barCloseLimit = (fallbackBar === null || fallbackBar === undefined) ? NaN : Number(fallbackBar);
          }
          const createdAt = signal.created_at ? new Date(signal.created_at) : null;
          const timeframeMinutes = timeframeToMinutes(String(signal.timeframe || "1h"));
          if (
            Number.isFinite(barCloseLimit) &&
            barCloseLimit > 0 &&
            createdAt &&
            Number.isFinite(timeframeMinutes) &&
            timeframeMinutes > 0
          ) {
            const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;
            const barsElapsed = Math.floor(elapsedMinutes / timeframeMinutes);
            if (barsElapsed >= barCloseLimit) {
              shouldClose = true;
              closeReason = "BAR_CLOSE";
            }
          }
        }

        if (!shouldClose || !closeReason) continue;

        // Calculate profit/loss (store for UI + notifications)
        const profitLoss = direction === "LONG"
          ? ((closePrice - Number(signal.entry_price)) / Number(signal.entry_price)) * 100
          : ((Number(signal.entry_price) - closePrice) / Number(signal.entry_price)) * 100;

        const updateResult = await supabase
          .from("active_signals")
          .update({
            status: "CLOSED",
            close_reason: closeReason,
            closed_at: new Date().toISOString(),
            profit_loss: profitLoss
          })
          .eq("id", signal.id)
          .eq("status", "ACTIVE");

        if (updateResult.error) {
          console.error(`❌ updateError for signal ${signal.id}:`, updateResult.error);
          continue;
        }

        console.log(`✅ Signal ${signal.id} (${signal.symbol}) CLOSED: ${closeReason} | P&L: ${profitLoss.toFixed(2)}%`);

        closedSignals.push({
          id: signal.id,
          symbol,
          direction,
          close_reason: closeReason,
          price: closePrice,
          user_id: signal.user_id,
          market_type: signal.market_type || signal.marketType || signal.market,
          profitLoss: direction === "LONG"
            ? ((closePrice - Number(signal.entry_price)) / Number(signal.entry_price)) * 100
            : ((Number(signal.entry_price) - closePrice) / Number(signal.entry_price)) * 100,
        });
      } catch (e) {
        console.error(`❌ Error checking signal ${signals[idx]?.id}:`, e);
      }
    }

    return closedSignals;
  } catch (e) {
    console.error("❌ Error in checkAndCloseSignals:", e);
    return [];
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
  bar_close_limit: number;
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

  const barCloseLimitRaw = Number(body.bar_close_limit ?? body.barCloseLimit ?? 30);
  const barCloseLimit = Number.isFinite(barCloseLimitRaw) ? barCloseLimitRaw : 30;

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
    bar_close_limit: barCloseLimit,
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
    .eq("entry_price", newSignal.entry_price)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (error) {
    console.error("❌ duplicate check error:", error);
  }

  if (existing?.id) {
    console.log(`⚠️ Duplicate signal attempt: ${newSignal.symbol} ${newSignal.signal_direction}`);
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
    bar_close_limit: newSignal.bar_close_limit,
    status: "ACTIVE",
    created_at: newSignal.created_at
  };

  const { error: insertError } = await supabase.from("active_signals").insert(activeSignalData);

  if (insertError) {
    console.error("❌ insertError:", insertError);
    throw new Error("Failed to insert new signal");
  }

  return { inserted: true, duplicate: false };
}

// =====================
// Handler
// =====================
serve(async (req: any) => {
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // ✅ Auth guard (optional - currently disabled for cron compatibility)
  // if (cronSecret) {
  //   const auth = req.headers.get("authorization") || "";
  //   const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  //   if (token !== cronSecret) {
  //     return new Response(JSON.stringify({ error: "Unauthorized" }), {
  //       status: 401,
  //       headers: { ...corsHeaders, "Content-Type": "application/json" },
  //     });
  //   }
  // }

  const lockName = "check-alarm-signals";
  const lock = await acquireCronLock(lockName, 55);
  if (!lock.acquired) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "duplicate-run" }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    console.log("📥 [DEBUG] Request body:", JSON.stringify(body, null, 2));
    console.log("📥 [DEBUG] body?.user_id:", body?.user_id);
    console.log("📥 [DEBUG] typeof body?.user_id:", typeof body?.user_id);
    console.log("📥 [DEBUG] Boolean(body?.user_id):", Boolean(body?.user_id));

    // Try to get user_id from auth header if not in body
    if (!body?.user_id) {
      const authHeader = req.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          body.user_id = payload.sub;
          console.log("📥 [DEBUG] Extracted user_id from JWT:", body.user_id);
        } catch (e) {
          console.log("📥 [DEBUG] Could not decode JWT token");
        }
      }
    }

    // ✅ Test notification request
    if (body?.action === "test_notification") {
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

      alarms = result.data?.filter((alarm: any) => {
        const status = String(alarm.status || "").toUpperCase();
        return status === "ACTIVE" || status === "" || !alarm.status;
      });
      alarmsError = result.error;
    } else {
      // Cron mode: get all active alarms
      console.log("🔄 [CRON] Getting all active alarms for monitoring");
      
      const result = await supabase
        .from("alarms")
        .select("*")
        .eq("type", "user_alarm")
        .eq("is_active", true);

      console.log(`📥 [DEBUG] Raw query result: ${result.data?.length || 0} alarms returned`);
      if (result.data?.length) {
        result.data.forEach((a: any, idx: number) => {
          console.log(`  [${idx}] id=${a.id}, symbol=${a.symbol}, status='${a.status}', is_active=${a.is_active}`);
        });
      }
      if (result.error) {
        console.error(`📥 [DEBUG] Query error:`, result.error);
      }

      alarms = result.data?.filter((alarm: any) => {
        const status = String(alarm.status || "").toUpperCase();
        const matches = status === "ACTIVE" || status === "" || !alarm.status;
        console.log(`  📥 [DEBUG] Filter check - id=${alarm.id}, status='${alarm.status}', uppercase='${status}', matches=${matches}`);
        return matches;
      });
      alarmsError = result.error;
      console.log(`📥 [DEBUG] After filter: ${alarms?.length || 0} alarms match criteria`);
    }

    if (alarmsError) {
      console.error("❌ Error fetching alarms:", alarmsError);
      // Don't fail the request, just log the error
    }

    console.log(`📊 Found ${alarms?.length || 0} active alarms${body?.user_id ? ' for user' : ' (cron mode)'}`);

    // ✅ Check and trigger user alarms
    if (alarms && alarms.length > 0) {
      await checkAndTriggerUserAlarms(alarms);
    }

    // ✅ Close signals that hit TP/SL
    const closedSignals = await checkAndCloseSignals();

    // ✅ Notify - 🚀 PARALLELIZED
    const notificationPromises = closedSignals.map(async signal => {
      let statusMessage = "⛔ KAPANDI - STOP LOSS HIT!";
      let emoji = "⚠️";
      if (signal.close_reason === "TP_HIT") {
        statusMessage = "✅ KAPANDI - TP HIT!";
        emoji = "🎉";
      } else if (signal.close_reason === "BAR_CLOSE") {
        statusMessage = "⏱️ KAPANDI - BAR SINIRI";
        emoji = "⏱️";
      }

      const precision = await getSymbolPricePrecision(
        String(signal.symbol || "").toUpperCase(),
        normalizeMarketType(signal.market_type || "spot")
      );

      const telegramMessage = `
🔔 <b>İŞLEM KAPANDI</b> 🔔

📊 Coin: <b>${signal.symbol}</b>
📈 İşlem Yönü: <b>${signal.direction}</b>
${emoji} ${statusMessage}
💰 Kapanış Fiyatı: <b>$${formatPriceWithPrecision(signal.price, precision)}</b>
    📈 Kar/Zarar: <b>${signal.profitLoss !== undefined ? (signal.profitLoss >= 0 ? '+' : '') + signal.profitLoss.toFixed(2) + '%' : 'N/A'}</b>
`;

      return sendTelegramNotification(signal.user_id, telegramMessage);
    });
    
    await Promise.all(notificationPromises);

    await releaseCronLock(lockName, lock.requestId, "DONE");
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
    await releaseCronLock(lockName, lock.requestId, "ERROR");
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
