// ⚠️ IMPORTANT: Set these in Vercel Environment Variables, not here!
// Frontend only has access to ANON_KEY (safe), SERVICE_ROLE_KEY is backend-only
// See .env.example for setup instructions

// LOCAL DEVELOPMENT: Values from .env file or localStorage
// For production: Use Vercel Environment Variables
var DEFAULT_PUBLISHABLE_ANON_KEY = 'sb_publishable_TTHovjtf56Yy7LpXQUcMvg_vVihEu55';

function normalizeAnonKey(candidate) {
    if (!candidate) return DEFAULT_PUBLISHABLE_ANON_KEY;
    if (candidate.startsWith('sb_publishable_')) return candidate;
    return DEFAULT_PUBLISHABLE_ANON_KEY;
}

var storedAnonKey = '';
try {
    storedAnonKey = localStorage.getItem('SUPABASE_ANON_KEY') || sessionStorage.getItem('SUPABASE_ANON_KEY') || '';
} catch (e) {
    storedAnonKey = '';
}

var rawEnvAnonKey = window.SUPABASE_ANON_KEY || window.__ENV_SUPABASE_ANON_KEY || '';
var effectiveAnonKey = normalizeAnonKey(rawEnvAnonKey || storedAnonKey);
try {
    if (storedAnonKey !== effectiveAnonKey) {
        localStorage.setItem('SUPABASE_ANON_KEY', effectiveAnonKey);
    }
} catch (e) {
    // Ignore storage errors (private mode, disabled storage, etc.)
}

// Force any injected env key to use the publishable format.
window.__ENV_SUPABASE_ANON_KEY = effectiveAnonKey;
window.SUPABASE_ANON_KEY = effectiveAnonKey;

var LOCAL_DEV = window.LOCAL_DEV || {
    SUPABASE_URL: 'https://jcrbhekrphxodxhkuzju.supabase.co',
    // Supabase ANON_KEY (public, safe to use in frontend)
    SUPABASE_ANON_KEY: effectiveAnonKey,
    TELEGRAM_BOT_USERNAME: 'HerSeyOkAlarmBot'
};
window.LOCAL_DEV = LOCAL_DEV;

// Telegram Configuration
var TELEGRAM_BOT_USERNAME = window.TELEGRAM_BOT_USERNAME || window.__ENV_TELEGRAM_BOT_USERNAME || LOCAL_DEV.TELEGRAM_BOT_USERNAME || '';
window.TELEGRAM_BOT_USERNAME = TELEGRAM_BOT_USERNAME;

// Supabase Configuration (Anon key only - service role is backend)
var SUPABASE_URL = window.SUPABASE_URL || window.__ENV_SUPABASE_URL || LOCAL_DEV.SUPABASE_URL || '';
var SUPABASE_ANON_KEY = normalizeAnonKey(
    window.SUPABASE_ANON_KEY || window.__ENV_SUPABASE_ANON_KEY || LOCAL_DEV.SUPABASE_ANON_KEY || ''
);
var TELEGRAM_FUNCTION_URL = window.TELEGRAM_FUNCTION_URL || window.__ENV_TELEGRAM_FUNCTION_URL || '';
if (!TELEGRAM_FUNCTION_URL && SUPABASE_URL) {
    TELEGRAM_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/check-alarm-signals`;
}
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.TELEGRAM_FUNCTION_URL = TELEGRAM_FUNCTION_URL;

// Binance API Configuration
var BINANCE_SPOT_API_BASE = window.BINANCE_SPOT_API_BASE || 'https://api.binance.com/api/v3';
var BINANCE_FUTURES_API_BASE = window.BINANCE_FUTURES_API_BASE || 'https://fapi.binance.com/fapi/v1';
var BINANCE_SPOT_WS_BASE = window.BINANCE_SPOT_WS_BASE || 'wss://stream.binance.com:9443/ws';
var BINANCE_FUTURES_WS_BASE = window.BINANCE_FUTURES_WS_BASE || 'wss://fstream.binance.com/ws';
window.BINANCE_SPOT_API_BASE = BINANCE_SPOT_API_BASE;
window.BINANCE_FUTURES_API_BASE = BINANCE_FUTURES_API_BASE;
window.BINANCE_SPOT_WS_BASE = BINANCE_SPOT_WS_BASE;
window.BINANCE_FUTURES_WS_BASE = BINANCE_FUTURES_WS_BASE;

// Market Type Management
var CURRENT_MARKET_TYPE = window.CURRENT_MARKET_TYPE || 'spot'; // Default to spot
window.CURRENT_MARKET_TYPE = CURRENT_MARKET_TYPE;

function getBinanceApiBase() {
    return CURRENT_MARKET_TYPE === 'futures' ? BINANCE_FUTURES_API_BASE : BINANCE_SPOT_API_BASE;
}

function getBinanceWsBase() {
    return CURRENT_MARKET_TYPE === 'futures' ? BINANCE_FUTURES_WS_BASE : BINANCE_SPOT_WS_BASE;
}

function setMarketType(marketType) {
    CURRENT_MARKET_TYPE = marketType;
    // Store in localStorage for persistence
    localStorage.setItem('marketType', marketType);
}

function getMarketType() {
    return CURRENT_MARKET_TYPE;
}

// Initialize market type from localStorage
var storedMarketType = window.storedMarketType || localStorage.getItem('marketType');
window.storedMarketType = storedMarketType;
if (storedMarketType) {
    CURRENT_MARKET_TYPE = storedMarketType;
    window.CURRENT_MARKET_TYPE = CURRENT_MARKET_TYPE;
}

// News API (RSS kaynakları kullanılıyor)

// Fear & Greed Index API
var FEAR_GREED_API = window.FEAR_GREED_API || 'https://api.alternative.me/fng';
window.FEAR_GREED_API = FEAR_GREED_API;

// CORS Proxy - Binance API isteklerini proxy üzerinden yapma
var CORS_PROXY = window.CORS_PROXY || window.__ENV_CORS_PROXY || '';
if (!CORS_PROXY && window.location && window.location.origin && window.location.origin !== 'null') {
    CORS_PROXY = window.location.origin + '/api/cors-proxy?url=';
}
window.CORS_PROXY = CORS_PROXY;
var USE_CORS_PROXY = window.USE_CORS_PROXY ?? false; // Proxy devre dışı - doğrudan API çağır
window.USE_CORS_PROXY = USE_CORS_PROXY;

// Realtime toggle (disable by default to avoid websocket failures)
var REALTIME_ENABLED = window.REALTIME_ENABLED;
if (REALTIME_ENABLED === undefined || REALTIME_ENABLED === null || REALTIME_ENABLED === '') {
    try {
        REALTIME_ENABLED = localStorage.getItem('REALTIME_ENABLED');
    } catch (e) {
        REALTIME_ENABLED = '';
    }
}
if (REALTIME_ENABLED === 'true') {
    REALTIME_ENABLED = true;
} else if (REALTIME_ENABLED === 'false') {
    REALTIME_ENABLED = false;
}
if (REALTIME_ENABLED !== true && REALTIME_ENABLED !== false) {
    REALTIME_ENABLED = false;
}
window.REALTIME_ENABLED = REALTIME_ENABLED;

// App Configuration
var APP_CONFIG = window.APP_CONFIG || {
    defaultRiskPerTrade: 2, // %2
    minRiskRewardRatio: 1.5,
    maxPositionSizePercentage: 10, // %10
    backtestDays: 30,
    alarmCheckInterval: 2000, // 2 saniye (TP/SL kontrol için)
    newsUpdateInterval: 300000, // 5 dakika
    sentimentUpdateInterval: 3600000 // 1 saat
};
window.APP_CONFIG = APP_CONFIG;
// Console verbosity: only errors in production
var DEBUG_CONSOLE = window.DEBUG_CONSOLE ?? false;
window.DEBUG_CONSOLE = DEBUG_CONSOLE;
if (!DEBUG_CONSOLE) {
    console.log = function () {};
    console.info = function () {};
    console.warn = function () {};
}
// Theme sync across all pages/tabs
(() => {
    const applyTheme = (theme) => {
        if (!theme) return;
        document.documentElement.dataset.theme = theme;
    };
    applyTheme(localStorage.getItem('theme'));
    window.addEventListener('storage', (event) => {
        if (event.key === 'theme') {
            applyTheme(event.newValue);
        }
    });
})();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
}
/* Updated Sun Jan 25 02:35:41 +03 2026 */
