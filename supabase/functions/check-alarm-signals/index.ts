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
    const tickDecimals = tickSize ? getTickSizeDecimals(String(tickSize)) : null;
    const pricePrecision = typeof item.pricePrecision === "number" ? item.pricePrecision : null;
    const resolvedPrecisionCandidates = [pricePrecision, tickDecimals].filter((value) => Number.isFinite(value)) as number[];
    const resolvedPrecision = resolvedPrecisionCandidates.length
      ? Math.max(...resolvedPrecisionCandidates)
      : null;
    acc[String(item.symbol)] = { pricePrecision: resolvedPrecision };
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

async function getSymbolInfo(symbol: string, marketType: "spot" | "futures"): Promise<{ quantityPrecision: number; minQty: number; pricePrecision: number } | null> {
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

  return { quantityPrecision, minQty, pricePrecision };
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function placeFuturesMarketOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
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

  return { success: true, orderId: String(data.orderId) };
}

async function placeFuturesLimitOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  price: string
): Promise<{ success: boolean; orderId?: string; error?: string }> {
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

  return { success: true, orderId: String(data.orderId) };
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
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const timestamp = Date.now();
  const side = direction === "LONG" ? "BUY" : "SELL";

  if (marketType === "futures") {
    const orderType = normalizeFuturesEntryType(options.orderType);
    if (orderType === "LIMIT" && options.limitPrice) {
      const limitOrder = await placeFuturesLimitOrder(apiKey, apiSecret, symbol, side, quantity, options.limitPrice);
      if (!limitOrder.success || !limitOrder.orderId) {
        return { success: false, error: limitOrder.error || "Limit order failed" };
      }

      const timeoutSeconds = normalizeLimitTimeoutSeconds(options.limitTimeoutSeconds);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let executedQty = 0;

      while (Date.now() < deadline) {
        const details = await getFuturesOrderDetails(apiKey, apiSecret, symbol, limitOrder.orderId);
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

      await cancelFuturesOrder(apiKey, apiSecret, symbol, limitOrder.orderId);

      const precision = Number.isFinite(options.quantityPrecision) ? Number(options.quantityPrecision) : 0;
      const minQty = Number.isFinite(options.minQty) ? Number(options.minQty) : 0;
      const remainingRaw = quantity - executedQty;
      const remaining = precision > 0 ? roundQuantity(remainingRaw, precision) : remainingRaw;

      if (remaining > minQty) {
        const marketResult = await placeFuturesMarketOrder(apiKey, apiSecret, symbol, side, remaining);
        if (!marketResult.success) {
          return { success: false, error: marketResult.error || "Order failed" };
        }
        return { success: true, orderId: marketResult.orderId };
      }

      return { success: true, orderId: limitOrder.orderId };
    }

    return placeFuturesMarketOrder(apiKey, apiSecret, symbol, side, quantity);
  }

  const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
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
  quantity: number,
  quantityPrecision: number
): Promise<{ tpOrderId?: string; slOrderId?: string; tpError?: string; slError?: string }> {
  const closeSide = direction === "LONG" ? "SELL" : "BUY";

  let tpValue = Number(takeProfit);
  let slValue = Number(stopLoss);
  const tickSize = 1 / Math.pow(10, pricePrecision);
  const currentPrice = await getCurrentPrice(symbol, "futures");
  if (Number.isFinite(currentPrice)) {
    const minOffset = Math.max(currentPrice * 0.001, tickSize * 2);
    if (direction === "LONG") {
      if (tpValue <= currentPrice + minOffset) tpValue = currentPrice + minOffset;
      if (slValue >= currentPrice - minOffset) slValue = Math.max(currentPrice - minOffset, tickSize);
    } else {
      if (tpValue >= currentPrice - minOffset) tpValue = Math.max(currentPrice - minOffset, tickSize);
      if (slValue <= currentPrice + minOffset) slValue = currentPrice + minOffset;
    }
  }

  const tpPrice = tpValue.toFixed(pricePrecision);
  const slPrice = slValue.toFixed(pricePrecision);

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
  pricePrecision: number
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  let tpValue = Number(takeProfit);
  let slValue = Number(stopLoss);
  const tickSize = 1 / Math.pow(10, pricePrecision);
  const currentPrice = await getCurrentPrice(symbol, "spot");
  if (Number.isFinite(currentPrice)) {
    const minOffset = Math.max(currentPrice * 0.001, tickSize * 2);
    if (tpValue <= currentPrice + minOffset) tpValue = currentPrice + minOffset;
    if (slValue >= currentPrice - minOffset) slValue = Math.max(currentPrice - minOffset, tickSize);
  }

  const tpPrice = tpValue.toFixed(pricePrecision);
  const slPrice = slValue.toFixed(pricePrecision);
  const offset = Math.max(slValue * 0.001, 1 / Math.pow(10, pricePrecision));
  const stopLimitValue = Math.max(0, slValue - offset);
  const stopLimitPrice = stopLimitValue.toFixed(pricePrecision);

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

async function executeAutoTrade(
  userId: string,
  symbol: string,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  takeProfit: number,
  stopLoss: number,
  marketType: "spot" | "futures"
): Promise<{ success: boolean; message: string; orderId?: string; blockedByOpenPosition?: boolean }> {
  try {
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
        const hasOpen = await hasOpenSpotOrders(api_key, api_secret, symbol);
        if (hasOpen) {
          return { success: false, message: `Açık spot emri var (${symbol}). Yeni işlem açılmadı.`, blockedByOpenPosition: true };
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

    quantity = Math.floor(quantity * Math.pow(10, symbolInfo.quantityPrecision)) / Math.pow(10, symbolInfo.quantityPrecision);

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
        limitPrice = limitPriceValue.toFixed(symbolInfo.pricePrecision);
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
          minQty: symbolInfo.minQty
        }
      : {};
    const orderResult = await openBinanceTrade(api_key, api_secret, symbol, direction, quantity, marketType, orderOptions);
    if (!orderResult.success) {
      return { success: false, message: orderResult.error || "Order failed" };
    }

    if (marketType === "futures") {
      const tpSlResult = await placeTakeProfitStopLoss(
        api_key,
        api_secret,
        symbol,
        direction,
        takeProfit,
        stopLoss,
        symbolInfo.pricePrecision,
        quantity,
        symbolInfo.quantityPrecision
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
          message: `✅ ${direction} ${quantity} ${symbol} (${leverage}x) @ $${entryPrice.toFixed(symbolInfo.pricePrecision)}\n⚠️ ${warningText.trim()}`,
          orderId: orderResult.orderId
        };
      }
    } else {
      const ocoResult = await placeSpotOco(api_key, api_secret, symbol, quantity, takeProfit, stopLoss, symbolInfo.pricePrecision);
      if (!ocoResult.success) {
        return { success: false, message: `Spot TP/SL OCO failed: ${ocoResult.error || "unknown"}` };
      }
    }

    const leverageText = marketType === "futures" ? ` (${leverage}x)` : "";
    return {
      success: true,
      message: `✅ ${direction} ${quantity} ${symbol}${leverageText} @ $${entryPrice.toFixed(symbolInfo.pricePrecision)}`,
      orderId: orderResult.orderId
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
}

async function calculateIndicators(symbol: string, marketType: "spot" | "futures", timeframe: string = "1h"): Promise<TechnicalIndicators | null> {
  const klines = await getKlines(symbol, marketType, timeframe, 101);
  if (!klines || klines.length < 2) return null;

  // ✅ Backtest ile birebir uyum için açık (son) bar'ı dahil etme
  const closedKlines = klines.slice(0, -1);
  if (closedKlines.length < 100) return null;

  const closes = closedKlines.map((k: any) => parseFloat(k[4]));
  const volumes = closedKlines.map((k: any) => parseFloat(k[5]));
  const highs = closedKlines.map((k: any) => parseFloat(k[2]));
  const lows = closedKlines.map((k: any) => parseFloat(k[3]));
  const lastClosedKline = closedKlines[closedKlines.length - 1];
  const lastClosedTimestamp = Number(lastClosedKline?.[6] ?? lastClosedKline?.[0] ?? Date.now());
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
  const atr = calculateAlarmATR(highs, lows, closes);
  
  // Calculate Volume Moving Average
  const volumeMA = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

  return {
    rsi: calculateRSI(closes, 14),
    sma20: calculateSMA(closes, 20),
    sma50: calculateSMA(closes, 50),
    ema12: ema12,
    ema26: ema26,
    price: lastPrice,
    lastClosedTimestamp: lastClosedTimestamp,
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
    atr,
    volumeMA: volumeMA,
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
async function checkAndTriggerUserAlarms(alarms: any[]): Promise<void> {
  console.log(`🔥 checkAndTriggerUserAlarms called with ${alarms?.length || 0} alarms`);
  
  if (!alarms || alarms.length === 0) return;

  console.log(`🔍 Fetching existing ACTIVE_TRADE alarms...`);
  // Fetch all open ACTIVE_TRADE alarms to prevent duplicate SIGNAL alarms
  const { data: activeTradeAlarms, error: activeTradeError } = await supabase
    .from("alarms")
    .select("user_id, symbol, status")
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
      .eq("status", "ACTIVE")

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

  const telegramPromises: Promise<void>[] = [];
  const BATCH_SIZE = 10;
  const batches: any[][] = [];

  for (let i = 0; i < alarms.length; i += BATCH_SIZE) {
    batches.push(alarms.slice(i, i + BATCH_SIZE));
  }

  const processAlarm = async (alarm: any): Promise<void> => {
    try {
      if (!validateAlarm(alarm)) {
        return;
      }

      const alarmSymbol = String(alarm?.symbol || "").toUpperCase();
      const alarmMarketType = normalizeMarketType(alarm.market_type || alarm.marketType || "spot");
      const alarmPricePrecision = alarmSymbol
        ? await getSymbolPricePrecision(alarmSymbol, alarmMarketType)
        : null;

      const indicators = await calculateIndicators(
        alarmSymbol,
        alarmMarketType,
        String(alarm.timeframe || "1h")
      );

      if (!indicators) {
        console.log(`⚠️ No indicators calculated for ${alarm.symbol}`);
        return;
      }

      const alarmIndicators = calculateAlarmIndicators(
        indicators.closes,
        indicators.highs,
        indicators.lows,
        indicators.volumes,
        indicators.lastClosedTimestamp
      );

      if (!alarmIndicators) {
        console.log(`⚠️ Alarm indicators unavailable for ${alarm.symbol}`);
        return;
      }

      let shouldTrigger = false;
      let triggerMessage = "";
      let detectedSignal = null;
      const lastClosedMs = Number(indicators.lastClosedTimestamp || 0);
      const lastClosedIso = lastClosedMs ? new Date(lastClosedMs).toISOString() : new Date().toISOString();
      const nowMs = Date.now();
      const timeframeMinutes = timeframeToMinutes(String(alarm.timeframe || "1h"));
      const timeframeMs = timeframeMinutes * 60 * 1000;
      const maxDelayMs = Math.min(2 * 60 * 1000, Math.max(60000, Math.floor(timeframeMs * 0.3)));
      const isWithinCloseWindow = nowMs >= lastClosedMs && (nowMs - lastClosedMs) <= maxDelayMs;
      const lastSignalTs = alarm.signal_timestamp || alarm.signalTimestamp;
      const lastSignalMs = lastSignalTs ? Date.parse(String(lastSignalTs)) : NaN;

      // STRATEGY 1: USER_ALARM (user-defined signals with TP/SL)
      if (alarm.type === "user_alarm") {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const signalKey = `${alarm.user_id}:${String(alarm.id || "")}`;
        const symbolKey = `${alarm.user_id}:${symbol}`;
        const autoTradeEnabled = alarm.auto_trade_enabled === true;

        if (autoTradeEnabled && openTradeSymbols.has(symbolKey)) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: ACTIVE_TRADE in progress (user: ${alarm.user_id})`);
        } else if (!isWithinCloseWindow) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: outside close window (${Math.round((nowMs - lastClosedMs) / 1000)}s)`);
        } else if (Number.isFinite(lastSignalMs) && lastSignalMs >= lastClosedMs) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: same bar already processed (alarm ${alarm.id})`);
        } else if (openSignalKeys.has(signalKey)) {
          console.log(`⏹️ Skipping user_alarm for ${symbol}: signal already active for this alarm (user: ${alarm.user_id})`);
        } else {
          const tpPercent = Number(alarm.tp_percent || 5);
          const slPercent = Number(alarm.sl_percent || 3);
          const entryPrice = Number(indicators.closes?.[indicators.closes.length - 1] ?? indicators.price);
          
          console.log(`📊 User alarm check: ${symbol}, TP=${tpPercent}%, SL=${slPercent}%`);
          
          // Check if any signal is detected
          const signal = generateSignalScoreAligned(alarmIndicators, Number(alarm.confidence_score || 70));
          const directionFilter = String(alarm.direction_filter || "BOTH").toUpperCase();
          if (directionFilter !== "BOTH" && directionFilter !== signal.direction) {
            console.log(`⏹️ Skipping user_alarm for ${symbol}: direction_filter=${directionFilter}, signal=${signal.direction}`);
            continue;
          }
          if (signal.triggered) {
            const directionKey = `${alarm.user_id}:${symbol}:${signal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping user_alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              return;
            }
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
            const formattedDateTime = formatTurkeyDateTime(indicators.lastClosedTimestamp);
            
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
        }

        if (Number.isFinite(targetPrice) && !openSignalKeys.has(signalKey)) {
          if (condition === "above" && indicators.price >= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `🚀 Price ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$ reached! (Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: indicators.price > targetPrice ? "LONG" : "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
            const directionKey = `${alarm.user_id}:${symbol}:${detectedSignal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              shouldTrigger = false;
              detectedSignal = null;
            }
          } else if (condition === "below" && indicators.price <= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `📉 Price dropped below ${formatPriceWithPrecision(targetPrice, alarmPricePrecision)}$! (Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for PRICE_LEVEL
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: indicators.price < targetPrice ? "SHORT" : "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
            const directionKey = `${alarm.user_id}:${symbol}:${detectedSignal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping PRICE_LEVEL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
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
        } else if (!isWithinCloseWindow) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: outside close window (${Math.round((nowMs - lastClosedMs) / 1000)}s)`);
        } else if (Number.isFinite(lastSignalMs) && lastSignalMs >= lastClosedMs) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: same bar already processed (alarm ${alarm.id})`);
        } else if (openSignalKeys.has(signalKey)) {
          console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: signal already active for this alarm (user: ${alarm.user_id})`);
        } else {
          const userConfidenceThreshold = Number(alarm.confidence_score || 70);
          const signal = generateSignalScoreAligned(alarmIndicators, userConfidenceThreshold);
          const directionFilter = String(alarm.direction_filter || "BOTH").toUpperCase();
          if (directionFilter !== "BOTH" && directionFilter !== signal.direction) {
            console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: direction_filter=${directionFilter}, signal=${signal.direction}`);
            continue;
          }

          console.log(
            `📊 ${alarm.symbol}: ` +
            `RSI=${indicators.rsi.toFixed(1)} | ` +
            `EMA12=${indicators.ema12.toFixed(2)} vs EMA26=${indicators.ema26.toFixed(2)} | ` +
            `Price=$${formatPriceWithPrecision(indicators.price, alarmPricePrecision)} | ` +
            `[Trend:${signal.breakdown.trend} Momentum:${signal.breakdown.momentum} Volume:${signal.breakdown.volume} SR:${signal.breakdown.sr}] ` +
            `→ ${signal.direction}(${signal.score}%)`
          );

          if (signal.triggered) {
            const directionKey = `${alarm.user_id}:${symbol}:${signal.direction}`;
            if (openSignalDirections.has(directionKey)) {
              console.log(`⏹️ Skipping SIGNAL alarm for ${symbol}: same direction already active (user: ${alarm.user_id})`);
              return;
            }
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
              `RSI: ${indicators.rsi.toFixed(1)} | Price: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)}\n` +
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
          if (indicators.price >= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ LONG TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "LONG",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (indicators.price <= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ LONG SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
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
          if (indicators.price <= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ SHORT TP Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, TP: $${formatPriceWithPrecision(takeProfit, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
            // Use alarm's confidence score directly for ACTIVE_TRADE
            const confidenceScore = Number(alarm.confidence_score || 50);
            detectedSignal = {
              direction: "SHORT",
              score: confidenceScore,
              triggered: true,
              breakdown: { trend: 0, momentum: 0, volume: 0, sr: 0 }
            };
          } else if (indicators.price >= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ SHORT SL Hit! (Entry: $${formatPriceWithPrecision(entryPrice, alarmPricePrecision)}, SL: $${formatPriceWithPrecision(stopLoss, alarmPricePrecision)}, Current: $${formatPriceWithPrecision(indicators.price, alarmPricePrecision)})`;
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
        const sendNowMs = Date.now();
        if (sendNowMs < lastClosedMs || (sendNowMs - lastClosedMs) > maxDelayMs) {
          console.log(`⏹️ Skipping signal send for ${alarm.symbol}: outside close window (${Math.round((sendNowMs - lastClosedMs) / 1000)}s)`);
          return;
        }
        try {
          await supabase
            .from("alarms")
            .update({ signal_timestamp: lastClosedIso })
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

        const entryPrice = Number(indicators.closes?.[indicators.closes.length - 1] ?? indicators.price);
        
        const decimals = alarmPricePrecision;
        
        // Calculate TP/SL prices based on current price and percentages
        const rawTpPrice = direction === "SHORT"
          ? entryPrice * (1 - tpPercent / 100)
          : entryPrice * (1 + tpPercent / 100);
        const rawSlPrice = direction === "SHORT"
          ? entryPrice * (1 + slPercent / 100)
          : entryPrice * (1 - slPercent / 100);
        const tpPrice = rawTpPrice;
        const slPrice = rawSlPrice;

        // 🚀 AUTO TRADE EXECUTION
        let tradeResult = { success: false, message: "Auto-trade not triggered" } as { success: boolean; message: string; orderId?: string; blockedByOpenPosition?: boolean };
        let tradeNotificationText = "";
        const autoTradeEnabled = alarm.auto_trade_enabled === true;

        if (autoTradeEnabled && !alarm.binance_order_id) {
          tradeResult = await executeAutoTrade(
            alarm.user_id,
            symbol,
            direction,
            entryPrice,
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
            tradeNotificationText = `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${tradeResult.message}`;
          }
        }

        if (autoTradeEnabled && tradeResult.blockedByOpenPosition) {
          console.log(`⏹️ Skipping signal for ${symbol}: open position detected for user ${alarm.user_id}`);
          return;
        }

        if (!tradeNotificationText) {
          tradeNotificationText = autoTradeEnabled
            ? `\n\n⚠️ <b>Otomatik işlem başarısız:</b>\n${tradeResult.message}`
            : `\n\nℹ️ <b>Otomatik işlem:</b> Kapalı`;
        }
        
        const formattedDateTime = formatTurkeyDateTime(indicators.lastClosedTimestamp);

        // Get signal analysis score for market strength
        const userConfidenceThreshold = Number(alarm.confidence_score || 70);
        const signalAnalysis = generateSignalScoreAligned(alarmIndicators, userConfidenceThreshold);

        let telegramMessage = `
🔔 <b>ALARM AKTİVE!</b> 🔔

💰 Çift: <b>${symbol}</b>
🎯 ${directionTR} Sinyali Tespit Edildi!

📊 Piyasa: <b>${marketType}</b> | Zaman: <b>${timeframe}</b>
💹 Fiyat: <b>$${formatPriceWithPrecision(indicators.price, decimals)}</b>

📈 Sinyal: Güven: <b>${userConfidenceThreshold}%</b>
📊 Gelen Sinyalin Güveni: <b>${signalAnalysis.score}%</b>

🎯 Hedefler:
  TP: <b>$${formatPriceWithPrecision(tpPrice, decimals)}</b> (<b>+${tpPercent}%</b>)
  SL: <b>$${formatPriceWithPrecision(slPrice, decimals)}</b> (<b>-${slPercent}%</b>)

⏰ Zaman: <b>${formattedDateTime}</b>
${tradeNotificationText}

<i>Not:</i> Otomatik al-sat işlemleri market fiyatından anlık alındığı için, sinyalin giriş fiyatına göre farklılık gösterebilir.
`;

        // 🚀 INSERT active signal INTO DATABASE
        let signalInserted = false;
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
            signal_timestamp: lastClosedIso,
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
            openSignalSymbols.add(`${alarm.user_id}:${symbol}`);
            openSignalKeys.add(`${alarm.user_id}:${String(alarm.id || "")}`);
            openSignalDirections.add(`${alarm.user_id}:${symbol}:${direction}`);
          }
        } catch (e) {
          console.error(`❌ Error creating signal for ${symbol}:`, e);
              return;
        }

        if (!signalInserted) {
          console.warn(`⚠️ active_signals insert failed for ${symbol} - telegram skipped`);
          return;
        }

        try {
          await supabase
            .from("alarms")
            .update({ signal_timestamp: lastClosedIso })
            .eq("id", alarm.id);
        } catch (e) {
          console.warn(`⚠️ Failed to update alarm signal_timestamp for ${symbol}:`, e);
        }

        telegramPromises.push(sendTelegramNotification(alarm.user_id, telegramMessage));
        console.log(`✅ User alarm triggered for ${symbol}: ${triggerMessage}`);
      }
    } catch (e) {
      console.error(`❌ Error checking user alarm ${alarm?.id}:`, e);
    }
  };

  for (const batch of batches) {
    await Promise.all(batch.map(processAlarm));
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  // 🚀 PARALLELIZED: Send all Telegram messages in parallel
  await Promise.all(telegramPromises);
}
type ClosedSignal = {
  id: string | number;
  symbol: string;
  direction: "LONG" | "SHORT";
  close_reason: "TP_HIT" | "SL_HIT" | "TIMEOUT";
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

    const closedSignals: ClosedSignal[] = [];

    for (let idx = 0; idx < signals.length; idx++) {
      try {
        const signal = signals[idx];
        const symbol = String(signal.symbol || "");
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

        let shouldClose = false;
        let closeReason: "TP_HIT" | "SL_HIT" | "TIMEOUT" | "" = "";
        let closePrice: number | null = null;

        const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
        const createdAtMs = Date.parse(String(signal.created_at || ""));
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
            .eq("status", "ACTIVE");

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

        // Backtest ile uyum icin kapanis sadece son kapanan barin high/low degerine gore belirlenir.
        const marketType = normalizeMarketType(signal.market_type || signal.marketType || signal.market);
        const timeframe = String(signal.timeframe || "1h");
        const klines = await getKlines(symbol, marketType, timeframe, 2);
        if (klines && klines.length >= 2) {
          const lastClosed = klines[klines.length - 2];
          const barHigh = Number(lastClosed?.[2]);
          const barLow = Number(lastClosed?.[3]);
          if (Number.isFinite(barHigh) && Number.isFinite(barLow)) {
            if (direction === "LONG") {
              if (barLow <= stopLoss) {
                shouldClose = true;
                closeReason = "SL_HIT";
                closePrice = stopLoss;
              } else if (barHigh >= takeProfit) {
                shouldClose = true;
                closeReason = "TP_HIT";
                closePrice = takeProfit;
              }
            } else if (direction === "SHORT") {
              if (barHigh >= stopLoss) {
                shouldClose = true;
                closeReason = "SL_HIT";
                closePrice = stopLoss;
              } else if (barLow <= takeProfit) {
                shouldClose = true;
                closeReason = "TP_HIT";
                closePrice = takeProfit;
              }
            }
          }
        }

        if (!shouldClose || !closeReason) continue;

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
        }

        const updateResult = await supabase
          .from("active_signals")
          .update({
            status: "CLOSED",
            close_reason: closeReason,
            profit_loss: profitLoss,
            closed_at: new Date().toISOString()
          })
          .eq("id", signal.id)
          .eq("status", "ACTIVE");

        if (updateResult.error) {
          console.error(`❌ updateError for signal ${signal.id}:`, updateResult.error);
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
          close_reason: closeReason,
          price: Number.isFinite(closePrice) ? Number(closePrice) : Number(signal.entry_price),
          user_id: signal.user_id,
          market_type: signal.market_type || signal.marketType || signal.market,
          profitLoss,
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
    signal_timestamp: newSignal.signal_timestamp,
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

  // ✅ Auth guard (optional - enforced only if CRON_SECRET is set)
  if (cronSecret) {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== cronSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
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
      } else if (signal.close_reason === "TIMEOUT") {
        statusMessage = "⏱️ KAPANDI - TIMEOUT";
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
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
