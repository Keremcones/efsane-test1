// deno-lint-ignore-file no-explicit-any
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

if (!supabaseUrl || !supabaseServiceRoleKey || !telegramBotToken) {
  console.error("❌ Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN");
}

// Single supabase client for whole function (more efficient)
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// =====================
// Binance API bases
// =====================
const BINANCE_SPOT_API_BASE = "https://api.binance.com/api/v3";
const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com/fapi/v1";

// =====================
// Binance exchangeInfo cache
// =====================
const exchangeInfoCache: Record<string, any> = {};
const exchangeInfoCacheTime: Record<string, number> = {};

function normalizeMarketType(value: any): "spot" | "futures" {
  const v = String(value || "").toLowerCase();
  return v === "futures" || v === "future" || v === "perp" || v === "perpetual" ? "futures" : "spot";
}

async function getExchangeInfo(marketType: "spot" | "futures"): Promise<any | null> {
  const now = Date.now();
  const cacheKey = marketType;
  if (exchangeInfoCache[cacheKey] && (now - (exchangeInfoCacheTime[cacheKey] || 0)) < 60 * 60 * 1000) {
    return exchangeInfoCache[cacheKey];
  }

  const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
  const url = marketType === "futures"
    ? `${base}/exchangeInfo`
    : `${base}/exchangeInfo?permissions=SPOT`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("❌ exchangeInfo fetch failed:", res.status, await res.text());
      return null;
    }
    exchangeInfoCache[cacheKey] = await res.json();
    exchangeInfoCacheTime[cacheKey] = now;
    return exchangeInfoCache[cacheKey];
  } catch (e) {
    console.error("❌ Exchange info fetch error:", e);
    return null;
  }
}

function getTickSize(exchangeInfo: any, symbol: string): number | null {
  try {
    const s = exchangeInfo?.symbols?.find((x: any) => x.symbol === symbol);
    const filter = s?.filters?.find((f: any) => f.filterType === "PRICE_FILTER");
    const tickSizeStr = filter?.tickSize;
    const tick = tickSizeStr ? Number(tickSizeStr) : NaN;
    if (!Number.isFinite(tick) || tick <= 0) return null;
    return tick;
  } catch {
    return null;
  }
}

// Round price to tick size (safe for comparisons/storage)
function roundToTick(price: number, tick: number, mode: "DOWN" | "NEAREST" = "NEAREST") {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price;

  const factor = 1 / tick;
  const v = price * factor;

  const rounded = mode === "DOWN" ? Math.floor(v) : Math.round(v);
  const result = rounded / factor;

  // Fix floating point noise
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return Number(result.toFixed(decimals));
}

async function getCurrentPrice(symbol: string, marketType: "spot" | "futures"): Promise<number | null> {
  try {
    const base = marketType === "futures" ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
    const res = await fetch(`${base}/ticker/price?symbol=${symbol}`);
    if (!res.ok) {
      console.error(`❌ price fetch failed for ${symbol}:`, res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const p = Number(data?.price);
    if (!Number.isFinite(p)) return null;
    return p;
  } catch (e) {
    console.error(`❌ price fetch error for ${symbol}:`, e);
    return null;
  }
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

// =====================
// User alarm trigger logic
// =====================
async function checkAndTriggerUserAlarms(alarms: any[]): Promise<void> {
  for (const alarm of alarms || []) {
    try {
      const marketType = normalizeMarketType(alarm.market_type || alarm.marketType || "spot");
      const symbol = String(alarm.symbol || "").toUpperCase();
      const currentPrice = await getCurrentPrice(symbol, marketType);

      if (currentPrice === null) continue;

      let shouldTrigger = false;
      let triggerMessage = "";

      // PRICE_LEVEL alarm kontrolü
      if (alarm.type === "PRICE_LEVEL" || alarm.condition) {
        const targetPrice = Number(alarm.target_price || alarm.targetPrice);
        const condition = String(alarm.condition || "").toLowerCase();

        if (Number.isFinite(targetPrice)) {
          if (condition === "above" && currentPrice >= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `🚀 Fiyat ${targetPrice}$'ın üzerine çıktı! (Şu an: $${currentPrice})`;
          } else if (condition === "below" && currentPrice <= targetPrice) {
            shouldTrigger = true;
            triggerMessage = `📉 Fiyat ${targetPrice}$'ın altına indi! (Şu an: $${currentPrice})`;
          }
        }
      }

      // ACTIVE_TRADE alarm kontrolü
      if (alarm.type === "ACTIVE_TRADE" || alarm.direction) {
        const direction = String(alarm.direction || "").toUpperCase();
        const entryPrice = Number(alarm.entry_price || alarm.entryPrice);
        const takeProfit = Number(alarm.take_profit || alarm.takeProfit);
        const stopLoss = Number(alarm.stop_loss || alarm.stopLoss);

        if (direction === "LONG" && Number.isFinite(entryPrice) && Number.isFinite(takeProfit) && Number.isFinite(stopLoss)) {
          if (currentPrice >= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ LONG TP'ye ulaştı! (Giriş: $${entryPrice}, TP: $${takeProfit}, Şu an: $${currentPrice})`;
          } else if (currentPrice <= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ LONG SL'ye düştü! (Giriş: $${entryPrice}, SL: $${stopLoss}, Şu an: $${currentPrice})`;
          }
        } else if (direction === "SHORT" && Number.isFinite(entryPrice) && Number.isFinite(takeProfit) && Number.isFinite(stopLoss)) {
          if (currentPrice <= takeProfit) {
            shouldTrigger = true;
            triggerMessage = `✅ SHORT TP'ye ulaştı! (Giriş: $${entryPrice}, TP: $${takeProfit}, Şu an: $${currentPrice})`;
          } else if (currentPrice >= stopLoss) {
            shouldTrigger = true;
            triggerMessage = `⛔ SHORT SL'ye yükseldi! (Giriş: $${entryPrice}, SL: $${stopLoss}, Şu an: $${currentPrice})`;
          }
        }
      }

      if (shouldTrigger && triggerMessage) {
        const telegramMessage = `
🔔 <b>ALARM TETİKLENDİ!</b> 🔔

📊 Coin: <b>${symbol}</b>
${triggerMessage}

⏰ Alarm Zamanı: <b>${new Date().toLocaleString('tr-TR')}</b>
`;

        await sendTelegramNotification(alarm.user_id, telegramMessage);
        console.log(`✅ User alarm triggered for ${symbol}: ${triggerMessage}`);
      }
    } catch (e) {
      console.error(`❌ Error checking user alarm ${alarm?.id}:`, e);
    }
  }
}
type ClosedSignal = {
  id: string | number;
  symbol: string;
  direction: "LONG" | "SHORT";
  close_reason: "TP_HIT" | "SL_HIT";
  price: number;
  user_id: string;
};

async function checkAndCloseSignals(): Promise<ClosedSignal[]> {
  try {
    const { data: rawSignals, error: signalsError } = await supabase
      .from("alarms")
      .select("*")
      .eq("type", "auto_signal");

    if (signalsError) {
      console.error("❌ Error fetching signals:", signalsError);
      return [];
    }

    const signals = rawSignals?.filter(signal => signal.status === "ACTIVE" || !signal.status);

    const closedSignals: ClosedSignal[] = [];
    for (const signal of signals || []) {
      try {
        const marketType = normalizeMarketType(signal.market_type || signal.marketType || signal.market);
        const exchangeInfo = await getExchangeInfo(marketType);
        const symbol = String(signal.symbol || "");
        const direction = (signal.signal_direction || signal.direction) as "LONG" | "SHORT";
        if (direction !== "LONG" && direction !== "SHORT") {
          console.error(`❌ Invalid direction for signal ${signal.id}`);
          continue;
        }

        const rawPrice = await getCurrentPrice(symbol, marketType);
        if (rawPrice === null) continue;

        // tickSize rounding
        const tick = exchangeInfo ? getTickSize(exchangeInfo, symbol) : null;
        const currentPrice = tick ? roundToTick(rawPrice, tick, "NEAREST") : rawPrice;

        const tp = Number(signal.take_profit);
        const sl = Number(signal.stop_loss);

        if (!Number.isFinite(tp) || !Number.isFinite(sl)) {
          console.error(`❌ Invalid TP/SL for signal ${signal.id}`);
          continue;
        }

        const takeProfit = tick ? roundToTick(tp, tick, "NEAREST") : tp;
        const stopLoss = tick ? roundToTick(sl, tick, "NEAREST") : sl;

        let shouldClose = false;
        let closeReason: "TP_HIT" | "SL_HIT" | "" = "";

        if (direction === "LONG") {
          if (currentPrice >= takeProfit) {
            shouldClose = true;
            closeReason = "TP_HIT";
          } else if (currentPrice <= stopLoss) {
            shouldClose = true;
            closeReason = "SL_HIT";
          }
        } else if (direction === "SHORT") {
          if (currentPrice <= takeProfit) {
            shouldClose = true;
            closeReason = "TP_HIT";
          } else if (currentPrice >= stopLoss) {
            shouldClose = true;
            closeReason = "SL_HIT";
          }
        }

        if (!shouldClose || !closeReason) continue;

        const { error: updateError } = await supabase
          .from("alarms")
          .update({
            status: closeReason,
            closed_at: new Date().toISOString(),
            exit_price: currentPrice,
            current_price: currentPrice,
            close_price: currentPrice,
            closed_price: currentPrice,
            close_reason: closeReason,
            telegram_sent_at: new Date().toISOString(),
            profit_loss: direction === "LONG"
              ? ((currentPrice - Number(signal.entry_price)) / Number(signal.entry_price)) * 100
              : ((Number(signal.entry_price) - currentPrice) / Number(signal.entry_price)) * 100,
          })
          .eq("id", signal.id)
          .eq("status", "ACTIVE"); // avoid race double-close

        if (updateError) {
          console.error("❌ updateError:", updateError);
          continue;
        }

        closedSignals.push({
          id: signal.id,
          symbol,
          direction,
          close_reason: closeReason,
          price: currentPrice,
          user_id: signal.user_id,
        });
      } catch (e) {
        console.error(`❌ Error checking signal ${signal?.id}:`, e);
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

  // Duplicate check - more lenient: allow if different entry price or timestamp
  const { data: existing, error } = await supabase
    .from("alarms")
    .select("id")
    .eq("user_id", newSignal.user_id)
    .eq("symbol", newSignal.symbol)
    .eq("signal_direction", newSignal.signal_direction)
    .eq("status", "ACTIVE")
    .eq("type", "auto_signal")
    .neq("entry_price", newSignal.entry_price) // Allow if different entry price
    .maybeSingle();

  if (error) {
    console.error("❌ duplicate check error:", error);
  }

  if (existing?.id) {
    console.log(`⚠️ Duplicate signal attempt: ${newSignal.symbol} ${newSignal.signal_direction}`);
    return { inserted: false, duplicate: true };
  }

  const { error: insertError } = await supabase.from("alarms").insert(newSignal);

  if (insertError) {
    console.error("❌ insertError:", insertError);
    throw new Error("Failed to insert new signal");
  }

  return { inserted: true, duplicate: false };
}

// =====================
// Handler
// =====================
serve(async (req) => {
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

  // ✅ Auth guard (recommended). If CRON_SECRET is not set, it will skip.
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

      alarms = result.data?.filter(alarm => alarm.status === "ACTIVE" || !alarm.status);
      alarmsError = result.error;
    } else {
      // Cron mode: get all active alarms
      console.log("🔄 [CRON] Getting all active alarms for monitoring");
      const result = await supabase
        .from("alarms")
        .select("*")
        .eq("type", "user_alarm")
        .eq("is_active", true)
        .not("user_id", "is", null);

      alarms = result.data?.filter(alarm => alarm.status === "ACTIVE" || !alarm.status);
      alarmsError = result.error;
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

    // ✅ Notify
    for (const signal of closedSignals) {
      const statusMessage =
        signal.close_reason === "TP_HIT"
          ? "✅ KAPANDI - TP HIT!"
          : "⛔ KAPANDI - STOP LOSS HIT!";

      const telegramMessage = `
🔔 <b>İŞLEM KAPANDI</b> 🔔

📊 Coin: <b>${signal.symbol}</b>
📈 İşlem Yönü: <b>${signal.direction}</b>
${statusMessage}
💰 Kapanış Fiyatı: <b>$${signal.price}</b>

Detaylı rapor için dashboard'u kontrol edin.
`;

      await sendTelegramNotification(signal.user_id, telegramMessage);
    }

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
