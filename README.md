# ⚡ CRYPTO SENTINEL SIGNALS - Gelişmiş Teknik Analiz Dashboard

Binance kripto para verilerine dayalı otomatik trading stratejisi analiz ve backtesting sistemi.

## 🎯 Özellikler

- **Multi-Timeframe Analiz**: 5m, 15m, 30m, 1h, 4h, 1d
- **Gerçek Zamanlı Backtest**: TP, SL kuralları
- **Gelişmiş Teknik Göstergeler**: RSI, MACD, Bollinger Bands, EMA, SMA vb.
- **Pattern Recognition**: M-top, W-bottom, Head-Shoulders, vb.
- **Risk Yönetimi**: TP/SL yüzdeleri, Risk Calculator
- **Alarm Sistemi**: Sinyal tespiti ve Telegram bildirimleri
- **Multi-Dil Destek**: Türkçe, İngilizce, vb.

## 📁 Proje Yapısı

```
Proje/
├── src/                           # Ana kaynak kodlar
│   ├── dashboard.html             # Ana dashboard sayfası
│   ├── index.html                 # Alternatif giriş
│   ├── profile.html               # Kullanıcı profili
│   ├── config.js                  # Konfigürasyon (Supabase, API)
│   ├── advanced-indicators.js     # Backtest motoru
│   ├── indicators.js              # Teknik göstergeler
│   ├── telegram-notification-templates.js
│   └── i18n.js                    # Çok dil sistemi
│
├── docs/                          # Dokumentasyon
│   ├── README.md
│   ├── README_SUPABASE.md
│   ├── START_HERE.md
│   ├── database-schema.sql
│   └── AUTOTRANSLATE_*.md
│
├── scripts/                       # Yardımcı scriptler
│   ├── autoTranslate.js
│   ├── fix_layout.py
│   ├── update_layout.py
│   └── test-autotranslate.html
│
├── config/                        # Konfigürasyon dosyaları
│   └── (harici config dosyaları burada olacak)
│
├── temp/                          # Geçici dosyalar
│   └── (log, cache vb.)
│
├── index.html                     # Ana entry point (redirect)
└── .gitignore                     # Git ignore kuralları
```

## 🚀 Başlangıç

### 1. Gereksinimler
- Modern web tarayıcısı (Chrome, Firefox, Edge, Safari)
- İnternet bağlantısı
- Supabase hesabı (opsiyonel - offline mode da çalışır)

### 2. Kurulum

```bash
# Proje dosyasını Desktop'a kopyala
cd ~/Desktop/Proje

# Local server başlat
python3 -m http.server 8000
# veya
python -m http.server 8000
```

### 3. Açma
```
Browser'da açın: http://localhost:8000
```

## 📊 Kullanım

### Coin Seçimi
- Üst kısımda coin dropdown'undan BTC/USDT seç
- Sıralama: Volume, % Değişim, İsim

### Timeframe Seçimi
- Analiz için zaman dilimi seç: 5m, 15m, 30m, 1h, 4h, 1d

### Backtest Parametreleri
- **TP (Take Profit)**: Kar al yüzdesi (default %5)
- **SL (Stop Loss)**: Zarar durdur yüzdesi (default %3)
- **Güven Skoru**: Sinyal güvenilirliği (0-100)

### Sonuçlar
- Geçmiş işlemler (kapalı)
- Aktif işlem (varsa)
- İstatistikler: Win Rate, Profit Factor, vb.

## 🔧 Konfigürasyon

### src/config.js
```javascript
// Binance API
const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

// Supabase (opsiyonel)
const SUPABASE_URL = 'your-supabase-url';
const SUPABASE_ANON_KEY = 'your-supabase-key';

// Telegram Bot (opsiyonel)
const TELEGRAM_BOT_TOKEN = 'your-bot-token';
const TELEGRAM_CHAT_ID = 'your-chat-id';
```

## 📈 Göstergeler

- **RSI**: Momentum göstergesi
- **MACD**: Trend göstergesi
- **Bollinger Bands**: Volatilite göstergesi
- **EMA/SMA**: Hareketli ortalamalar
- **Stochastic**: Fiyat momentum
- **ADX**: Trend gücü
- **Volume Profile**: Hacim analizi

## 🔐 Güvenlik

- Supabase RLS policies ile veri koruması
- Şifrelenmiş token depolama
- localStorage kullanıcı verisi (tarayıcı-tabanlı)

## 🐛 Sorun Giderme

### Backtest sonuç vermiyor
1. Coin seçimini kontrol et
2. Timeframe'i değiştir
3. Browser console'u aç (F12) ve hataları kontrol et

### Telegram bildirimleri gelmiyor
1. Bot token'ını kontrol et
2. Chat ID doğru mu kontrol et
3. `testSupabaseSettings()` komutunu çalıştır (Console)

### Supabase bağlantı hatası
- Offline mode devreye girer, localStorage kullanır
- Alarmlar `localStorage` da saklı olur

## 📝 Lisans

MIT License - Özgürce kullan, modifiye et, dağıt

## 👨‍💻 Geliştirici

Crypto Sentinel Signals - Advanced Technical Analysis
v1.0 - 2026

---

**NOT**: Ticari tavsiye değildir. Backtesting sonuçları gerçek piyasa performansını garantilemez.
