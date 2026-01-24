// Telegram Configuration
const TELEGRAM_BOT_TOKEN = '8572447825:AAEkE3NUcqI3Ocd9C5c9jkGJmawXD2EI-KQ';
const TELEGRAM_BOT_USERNAME = '@Cryptosentinelsignalsbot';

// Supabase Configuration
const SUPABASE_URL = 'https://jcrbhekrphxodxhkuzju.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwOTY3MTQsImV4cCI6MjA4NDY3MjcxNH0.xg1dgP6uprsGg3Us-nUghbFc2xCrrQsSKOkz4c7MxAo';
const TELEGRAM_FUNCTION_URL = 'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/dynamic-responder';

// Binance API Configuration
const BINANCE_API_BASE = 'https://api.binance.com/api/v3';
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

// News API (Cryptopanic - Ücretsiz)
const CRYPTO_NEWS_API_KEY = 'f44dcd8508f4b556d5ccb2dc1c30c7c48e8a8a8a';
const CRYPTO_NEWS_BASE = 'https://cryptopanic.com/api/v1';

// Fear & Greed Index API
const FEAR_GREED_API = 'https://api.alternative.me/fng';

// CORS Proxy (localhost'ta gereksiz ama artifact test için)
const USE_CORS_PROXY = false; // localhost'ta false, artifact'te true
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

// App Configuration
const APP_CONFIG = {
    defaultRiskPerTrade: 2, // %2
    minRiskRewardRatio: 1.5,
    maxPositionSizePercentage: 10, // %10
    backtestDays: 30,
    alarmCheckInterval: 2000, // 2 saniye (TP/SL kontrol için)
    newsUpdateInterval: 300000, // 5 dakika
    sentimentUpdateInterval: 3600000 // 1 saat
};