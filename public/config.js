// ⚠️ IMPORTANT: Set these in Vercel Environment Variables, not here!
// Frontend only has access to ANON_KEY (safe), SERVICE_ROLE_KEY is backend-only
// See .env.example for setup instructions

// LOCAL DEVELOPMENT: Values from .env file or localStorage
// For production: Use Vercel Environment Variables
const LOCAL_DEV = {
    SUPABASE_URL: 'https://jcrbhekrphxodxhkuzju.supabase.co',
    // Supabase ANON_KEY (public, safe to use in frontend)
    SUPABASE_ANON_KEY: localStorage.getItem('SUPABASE_ANON_KEY') || 
                       sessionStorage.getItem('SUPABASE_ANON_KEY') ||
                       'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwOTY3MTQsImV4cCI6MjA4NDY3MjcxNH0.xg1dgP6uprsGg3Us-nUghbFc2xCrrQsSKOkz4c7MxAo',
    TELEGRAM_BOT_TOKEN: '8572447825:AAEkE3NUcqI3Ocd9C5c9jkGJmawXD2EI-KQ',
    TELEGRAM_BOT_USERNAME: 'HerSeyOkAlarmBot'
};

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = window.__ENV_TELEGRAM_BOT_TOKEN || LOCAL_DEV.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = window.__ENV_TELEGRAM_BOT_USERNAME || LOCAL_DEV.TELEGRAM_BOT_USERNAME || '';

// Supabase Configuration (Anon key only - service role is backend)
const SUPABASE_URL = window.__ENV_SUPABASE_URL || LOCAL_DEV.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.__ENV_SUPABASE_ANON_KEY || LOCAL_DEV.SUPABASE_ANON_KEY || '';
const TELEGRAM_FUNCTION_URL = window.__ENV_TELEGRAM_FUNCTION_URL || '';

// Binance API Configuration
const BINANCE_SPOT_API_BASE = 'https://api.binance.com/api/v3';
const BINANCE_FUTURES_API_BASE = 'https://fapi.binance.com/fapi/v1';
const BINANCE_SPOT_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BINANCE_FUTURES_WS_BASE = 'wss://fstream.binance.com/ws';

// Market Type Management
let CURRENT_MARKET_TYPE = 'spot'; // Default to spot

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
const storedMarketType = localStorage.getItem('marketType');
if (storedMarketType) {
    CURRENT_MARKET_TYPE = storedMarketType;
}

// News API (Cryptopanic - Ücretsiz)
const CRYPTO_NEWS_API_KEY = 'f44dcd8508f4b556d5ccb2dc1c30c7c48e8a8a8a';
const CRYPTO_NEWS_BASE = 'https://cryptopanic.com/api/v1';

// Fear & Greed Index API
const FEAR_GREED_API = 'https://api.alternative.me/fng';

// CORS Proxy - Binance API isteklerini proxy üzerinden yapma
const USE_CORS_PROXY = false; // Proxy devre dışı - doğrudan API çağır

// App Configuration
const APP_CONFIG = {
    defaultRiskPerTrade: 2, // %2
    minRiskRewardRatio: 1.5,
    maxPositionSizePercentage: 10, // %10
    backtestDays: 30,
    alarmCheckInterval: 2000, // 2 saniye (TP/SL kontrol için)
    newsUpdateInterval: 300000, // 5 dakika
    sentimentUpdateInterval: 3600000 // 1 saat
};/* Updated Sun Jan 25 02:35:41 +03 2026 */
