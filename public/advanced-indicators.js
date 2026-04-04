// GELİŞMİŞ TEKNİK İNDİKATÖRLER
// ============================

// Telegram bildirim şablonlarını içeri aktar
// (HTML'de <script src="telegram-notification-templates.js"></script> olmalı)

// (no helper) price formatting uses toFixed(2) where appropriate

function resolveMarketType(marketType) {
    return String(marketType || '').toLowerCase() === 'futures' ? 'futures' : 'spot';
}

function timeframeToMinutesBacktest(timeframe) {
    const tf = String(timeframe || '').trim().toLowerCase();
    const match = tf.match(/^(\d+)(m|h|d|w)$/);
    if (!match) return 60;
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || value <= 0) return 60;
    if (unit === 'm') return value;
    if (unit === 'h') return value * 60;
    if (unit === 'd') return value * 1440;
    if (unit === 'w') return value * 10080;
    return 60;
}

function getBinanceApiBaseForMarketType(marketType) {
    if (!marketType && typeof window.getBinanceApiBase === 'function') {
        return window.getBinanceApiBase();
    }
    const normalized = resolveMarketType(marketType);
    if (window.BinanceAPI) {
        return normalized === 'futures'
            ? window.BinanceAPI.getFuturesBase()
            : window.BinanceAPI.getSpotBase();
    }
    const spotBase = window.BINANCE_SPOT_API_BASE || 'https://api.binance.com/api/v3';
    const futuresBase = window.BINANCE_FUTURES_API_BASE || 'https://fapi.binance.com/fapi/v1';
    return normalized === 'futures' ? futuresBase : spotBase;
}

async function binanceFetchPath(marketType, path, options = {}, opts = {}) {
    const normalized = resolveMarketType(marketType);
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const headers = new Headers(options.headers || {});
    const requestOptions = {
        ...options,
        headers
    };

    if (window.BinanceAPI) {
        const fetchFn = normalized === 'futures'
            ? window.BinanceAPI.futuresFetch
            : window.BinanceAPI.spotFetch;
        return fetchFn(normalizedPath, requestOptions, opts);
    }
    const base = getBinanceApiBaseForMarketType(normalized);
    return fetch(`${base}${normalizedPath}`, requestOptions);
}

const exchangeInfoCache = {};
const EXCHANGE_INFO_TTL = 10 * 60 * 1000;

function getTickSizeDecimals(tickSize) {
    if (!tickSize || !String(tickSize).includes('.')) return 0;
    const fraction = String(tickSize).split('.')[1] || '';
    return fraction.replace(/0+$/, '').length;
}

async function getSymbolTickSize(symbol, marketType) {
    const normalized = resolveMarketType(marketType);
    const cacheKey = normalized;
    const now = Date.now();
    const cached = exchangeInfoCache[cacheKey];
    if (cached && (now - cached.timestamp) < EXCHANGE_INFO_TTL) {
        const info = cached.symbols && cached.symbols[symbol];
        if (info && Number.isFinite(info.tickSize)) return Number(info.tickSize);
    }

    try {
        const res = await binanceFetchPath(normalized, '/exchangeInfo', {}, { retries: 2, timeoutMs: 15000 });
        if (!res.ok) return null;
        const data = await res.json();
        const symbols = (data && data.symbols ? data.symbols : []).reduce((acc, item) => {
            const priceFilter = (item.filters || []).find(f => f.filterType === 'PRICE_FILTER');
            const tickSize = priceFilter && priceFilter.tickSize ? Number(priceFilter.tickSize) : null;
            const tickDecimals = tickSize ? getTickSizeDecimals(tickSize) : null;
            const pricePrecision = Number.isFinite(item.pricePrecision) ? item.pricePrecision : null;
            const resolvedPrecisionCandidates = [pricePrecision, tickDecimals].filter(v => Number.isFinite(v));
            const resolvedPrecision = resolvedPrecisionCandidates.length
                ? Math.max(...resolvedPrecisionCandidates)
                : null;
            acc[String(item.symbol)] = { tickSize, pricePrecision: resolvedPrecision };
            return acc;
        }, {});

        exchangeInfoCache[cacheKey] = { timestamp: now, symbols };
        const info = symbols && symbols[symbol];
        return info && Number.isFinite(info.tickSize) ? Number(info.tickSize) : null;
    } catch (error) {
        console.warn('exchangeInfo fetch error:', error);
        return null;
    }
}

function roundToTick(value, tick) {
    if (!Number.isFinite(tick) || tick <= 0) return value;
    const scaled = Math.round(value / tick) * tick;
    return Number.isFinite(scaled) ? scaled : value;
}

function applySlippage(price, side, slippageBps) {
    const bps = Number(slippageBps) || 0;
    if (!Number.isFinite(bps) || bps <= 0) return price;
    const pct = bps / 10000;
    return side === 'BUY' ? price * (1 + pct) : price * (1 - pct);
}

// 1. MULTI-TIMEFRAME ANALİZ
async function analyzeMultiTimeframe(symbol, marketType = null) {
    const timeframes = ['5m', '15m', '1h', '4h', '1d'];
    const timeframeMinutes = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    
    // Tüm API çağrılarını paralel yap (sequential yerine)
    const promises = timeframes.map(async (tf) => {
        try {
            const klinesPath = `/klines?symbol=${symbol}&interval=${tf}&limit=1000`;
            const response = await binanceFetchPath(marketType, klinesPath, {}, { retries: 2, timeoutMs: 15000 });
            if (!response.ok) {
                return {
                    timeframe: tf,
                    signal: 'ERR',
                    confidence: 0,
                    price: 0,
                    status: 'error',
                    message: `HTTP ${response.status}`
                };
            }
            const klines = await response.json();
            if (!Array.isArray(klines)) {
                return {
                    timeframe: tf,
                    signal: 'N/A',
                    confidence: 0,
                    price: 0,
                    status: 'error',
                    message: 'Kline verisi okunamadı'
                };
            }
            const closedKlines = klines.slice(0, -1);
            if (closedKlines.length < 2) {
                return {
                    timeframe: tf,
                    signal: 'N/A',
                    confidence: 0,
                    price: 0,
                    status: 'error',
                    message: 'Yetersiz veri'
                };
            }
            
            const window = closedKlines.slice(-1000);
            const closes = window.map(k => parseFloat(k[4]));
            const highs = window.map(k => parseFloat(k[2]));
            const lows = window.map(k => parseFloat(k[3]));
            const volumes = window.map(k => parseFloat(k[5]));
            const lastOpenKline = klines[klines.length - 1];
            const lastOpenTimestamp = Number(lastOpenKline?.[0] ?? 0);
            const lastOpenPrice = Number(lastOpenKline?.[1] ?? closes[closes.length - 1]);
            const nowMs = Date.now();
            const minutes = timeframeMinutes[tf] || 60;
            const timeframeMs = minutes * 60 * 1000;
            const maxDelayMs = Math.min(2 * 60 * 1000, Math.max(60000, Math.floor(timeframeMs * 0.3)));
            const isWithinOpenWindow = lastOpenTimestamp
                && nowMs >= lastOpenTimestamp
                && (nowMs - lastOpenTimestamp) <= maxDelayMs;

            const indicators = calculateAlarmIndicators(closes, highs, lows, volumes, lastOpenTimestamp);
            const signal = indicators
                ? generateSignalScoreAligned(indicators)
                : { direction: 'N/A', score: 0 };
            
            return {
                timeframe: tf,
                signal: signal.direction,
                confidence: signal.score,
                price: lastOpenPrice,
                status: 'ok'
            };
        } catch (error) {
            console.error(`MTF error for ${tf}:`, error);
            return {
                timeframe: tf,
                signal: 'N/A',
                confidence: 0,
                price: 0,
                status: 'error',
                message: 'İstek başarısız'
            };
        }
    });
    
    // Tüm promise'leri paralel çalıştır
    const results = await Promise.all(promises);
    return results;
}

function ensureFormLabels() {
    const fields = document.querySelectorAll('input, select, textarea');
    fields.forEach(field => {
        if (!field || field.type === 'hidden') return;
        const hasAria = field.getAttribute('aria-label') || field.getAttribute('aria-labelledby');
        if (hasAria) return;
        const id = field.getAttribute('id');
        if (id) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) return;
        }
        if (field.closest('label')) return;

        const placeholder = field.getAttribute('placeholder');
        const name = field.getAttribute('name');
        const fallback = placeholder || name || field.getAttribute('id') || field.type || 'form-field';
        field.setAttribute('aria-label', fallback);
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureFormLabels);
    } else {
        ensureFormLabels();
    }
}

// 2. FİBONACCİ SEVİYELERİ
function calculateFibonacciLevels(high, low) {
    const diff = high - low;
    return {
        level0: high,               // 0.0%
        level236: high - diff * 0.236,  // 23.6%
        level382: high - diff * 0.382,  // 38.2%
        level500: high - diff * 0.500,  // 50.0%
        level618: high - diff * 0.618,  // 61.8%
        level786: high - diff * 0.786,  // 78.6%
        level100: low,               // 100.0%
        level1272: low - diff * 0.272,  // 127.2% (extension)
        level1618: low - diff * 0.618   // 161.8% (extension)
    };
}

// 3. VOLUME PROFILE ve VWAP
function calculateVWAP(klines) {
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;
    
    for (const k of klines) {
        const typicalPrice = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const volume = parseFloat(k[5]);
        
        cumulativeTPV += typicalPrice * volume;
        cumulativeVolume += volume;
    }
    
    return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
}

function calculateVolumeProfile(klines, bins = 20) {
    const prices = klines.map(k => parseFloat(k[4]));
    const volumes = klines.map(k => parseFloat(k[5]));
    
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice;
    const binSize = range / bins;
    
    const profile = [];
    for (let i = 0; i < bins; i++) {
        const binMin = minPrice + (i * binSize);
        const binMax = binMin + binSize;
        
        let volume = 0;
        for (let j = 0; j < klines.length; j++) {
            const price = parseFloat(klines[j][4]);
            if (price >= binMin && price < binMax) {
                volume += volumes[j];
            }
        }
        
        profile.push({
            priceRange: [binMin, binMax],
            volume: volume,
            poc: (binMin + binMax) / 2
        });
    }
    
    // POC (Point of Control) - En yüksek hacimli bölge
    const poc = profile.reduce((max, bin) => bin.volume > max.volume ? bin : max);
    
    return { profile, poc: poc.poc };
}

// 4. PATTERN RECOGNITION (Formasyon Tanıma)
function detectPatterns(prices, highs, lows, period = 50) {
    const recentPrices = prices.slice(-period);
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    
    const patterns = [];
    
    // DOUBLE TOP/BOTTOM
    if (detectDoubleTop(recentHighs, recentLows)) {
        patterns.push({
            type: 'DOUBLE_TOP',
            name: 'Double Top',
            bearish: true,
            confidence: 0.8
        });
    }
    
    if (detectDoubleBottom(recentHighs, recentLows)) {
        patterns.push({
            type: 'DOUBLE_BOTTOM',
            name: 'Double Bottom',
            bullish: true,
            confidence: 0.8
        });
    }
    
    // HEAD & SHOULDERS
    if (detectHeadShoulders(recentHighs, recentLows)) {
        patterns.push({
            type: 'HEAD_SHOULDERS',
            name: 'Head & Shoulders',
            bearish: true,
            confidence: 0.7
        });
    }
    
    // TRIANGLES
    const triangle = detectTriangle(recentHighs, recentLows);
    if (triangle) {
        patterns.push(triangle);
    }
    
    // DIVERGENCE (RSI vs Price)
    const divergence = detectDivergence(prices, recentHighs, recentLows);
    if (divergence) {
        patterns.push(divergence);
    }
    
    return patterns;
}

function detectDoubleTop(highs, lows) {
    if (highs.length < 10) return false;
    
    // İki yakın tepe noktası bul
    const peaks = [];
    for (let i = 2; i < highs.length - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] &&
            highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
            peaks.push({ index: i, value: highs[i] });
        }
    }
    
    if (peaks.length < 2) return false;
    
    const lastPeak = peaks[peaks.length - 1];
    const prevPeak = peaks[peaks.length - 2];
    
    // Tepeler benzer seviyede olmalı (%2 fark)
    const diff = Math.abs(lastPeak.value - prevPeak.value) / prevPeak.value;
    if (diff < 0.02) {
        // Aradaki dip (neckline)
        const neckline = Math.min(...lows.slice(prevPeak.index, lastPeak.index));
        
        return true;
    }
    
    return false;
}

function detectDoubleBottom(highs, lows) {
    if (lows.length < 10) return false;
    
    const troughs = [];
    for (let i = 2; i < lows.length - 2; i++) {
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
            lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
            troughs.push({ index: i, value: lows[i] });
        }
    }
    
    if (troughs.length < 2) return false;
    
    const lastTrough = troughs[troughs.length - 1];
    const prevTrough = troughs[troughs.length - 2];
    
    const diff = Math.abs(lastTrough.value - prevTrough.value) / prevTrough.value;
    if (diff < 0.02) {
        return true;
    }
    
    return false;
}

function detectHeadShoulders(highs, lows) {
    // Basitleştirilmiş Head & Shoulders tespiti
    if (highs.length < 20) return false;
    
    const last20Highs = highs.slice(-20);
    const maxIndex = last20Highs.indexOf(Math.max(...last20Highs));
    
    // Ortada en yüksek tepe (head), iki yanında daha düşük tepeler (shoulders)
    if (maxIndex > 5 && maxIndex < 15) {
        const leftShoulder = Math.max(...last20Highs.slice(0, maxIndex - 2));
        const head = last20Highs[maxIndex];
        const rightShoulder = Math.max(...last20Highs.slice(maxIndex + 2));
        
        if (head > leftShoulder * 1.03 && head > rightShoulder * 1.03 &&
            Math.abs(leftShoulder - rightShoulder) / leftShoulder < 0.02) {
            return true;
        }
    }
    
    return false;
}

function detectTriangle(highs, lows) {
    // Üçgen formasyonu tespiti
    const recentHighs = highs.slice(-30);
    const recentLows = lows.slice(-30);
    
    // Yüksekler düşüyor, düşükler yükseliyor = Symmetrical Triangle
    // Sadece yüksekler düşüyor = Descending Triangle
    // Sadece düşükler yükseliyor = Ascending Triangle
    
    const firstHalfHighs = recentHighs.slice(0, 15);
    const secondHalfHighs = recentHighs.slice(15);
    const firstHalfLows = recentLows.slice(0, 15);
    const secondHalfLows = recentLows.slice(15);
    
    const avgFirstHighs = firstHalfHighs.reduce((a, b) => a + b, 0) / firstHalfHighs.length;
    const avgSecondHighs = secondHalfHighs.reduce((a, b) => a + b, 0) / secondHalfHighs.length;
    const avgFirstLows = firstHalfLows.reduce((a, b) => a + b, 0) / firstHalfLows.length;
    const avgSecondLows = secondHalfLows.reduce((a, b) => a + b, 0) / secondHalfLows.length;
    
    const highsDecreasing = avgSecondHighs < avgFirstHighs * 0.98;
    const lowsIncreasing = avgSecondLows > avgFirstLows * 1.02;
    
    if (highsDecreasing && lowsIncreasing) {
        return {
            type: 'SYMMETRICAL_TRIANGLE',
            name: 'Symmetrical Triangle',
            neutral: true,
            confidence: 0.6
        };
    } else if (highsDecreasing && !lowsIncreasing) {
        return {
            type: 'DESCENDING_TRIANGLE',
            name: 'Descending Triangle',
            bearish: true,
            confidence: 0.7
        };
    } else if (!highsDecreasing && lowsIncreasing) {
        return {
            type: 'ASCENDING_TRIANGLE',
            name: 'Ascending Triangle',
            bullish: true,
            confidence: 0.7
        };
    }
    
    return null;
}

// 5. DIVERGENCE TESPİTİ
function detectDivergence(prices, highs, lows) {
    if (prices.length < 30) return null;
    
    // RSI hesapla
    const rsi = calculateRSI(prices, 14);
    const rsiArray = calculateRSIArray(prices, 14);
    
    if (!rsiArray || rsiArray.length < 20) return null;
    
    // Fiyat ve RSI tepe/dip noktalarını bul
    const pricePeaks = findPeaks(highs, 3);
    const priceTroughs = findTroughs(lows, 3);
    const rsiPeaks = findPeaks(rsiArray, 3);
    const rsiTroughs = findTroughs(rsiArray, 3);
    
    // Bearish Divergence: Fiyat yeni yüksek, RSI daha düşük
    if (pricePeaks.length >= 2 && rsiPeaks.length >= 2) {
        const lastPricePeak = pricePeaks[pricePeaks.length - 1];
        const prevPricePeak = pricePeaks[pricePeaks.length - 2];
        const lastRsiPeak = rsiPeaks[rsiPeaks.length - 1];
        const prevRsiPeak = rsiPeaks[rsiPeaks.length - 2];
        
        if (lastPricePeak.value > prevPricePeak.value && 
            lastRsiPeak.value < prevRsiPeak.value) {
            return {
                type: 'BEARISH_DIVERGENCE',
                name: 'Bearish Divergence (RSI)',
                bearish: true,
                confidence: 0.85,
                strength: (prevRsiPeak.value - lastRsiPeak.value) / prevRsiPeak.value
            };
        }
    }
    
    // Bullish Divergence: Fiyat yeni düşük, RSI daha yüksek
    if (priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
        const lastPriceTrough = priceTroughs[priceTroughs.length - 1];
        const prevPriceTrough = priceTroughs[priceTroughs.length - 2];
        const lastRsiTrough = rsiTroughs[rsiTroughs.length - 1];
        const prevRsiTrough = rsiTroughs[rsiTroughs.length - 2];
        
        if (lastPriceTrough.value < prevPriceTrough.value && 
            lastRsiTrough.value > prevRsiTrough.value) {
            return {
                type: 'BULLISH_DIVERGENCE',
                name: 'Bullish Divergence (RSI)',
                bullish: true,
                confidence: 0.85,
                strength: (lastRsiTrough.value - prevRsiTrough.value) / prevRsiTrough.value
            };
        }
    }
    
    return null;
}

function findPeaks(data, lookback = 3) {
    const peaks = [];
    for (let i = lookback; i < data.length - lookback; i++) {
        let isPeak = true;
        for (let j = 1; j <= lookback; j++) {
            if (data[i] <= data[i - j] || data[i] <= data[i + j]) {
                isPeak = false;
                break;
            }
        }
        if (isPeak) {
            peaks.push({ index: i, value: data[i] });
        }
    }
    return peaks;
}

function findTroughs(data, lookback = 3) {
    const troughs = [];
    for (let i = lookback; i < data.length - lookback; i++) {
        let isTrough = true;
        for (let j = 1; j <= lookback; j++) {
            if (data[i] >= data[i - j] || data[i] >= data[i + j]) {
                isTrough = false;
                break;
            }
        }
        if (isTrough) {
            troughs.push({ index: i, value: data[i] });
        }
    }
    return troughs;
}

// 6. GELİŞMİŞ SİNYAL ALGORİTMASI
function generateAdvancedSignal(indicators, price, sr, patterns = [], divergence = null, confidenceThreshold = 70, backtestAverages = null) {
    // Price doğrulaması
    if (!price || !Number.isFinite(price) || price <= 0) {
        price = 1; // Varsayılan değer
    }
    
    let score = 0;
    
    // TREND ANALİZİ (%40)
    let trendScore = 0;
    
    // Multi Timeframe trend alignment
    if (indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50) {
        trendScore += 30;
    } else if (indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50) {
        trendScore -= 30;
    }
    
    // ADX trend gücü
    if (indicators.adx > 25) {
        trendScore += Math.min((indicators.adx - 25) * 0.8, 20);
    }
    
    // MOMENTUM ANALİZİ (%30)
    let momentumScore = 0;
    
    // RSI
    if (indicators.rsi < 30) momentumScore += 25;
    else if (indicators.rsi < 40) momentumScore += 15;
    else if (indicators.rsi > 70) momentumScore -= 25;
    else if (indicators.rsi > 60) momentumScore -= 15;
    
    // MACD
    if (indicators.macd?.macd > 0) momentumScore += 10;
    else momentumScore -= 10;
    
    // Stochastic
    if (indicators.stoch?.k < 20) momentumScore += 10;
    else if (indicators.stoch?.k > 80) momentumScore -= 10;
    
    // VOLUME ANALİZİ (%15)
    let volumeScore = 0;
    
    // Volume spike detection
    const recentVolumes = indicators.volumeData || [];
    if (recentVolumes.length >= 2) {
        const lastVolume = recentVolumes[recentVolumes.length - 1];
        const avgVolume = recentVolumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
        
        if (lastVolume > avgVolume * 1.5) {
            volumeScore += 15;
        } else {
            volumeScore -= 10;
        }
    }
    
    // OBV trend
    if (indicators.obvTrend === 'rising') volumeScore += 10;
    else if (indicators.obvTrend === 'falling') volumeScore -= 10;
    
    // SUPPORT/RESISTANCE (%15)
    let srScore = 0;
    
    // SR doğrulaması
    if (!sr || !sr.supports || !sr.resistances) {
        sr = { supports: [{price: price * 0.95}], resistances: [{price: price * 1.05}] };
    }
    
    // Yakınlık
    const nearestSupport = sr.supports[0]?.price || (price * 0.95);
    const nearestResistance = sr.resistances[0]?.price || (price * 1.05);
    
    const distanceToSupport = (price - nearestSupport) / price;
    const distanceToResistance = (nearestResistance - price) / price;
    
    if (distanceToSupport < 0.02) srScore += 15; // Support'a çok yakın
    if (distanceToResistance < 0.02) srScore -= 15; // Direnç'e çok yakın
    
    // Fibonacci seviyeleri
    const fibLevels = indicators.fibonacci || {};
    if (fibLevels.level618 && Math.abs(price - fibLevels.level618) / price < 0.01) {
        srScore += 10; // 61.8% Fibonacci seviyesi
    }
    
    // PATTERN ve DIVERGENCE BONUSLARI
    let patternBonus = 0;
    
    // Pattern bonusları
    patterns.forEach(pattern => {
        if (pattern.bullish) patternBonus += 20;
        if (pattern.bearish) patternBonus -= 20;
        if (pattern.confidence > 0.7) patternBonus *= 1.2;
    });
    
    // Divergence bonusları
    if (divergence) {
        if (divergence.bullish) patternBonus += 25;
        if (divergence.bearish) patternBonus -= 25;
    }
    
    // TOPLAM SKOR HESAPLAMA (0-100 arası normalize et)
    score = (
        (trendScore / 50 * 40) +  // Trend: -50 ile +50 arası, %40 ağırlık
        (momentumScore / 50 * 30) +  // Momentum: -50 ile +50 arası, %30 ağırlık
        (volumeScore / 25 * 15) +  // Volume: -25 ile +25 arası, %15 ağırlık
        (srScore / 30 * 15)  // SR: -30 ile +30 arası, %15 ağırlık
    );
    
    // Pattern bonusu ekle (normalize et)
    score += Math.max(-30, Math.min(30, patternBonus)) / 30 * 10;  // Max ±10 ekle
    
    // Sonucu 0-100 arasına clamp et
    const direction = score > 0 ? 'LONG' : 'SHORT';
    const confidence = Math.min(Math.max(Math.abs(score), 0), 100);  // 0-100 arası

    // Trend filtresi: downtrend LONG, uptrend SHORT engelle
    const isDowntrend = indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50;
    const isUptrend = indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50;
    const trendBlocks = (direction === 'LONG' && isDowntrend) || (direction === 'SHORT' && isUptrend);
    
    // GERÇEK SINYAL: confidence >= confidenceThreshold (kullanıcı ayarlanabilir)
    const isValidSignal = confidence >= confidenceThreshold && !trendBlocks;
    
    // Risk/Reward oranı hesapla
    const riskReward = calculateRiskReward(price, sr, direction);
    
    // Sinyal timestamp'i
    const now = new Date();
    const signalTime = {
        timestamp: now.getTime(),
        date: now.toLocaleDateString('tr-TR'),
        time: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };
    
    // Backtest ortalamalarından TP/SL hesapla
    let tpPercent, slPercent;
    if (backtestAverages && backtestAverages[direction]) {
        tpPercent = backtestAverages[direction].avgTPPercent;
        slPercent = backtestAverages[direction].avgSLPercent;
    } else {
        // Varsayılan değerler
        tpPercent = direction === 'LONG' ? 5 : -5;
        slPercent = direction === 'LONG' ? -3 : 3;
    }
    
    const stopLoss = price * (1 + slPercent / 100);
    const takeProfit = price * (1 + tpPercent / 100);
    
    return {
        direction,
        entry: price,
        stop: stopLoss,
        tp: takeProfit,
        tpPercent: parseFloat(tpPercent.toFixed(2)),
        slPercent: parseFloat(slPercent.toFixed(2)),
        score: Math.round(confidence),
        confidenceLevel: getConfidenceLevel(confidence),
        isValidSignal: isValidSignal,  // TRUE sadece confidenceThreshold'dan yüksek olduğunda
        signalTime: signalTime,  // Sinyal oluşturulduğu zaman
        riskRewardRatio: riskReward.ratio,
        expectedProfit: riskReward.expectedProfit,
        maxLoss: riskReward.maxLoss,
        advancedScores: {
            trend: Math.round(trendScore),
            momentum: Math.round(momentumScore),
            volume: Math.round(volumeScore),
            supportResistance: Math.round(srScore),
            patternBonus: Math.round(patternBonus)
        }
    };
}

function calculateRiskReward(entry, sr, direction) {
    let stopLoss, takeProfit;
    
    if (direction === 'LONG') {
        stopLoss = sr.supports[0]?.price || entry * 0.97;
        takeProfit = sr.resistances[0]?.price || entry * 1.05;
    } else {
        stopLoss = sr.resistances[0]?.price || entry * 1.03;
        takeProfit = sr.supports[0]?.price || entry * 0.95;
    }
    
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    const ratio = reward / risk;
    
    return {
        ratio: ratio.toFixed(2),
        risk: risk.toFixed(2),
        reward: reward.toFixed(2),
        expectedProfit: (ratio > 1 ? 'Favorable' : 'Unfavorable'),
        maxLoss: risk.toFixed(2)
    };
}

// Alarm tarafi ile uyumlu indikator hesaplari
function calculateAlarmStochastic(highs, lows, closes, period = 14, smoothK = 3) {
    if (closes.length < period) return { K: 50, D: 50 };

    let lowestLow = lows[lows.length - 1];
    let highestHigh = highs[highs.length - 1];

    for (let i = Math.max(0, closes.length - period); i < closes.length; i++) {
        if (lows[i] < lowestLow) lowestLow = lows[i];
        if (highs[i] > highestHigh) highestHigh = highs[i];
    }

    const range = highestHigh - lowestLow;
    const rawK = range === 0 ? 50 : ((closes[closes.length - 1] - lowestLow) / range) * 100;
    const kValues = [];
    for (let i = 0; i < smoothK; i++) kValues.push(rawK);
    const K = kValues.reduce((a, b) => a + b, 0) / smoothK;
    const D = K;

    return {
        K: Math.max(0, Math.min(100, K)),
        D: Math.max(0, Math.min(100, D))
    };
}

function calculateAlarmADX(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 25;

    const trueRanges = [];
    const plusDMs = [];
    const minusDMs = [];

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

function calculateAlarmATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 0;
    const trueRanges = [];
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

function calculateAlarmMacd(closes) {
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

function calculateAlarmIndicators(closes, highs, lows, volumes, lastClosedTimestamp) {
    if (!closes || closes.length < 2) return null;

    const lastPrice = closes[closes.length - 1];
    const macdData = calculateAlarmMacd(closes);

    let obv = 0;
    let obvTrend = 'neutral';
    for (let i = 0; i < closes.length; i++) {
        if (i === 0) obv = volumes[i];
        else if (closes[i] > closes[i - 1]) obv += volumes[i];
        else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    if (closes[closes.length - 1] > closes[closes.length - 2]) obvTrend = 'rising';
    else if (closes[closes.length - 1] < closes[closes.length - 2]) obvTrend = 'falling';

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
        lastClosedTimestamp: Number.isFinite(lastClosedTimestamp) ? lastClosedTimestamp : Date.now(),
        closes: closes,
        volumes: volumes,
        highs: highs,
        lows: lows,
        macd: macdData.macdLine,
        histogram: macdData.histogram,
        obv: obv,
        obvTrend: obvTrend,
        resistance: resistance,
        support: support,
        stoch: stoch,
        adx: adx,
        atr: atr,
        volumeMA: volumeMA
    };
}

function getDefaultSignalStrategyConfig() {
    return {
        trendAlignmentScore: 30,
        adxBonusThreshold: 20,
        adxBonusMultiplier: 0.6,
        adxBonusCap: 12,
        rsiLowStrong: 30,
        rsiLowWeak: 40,
        rsiHighWeak: 60,
        rsiHighStrong: 70,
        rsiLowStrongScore: 25,
        rsiLowWeakScore: 15,
        rsiHighWeakScore: -15,
        rsiHighStrongScore: -25,
        macdPositiveScore: 10,
        macdNegativeScore: -10,
        stochLowThreshold: 20,
        stochHighThreshold: 80,
        stochLowScore: 10,
        stochHighScore: -10,
        obvRisingScore: 10,
        obvFallingScore: -10,
        volumeAboveAvgScore: 15,
        volumeBelowAvgScore: -10,
        srThresholdAtrMultiplier: 1.5,
        srThresholdMin: 0.01,
        srThresholdMax: 0.04,
        supportProximityScore: 15,
        resistanceProximityScore: -15,
        strongRegimeAdx: 18,
        bullishMomentumRsi: 52,
        bearishMomentumRsi: 48,
        momentumConflictAdx: 16,
        choppyAdx: 15,
        choppyRsiDelta: 5,
        choppyConfidenceBoost: 8,
        hasTrendOrAdx: 22,
    };
}

function normalizeSignalStrategyConfig(strategyConfig) {
    const defaults = getDefaultSignalStrategyConfig();
    if (!strategyConfig || typeof strategyConfig !== 'object') {
        return defaults;
    }

    const cfg = { ...defaults };
    for (const [key, value] of Object.entries(strategyConfig)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            cfg[key] = numeric;
        }
    }
    return cfg;
}

function generateSignalScoreAligned(indicators, userConfidenceThreshold = 70, strategyConfig = null) {
    const cfg = normalizeSignalStrategyConfig(strategyConfig);
    const breakdown = {};

    let trendScore = 0;
    let trendDetails = {
        emaAlignment: 0,
        adxBonus: 0
    };

    if (indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50) {
        trendScore += cfg.trendAlignmentScore;
        trendDetails.emaAlignment = cfg.trendAlignmentScore;
    } else if (indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50) {
        trendScore -= cfg.trendAlignmentScore;
        trendDetails.emaAlignment = -cfg.trendAlignmentScore;
    }

    const isTrendAlignedForAdx = trendDetails.emaAlignment !== 0;
    if (indicators.adx > cfg.adxBonusThreshold && isTrendAlignedForAdx) {
        const adxBonus = Math.min((indicators.adx - cfg.adxBonusThreshold) * cfg.adxBonusMultiplier, cfg.adxBonusCap);
        trendScore += adxBonus;
        trendDetails.adxBonus = adxBonus;
    }

    breakdown.TREND_ANALIZI = {
        score: trendScore,
        weight: '40%',
        details: {
            'EMA12/EMA26 & SMA20/SMA50': `${trendDetails.emaAlignment > 0 ? 'LONG' : trendDetails.emaAlignment < 0 ? 'SHORT' : '-'} (${trendDetails.emaAlignment})`,
            'ADX > 20 Bonus (Aligned)': `${trendDetails.adxBonus > 0 ? '+' : ''}${trendDetails.adxBonus.toFixed(2)}`,
            'ADX Value': Number(indicators.adx || 0).toFixed(2),
            'EMA12': Number(indicators.ema12 || 0).toFixed(8),
            'EMA26': Number(indicators.ema26 || 0).toFixed(8),
            'SMA20': Number(indicators.sma20 || 0).toFixed(8),
            'SMA50': Number(indicators.sma50 || 0).toFixed(8)
        }
    };

    let momentumScore = 0;
    let momentumDetails = {
        rsiScore: 0,
        macdScore: 0,
        stochScore: 0
    };

    if (indicators.rsi < cfg.rsiLowStrong) {
        momentumScore += cfg.rsiLowStrongScore;
        momentumDetails.rsiScore = cfg.rsiLowStrongScore;
    } else if (indicators.rsi < cfg.rsiLowWeak) {
        momentumScore += cfg.rsiLowWeakScore;
        momentumDetails.rsiScore = cfg.rsiLowWeakScore;
    } else if (indicators.rsi > cfg.rsiHighStrong) {
        momentumScore += cfg.rsiHighStrongScore;
        momentumDetails.rsiScore = cfg.rsiHighStrongScore;
    } else if (indicators.rsi > cfg.rsiHighWeak) {
        momentumScore += cfg.rsiHighWeakScore;
        momentumDetails.rsiScore = cfg.rsiHighWeakScore;
    }

    const macdScore = indicators.macd > 0 ? cfg.macdPositiveScore : cfg.macdNegativeScore;
    momentumScore += macdScore;
    momentumDetails.macdScore = macdScore;

    if (indicators.stoch.K < cfg.stochLowThreshold) {
        momentumScore += cfg.stochLowScore;
        momentumDetails.stochScore = cfg.stochLowScore;
    } else if (indicators.stoch.K > cfg.stochHighThreshold) {
        momentumScore += cfg.stochHighScore;
        momentumDetails.stochScore = cfg.stochHighScore;
    }

    breakdown.MOMENTUM_ANALIZI = {
        score: momentumScore,
        weight: '30%',
        details: {
            'RSI': `${Number(indicators.rsi || 0).toFixed(2)} → ${momentumDetails.rsiScore > 0 ? '+' : ''}${momentumDetails.rsiScore}`,
            'MACD': `${indicators.macd > 0 ? 'Positive' : 'Negative'} → ${momentumDetails.macdScore > 0 ? '+' : ''}${momentumDetails.macdScore}`,
            'Stochastic K': `${Number(indicators.stoch.K || 0).toFixed(2)} → ${momentumDetails.stochScore > 0 ? '+' : ''}${momentumDetails.stochScore}`,
            'MACD Value': Number(indicators.macd || 0).toFixed(8),
            'Stochastic D': Number(indicators.stoch.D || 0).toFixed(2)
        }
    };

    let volumeScore = 0;
    let volumeDetails = {
        obvScore: 0,
        volumeMAScore: 0
    };

    if (indicators.obvTrend === 'rising') {
        volumeScore += cfg.obvRisingScore;
        volumeDetails.obvScore = cfg.obvRisingScore;
    } else if (indicators.obvTrend === 'falling') {
        volumeScore += cfg.obvFallingScore;
        volumeDetails.obvScore = cfg.obvFallingScore;
    }

    const volumes = indicators.volumes || [];
    if (volumes.length >= 2) {
        const lastVolume = volumes[volumes.length - 1];
        const recent = volumes.slice(-10);
        const avgVolume = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
        if (lastVolume > avgVolume) {
            volumeScore += cfg.volumeAboveAvgScore;
            volumeDetails.volumeMAScore = cfg.volumeAboveAvgScore;
        } else {
            volumeScore += cfg.volumeBelowAvgScore;
            volumeDetails.volumeMAScore = cfg.volumeBelowAvgScore;
        }
    }

    breakdown.VOLUME_ANALIZI = {
        score: volumeScore,
        weight: '15%',
        details: {
            'OBV Trend': `${indicators.obvTrend} → ${volumeDetails.obvScore > 0 ? '+' : ''}${volumeDetails.obvScore}`,
            'Volume vs Avg': `${volumeDetails.volumeMAScore > 0 ? 'Above Avg' : 'Below Avg'} → ${volumeDetails.volumeMAScore > 0 ? '+' : ''}${volumeDetails.volumeMAScore}`,
            'OBV Value': Number(indicators.obv || 0).toFixed(2)
        }
    };

    let srScore = 0;
    let srDetails = {
        supportProximity: 0,
        resistanceProximity: 0
    };

    if (indicators.resistance > 0 && indicators.support > 0 && indicators.price > 0) {
        const distanceToSupport = (indicators.price - indicators.support) / indicators.price;
        const distanceToResistance = (indicators.resistance - indicators.price) / indicators.price;
        const atrPct = indicators.atr > 0 ? indicators.atr / indicators.price : 0;
        const srThreshold = Math.min(cfg.srThresholdMax, Math.max(cfg.srThresholdMin, atrPct * cfg.srThresholdAtrMultiplier));

        if (distanceToSupport < srThreshold) {
            srScore += cfg.supportProximityScore;
            srDetails.supportProximity = cfg.supportProximityScore;
        }
        if (distanceToResistance < srThreshold) {
            srScore += cfg.resistanceProximityScore;
            srDetails.resistanceProximity = cfg.resistanceProximityScore;
        }

        breakdown.SUPPORT_RESISTANCE_ANALIZI = {
            score: srScore,
            weight: '15%',
            details: {
                'Support Proximity': `${(distanceToSupport * 100).toFixed(2)}% → ${srDetails.supportProximity > 0 ? '+' : ''}${srDetails.supportProximity}`,
                'Resistance Proximity': `${(distanceToResistance * 100).toFixed(2)}% → ${srDetails.resistanceProximity}`,
                'SR Threshold': `${(srThreshold * 100).toFixed(2)}%`,
                'Support Level': Number(indicators.support || 0).toFixed(8),
                'Resistance Level': Number(indicators.resistance || 0).toFixed(8),
                'Current Price': Number(indicators.price || 0).toFixed(8)
            }
        };
    }

    const normalizedTrendScore = (trendScore / 50) * 40;
    const normalizedMomentumScore = (momentumScore / 50) * 30;
    const normalizedVolumeScore = (volumeScore / 25) * 15;
    const normalizedSRScore = (srScore / 30) * 15;

    let score = normalizedTrendScore + normalizedMomentumScore + normalizedVolumeScore + normalizedSRScore;
    const direction = score > 0 ? 'LONG' : 'SHORT';
    const confidence = Math.min(Math.max(Math.abs(score), 0), 100);

    const isDowntrend = indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50;
    const isUptrend = indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50;
    const isAlignedTrend = isUptrend || isDowntrend;
    const trendBlocks = (direction === 'LONG' && isDowntrend) || (direction === 'SHORT' && isUptrend);

    const regimeBias = isUptrend ? 'LONG' : isDowntrend ? 'SHORT' : 'NEUTRAL';
    const strongRegime = regimeBias !== 'NEUTRAL' && indicators.adx >= cfg.strongRegimeAdx;
    const regimeBlocks = strongRegime && direction !== regimeBias;

    const bullishMomentumStack = indicators.rsi >= cfg.bullishMomentumRsi
        && indicators.macd >= 0
        && indicators.histogram >= 0
        && indicators.stoch.K >= indicators.stoch.D;
    const bearishMomentumStack = indicators.rsi <= cfg.bearishMomentumRsi
        && indicators.macd <= 0
        && indicators.histogram <= 0
        && indicators.stoch.K <= indicators.stoch.D;

    const momentumConflictBlocks = (direction === 'LONG' && bearishMomentumStack && indicators.adx >= cfg.momentumConflictAdx)
        || (direction === 'SHORT' && bullishMomentumStack && indicators.adx >= cfg.momentumConflictAdx);

    const choppyMarket = indicators.adx < cfg.choppyAdx && Math.abs((indicators.rsi || 50) - 50) < cfg.choppyRsiDelta;
    const requiredConfidence = choppyMarket ? Math.min(100, userConfidenceThreshold + cfg.choppyConfidenceBoost) : userConfidenceThreshold;

    const hasTrendOk = isAlignedTrend || indicators.adx >= cfg.hasTrendOrAdx;
    const triggered = confidence >= requiredConfidence
        && hasTrendOk
        && !trendBlocks
        && !regimeBlocks
        && !momentumConflictBlocks;

    breakdown.normalizedScore = {
        trend: normalizedTrendScore.toFixed(2),
        momentum: normalizedMomentumScore.toFixed(2),
        volume: normalizedVolumeScore.toFixed(2),
        sr: normalizedSRScore.toFixed(2),
        total: score.toFixed(2)
    };

    breakdown.signalFilters = {
        regimeBias,
        strongRegime,
        trendBlocks,
        regimeBlocks,
        momentumConflictBlocks,
        choppyMarket,
        requiredConfidence,
        threshold: userConfidenceThreshold
    };

    return {
        direction,
        score: Math.round(confidence),
        triggered,
        breakdown
    };
}

function getConfidenceLevel(score) {
    if (score >= 80) return 'HIGH';
    if (score >= 60) return 'MEDIUM_HIGH';
    if (score >= 40) return 'MEDIUM';
    if (score >= 20) return 'LOW_MEDIUM';
    return 'LOW';
}

function resolveKlineCloseTimeMs(kline) {
    const closeMs = Number(kline?.[6] ?? kline?.[0]);
    if (!Number.isFinite(closeMs)) return Date.now();
    return closeMs + 1;
}

function resolveKlineOpenTimeMs(kline) {
    const openMs = Number(kline?.[0]);
    if (!Number.isFinite(openMs)) return Date.now();
    return openMs + 1;
}

function resolveSameCandleHit(openPrice, takeProfit, stopLoss) {
    return 'SL';
}

async function fetchAggTradesRange(symbol, marketType, startMs, endMs, limit = 1000) {
    try {
        const safeStart = Math.max(0, Math.floor(Number(startMs) || 0));
        const safeEnd = Math.max(safeStart + 1, Math.floor(Number(endMs) || 0));
        const path = `/aggTrades?symbol=${symbol}&startTime=${safeStart}&endTime=${safeEnd}&limit=${limit}`;
        const response = await binanceFetchPath(marketType, path, {}, { retries: 2, timeoutMs: 15000 });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn('aggTrades fetch error:', error);
        return [];
    }
}

function detectFirstTouchFromTrades(trades, direction, takeProfit, stopLoss) {
    if (!Array.isArray(trades) || trades.length === 0) return null;

    for (const trade of trades) {
        const price = Number(trade?.p);
        if (!Number.isFinite(price)) continue;

        if (direction === 'LONG') {
            if (price <= stopLoss) return 'SL';
            if (price >= takeProfit) return 'TP';
        } else {
            if (price >= stopLoss) return 'SL';
            if (price <= takeProfit) return 'TP';
        }
    }

    return null;
}

async function resolveSameCandleFirstTouch(symbol, marketType, timeframe, barStartMs, barEndMs, direction, takeProfit, stopLoss, fallbackOpenPrice) {
    try {
        const tfMinutesMap = {
            '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
        };
        const tfMinutes = tfMinutesMap[String(timeframe || '1h')] || 60;
        const intrabarInterval = tfMinutes >= 240 ? '5m' : '1m';
        const intervalMinutes = intrabarInterval === '5m' ? 5 : 1;
        const safeStart = Math.max(0, Math.floor(Number(barStartMs) || 0));
        const safeEnd = Math.max(safeStart + 1, Math.floor(Number(barEndMs) || 0));
        const expectedBars = Math.min(1000, Math.max(1, Math.ceil((safeEnd - safeStart) / (intervalMinutes * 60 * 1000))));
        const klinesPath = `/klines?symbol=${symbol}&interval=${intrabarInterval}&startTime=${safeStart}&endTime=${safeEnd}&limit=${expectedBars}`;
        const response = await binanceFetchPath(marketType, klinesPath, {}, { retries: 2, timeoutMs: 15000 });
        if (response.ok) {
            const intrabarKlines = await response.json();
            if (Array.isArray(intrabarKlines) && intrabarKlines.length > 0) {
                for (const kline of intrabarKlines) {
                    const open = Number(kline?.[1]);
                    const high = Number(kline?.[2]);
                    const low = Number(kline?.[3]);
                    const subStart = Number(kline?.[0]);
                    const subEndRaw = Number(kline?.[6]);
                    const subEnd = Number.isFinite(subEndRaw) ? subEndRaw : (Number.isFinite(subStart) ? subStart + (intervalMinutes * 60 * 1000) : safeEnd);
                    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

                    if (direction === 'LONG') {
                        const hitSl = low <= stopLoss;
                        const hitTp = high >= takeProfit;
                        if (hitSl && hitTp) {
                            if (intrabarInterval === '1m') {
                                const trades = await fetchAggTradesRange(symbol, marketType, Math.max(safeStart, subStart), Math.min(safeEnd, subEnd));
                                const tradeTouch = detectFirstTouchFromTrades(trades, direction, takeProfit, stopLoss);
                                if (tradeTouch) return tradeTouch;
                            }
                            const fallbackOpen = Number.isFinite(open) ? open : fallbackOpenPrice;
                            return resolveSameCandleHit(fallbackOpen, takeProfit, stopLoss);
                        }
                        if (hitSl) return 'SL';
                        if (hitTp) return 'TP';
                    } else {
                        const hitSl = high >= stopLoss;
                        const hitTp = low <= takeProfit;
                        if (hitSl && hitTp) {
                            if (intrabarInterval === '1m') {
                                const trades = await fetchAggTradesRange(symbol, marketType, Math.max(safeStart, subStart), Math.min(safeEnd, subEnd));
                                const tradeTouch = detectFirstTouchFromTrades(trades, direction, takeProfit, stopLoss);
                                if (tradeTouch) return tradeTouch;
                            }
                            const fallbackOpen = Number.isFinite(open) ? open : fallbackOpenPrice;
                            return resolveSameCandleHit(fallbackOpen, takeProfit, stopLoss);
                        }
                        if (hitSl) return 'SL';
                        if (hitTp) return 'TP';
                    }
                }
            }
        }
    } catch (error) {
        console.warn('resolveSameCandleFirstTouch error:', error);
    }

    return resolveSameCandleHit(fallbackOpenPrice, takeProfit, stopLoss);
}

async function resolveBinanceServerTimeMs(marketType) {
    try {
        const response = await binanceFetchPath(marketType, '/time', {}, { retries: 2, timeoutMs: 15000 });
        const data = await response.json();
        const serverTime = Number(data?.serverTime);
        if (Number.isFinite(serverTime)) {
            return serverTime;
        }
    } catch (error) {
        console.warn('Binance server time fallback:', error);
    }
    return Date.now();
}

async function fetchBacktestKlines(symbol, timeframe, marketType, targetBars = 4000) {
    const MAX_BATCH_LIMIT = 1000;
    const safeTarget = Math.max(1, Math.min(Number(targetBars) || 1000, 4000));
    const collected = [];
    let endTime = null;

    while (collected.length < safeTarget) {
        const remaining = safeTarget - collected.length;
        const batchLimit = Math.max(1, Math.min(MAX_BATCH_LIMIT, remaining));
        const endTimeQuery = Number.isFinite(endTime) ? `&endTime=${Math.floor(endTime)}` : '';
        const klinesPath = `/klines?symbol=${symbol}&interval=${timeframe}&limit=${batchLimit}${endTimeQuery}`;
        const response = await binanceFetchPath(marketType, klinesPath, {}, { retries: 1, timeoutMs: 12000 });
        if (!response.ok) {
            console.warn(`⚠️ Backtest klines fetch failed: ${symbol} ${timeframe} HTTP ${response.status}`);
            break;
        }

        const batch = await response.json();
        if (!Array.isArray(batch) || batch.length === 0) break;

        for (let i = batch.length - 1; i >= 0; i--) {
            collected.push(batch[i]);
            if (collected.length >= safeTarget) break;
        }

        if (batch.length < batchLimit) break;
        const firstOpenMs = Number(batch[0]?.[0]);
        if (!Number.isFinite(firstOpenMs)) break;
        endTime = firstOpenMs - 1;
    }

    const dedupMap = new Map();
    for (const kline of collected) {
        const openMs = Number(kline?.[0]);
        if (Number.isFinite(openMs)) dedupMap.set(openMs, kline);
    }

    const merged = Array.from(dedupMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);

    return merged.slice(-safeTarget);
}

function resolveMinBacktestWindow(timeframe) {
    const tf = String(timeframe || '').trim().toLowerCase();
    if (tf === '1d') return 60;
    if (tf === '4h') return 80;
    return 100;
}

// 7. BACKTEST SİSTEMİ
async function runBacktest(symbol, timeframe, days = 30, confidenceThreshold = 70, takeProfitPercent = 5, stopLossPercent = 3, marketType = null, directionFilter = 'BOTH', slippageBps = null, feeBps = null, strategyConfig = null) {
    const results = [];
    console.log(`🔍 BACKTEST BAŞLADI: ${symbol} ${timeframe} | TP:${takeProfitPercent}% SL:${stopLossPercent}%`);
    const MIN_BACKTEST_WINDOW = resolveMinBacktestWindow(timeframe);
    
    // Timeframe'e göre gerekli kline sayısını hesapla
    const minutes = timeframeToMinutesBacktest(timeframe);
    const normalizedDirectionFilter = String(directionFilter || 'BOTH').toUpperCase();
    const resolvedSlippageBps = Number.isFinite(Number(slippageBps)) ? Number(slippageBps) : 0;
    const resolvedFeeBps = Number.isFinite(Number(feeBps)) ? Number(feeBps) : 0;
    const slippageBpsValue = Number.isFinite(resolvedSlippageBps) ? resolvedSlippageBps : 0;
    const feeBpsValue = Number.isFinite(resolvedFeeBps) ? resolvedFeeBps : 0;
    const neededKlines = 4000;
    
    try {
        const klines = await fetchBacktestKlines(symbol, timeframe, marketType, neededKlines);
        const trimmedKlines = Array.isArray(klines) ? klines.slice(-neededKlines) : [];
        const serverNowMs = await resolveBinanceServerTimeMs(marketType);
        const lastBarIndex = trimmedKlines.length - 1;
        let closedEndIndex = lastBarIndex;
        if (lastBarIndex >= 0) {
            const lastRawCloseMs = Number(trimmedKlines[lastBarIndex]?.[6] ?? trimmedKlines[lastBarIndex]?.[0]);
            const lastCloseMs = Number.isFinite(lastRawCloseMs)
                ? lastRawCloseMs
                : resolveKlineCloseTimeMs(trimmedKlines[lastBarIndex]);
            const closeLeadMs = lastCloseMs - serverNowMs;
            if (closeLeadMs > 2000) {
                closedEndIndex = lastBarIndex - 1;
            }
        }
        const hasLiveOpenBar = lastBarIndex > closedEndIndex;
        const liveOpenBar = hasLiveOpenBar ? trimmedKlines[lastBarIndex] : null;
        const backtestKlines = closedEndIndex >= 0
            ? trimmedKlines.slice(0, closedEndIndex + 1)
            : [];
        if (backtestKlines.length < MIN_BACKTEST_WINDOW + 1) {
            console.warn(`⚠️ Backtest için yetersiz kline: ${backtestKlines.length}`);
            return {
                totalTrades: 0,
                wins: 0,
                losses: 0,
                winRate: '0.00%',
                averageProfit: '0.00%',
                totalProfit: '0.00%',
                profitFactor: '0.00',
                trades: [],
                lastTrade: null,
                averages: {
                    LONG: { avgTPPercent: 5, avgSLPercent: -3 },
                    SHORT: { avgTPPercent: -5, avgSLPercent: 3 }
                },
                tickSize: 0.01,
                klines: backtestKlines,
                insufficientData: true,
                minRequiredBars: MIN_BACKTEST_WINDOW + 1
            };
        }

        const tickSize = await getSymbolTickSize(String(symbol || '').toUpperCase(), marketType);
        const safeTick = Number.isFinite(tickSize) && Number(tickSize) > 0 ? Number(tickSize) : 0.01;
        
        // Şu anki açık bar'ı ekle (manuel olarak) - TÜRKİYE SAATİNE GÖRE
        // ⚠️ AÇIK BAR'NIN HIGH/LOW VERİSİ EKSIK OLDUĞU İÇİN BACKTESTE KATMIYORUZ
        // Sadece grafikte gösterim amacıyla klines'e eklenir
        // const nowMs = Date.now();
        // const turkeyOffsetMs = 3 * 60 * 60 * 1000; // UTC+3
        // const nowTurkeyMs = nowMs + turkeyOffsetMs;
        
        // AÇIK BAR EKLEME DEVRE DIŞI - HIGH/LOW verisi hatalı
        /*
        const timeframeMinutes = {
            '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
        };
        const minutes = timeframeMinutes[timeframe] || 60;
        
        // Bar açılma zamanını Türkiye saatine göre hesapla
        const msPerBar = minutes * 60 * 1000;
        const barOpenTime = Math.floor(nowTurkeyMs / msPerBar) * msPerBar - turkeyOffsetMs; // UTC'ye geri çevir
        
        // Son kapanmış bar'ı al
        const lastClosedBar = klines[klines.length - 1];
        const openPrice = lastClosedBar[1];
        
        // Şu anki fiyat (ayrıca çekmeliyiz)
        const tickerUrl = `${window.getBinanceApiBase ? window.getBinanceApiBase() : "https://api.binance.com/api/v3"}/ticker/price?symbol=${symbol}`;
        const tickerRes = await fetch(tickerUrl);
        const tickerData = await tickerRes.json();
        const currentPrice = parseFloat(tickerData.price);
        
        // Açık bar verisi
        const openBar = [
            barOpenTime,              // [0] timestamp (UTC)
            openPrice,                // [1] open
            currentPrice,             // [2] high
            currentPrice,             // [3] low
            currentPrice,             // [4] close
            '0',                      // [5] volume
            barOpenTime + msPerBar,   // [6] close time
            '0',                      // [7] quote volume
            0,                        // [8] taker buy base
            0,                        // [9] taker buy quote
            '0'                       // [10] ignore
        ];
        
        // Açık bar'ı ekle
        klines.push(openBar);
        */
        
        const opens = backtestKlines.map(k => parseFloat(k[1]));
        const closes = backtestKlines.map(k => parseFloat(k[4]));
        const highs = backtestKlines.map(k => parseFloat(k[2]));
        const lows = backtestKlines.map(k => parseFloat(k[3]));
        const volumes = backtestKlines.map(k => parseFloat(k[5]));
        const EDGE_PARITY_INDICATOR_KLINES_LIMIT = 300;
        const indicatorWindowSize = Math.min(EDGE_PARITY_INDICATOR_KLINES_LIMIT, closes.length - 1);
        if (indicatorWindowSize < MIN_BACKTEST_WINDOW) {
            console.warn(`⚠️ Backtest window çok küçük: ${indicatorWindowSize}`);
            return results;
        }
        
        // Sliding window ile backtest
        let wins = 0;
        let losses = 0;
        let totalProfit = 0;
        let totalWinProfit = 0;
        let totalLossProfit = 0;
        
        // AÇIK İŞLEM TRACKING
        let openTrade = null;  // Şu anda açık olan işlem
        let openTradeEntryBar = -1;  // Açık işlemin giriş bar'ı
        const activeSignalDirections = new Set();
        
        // Her bar kontrol edilsin (SON AÇIK BAR HARIÇ - incomplete data)
        for (let i = MIN_BACKTEST_WINDOW; i <= closes.length - 1; i++) {
            
            // ============================================
            // ADIM 1: AÇIK İŞLEM KONTROLÜ VE KAPATMA
            // ============================================
            if (openTrade !== null) {
                // Açık işlem var - kapatma koşullarını kontrol et
                const barsSinceEntry = i - openTradeEntryBar;
                const currentHigh = highs[i];
                const currentLow = lows[i];
                let shouldClose = false;
                let closeReason = null;
                
                // Debug: Her 10 bar'da bir kontrol yap
                if (barsSinceEntry > 0 && barsSinceEntry % 10 === 0) {
                    console.log(`📍 [${timeframe}] Bar ${i}: entry=${openTradeEntryBar} barsSince=${barsSinceEntry} close=${closes[i].toFixed(4)} TP=${openTrade.takeProfit.toFixed(4)} SL=${openTrade.stopLoss.toFixed(4)}`);
                }
                
                if (openTrade.signal === 'LONG') {  // ✅ .direction yerine .signal
                    // LONG işlem
                    const hitSl = currentLow <= openTrade.stopLoss;
                    const hitTp = currentHigh >= openTrade.takeProfit;

                    if (hitSl && hitTp) {
                        const resolvedHit = await resolveSameCandleFirstTouch(
                            symbol,
                            marketType,
                            timeframe,
                            Number(backtestKlines[i]?.[0]),
                            Number(backtestKlines[i]?.[6]),
                            openTrade.signal,
                            openTrade.takeProfit,
                            openTrade.stopLoss,
                            Number(opens[i])
                        );
                        if (resolvedHit === 'TP') {
                            if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                                console.log(`🎯 LONG [${timeframe}] SAME BAR TP HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= TP=${openTrade.takeProfit.toFixed(4)}`);
                            }
                            const exitRaw = applySlippage(openTrade.takeProfit, 'SELL', slippageBpsValue);
                            openTrade.exit = roundToTick(exitRaw, safeTick);
                            openTrade.actualTP = true;
                            closeReason = 'TP';
                        } else {
                            if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                                console.log(`🎯 LONG [${timeframe}] SAME BAR SL HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= SL=${openTrade.stopLoss.toFixed(4)}`);
                            }
                            const exitRaw = applySlippage(openTrade.stopLoss, 'SELL', slippageBpsValue);
                            openTrade.exit = roundToTick(exitRaw, safeTick);
                            openTrade.actualSL = true;
                            closeReason = 'SL';
                        }
                        openTrade.exitBarIndex = i;
                        shouldClose = true;
                    } else if (hitSl) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 LONG [${timeframe}] SL HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= SL=${openTrade.stopLoss.toFixed(4)}`);
                        }
                        const exitRaw = applySlippage(openTrade.stopLoss, 'SELL', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.exitBarIndex = i;
                        openTrade.actualSL = true;
                        shouldClose = true;
                        closeReason = 'SL';
                    } else if (hitTp) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 LONG [${timeframe}] TP HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= TP=${openTrade.takeProfit.toFixed(4)}`);
                        }
                        const exitRaw = applySlippage(openTrade.takeProfit, 'SELL', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.exitBarIndex = i;
                        openTrade.actualTP = true;
                        shouldClose = true;
                        closeReason = 'TP';
                    }
                } else {
                    // SHORT işlem
                    const hitSl = currentHigh >= openTrade.stopLoss;
                    const hitTp = currentLow <= openTrade.takeProfit;

                    if (hitSl && hitTp) {
                        const resolvedHit = await resolveSameCandleFirstTouch(
                            symbol,
                            marketType,
                            timeframe,
                            Number(backtestKlines[i]?.[0]),
                            Number(backtestKlines[i]?.[6]),
                            openTrade.signal,
                            openTrade.takeProfit,
                            openTrade.stopLoss,
                            Number(opens[i])
                        );
                        if (resolvedHit === 'TP') {
                            if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                                console.log(`🎯 SHORT [${timeframe}] SAME BAR TP HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= TP=${openTrade.takeProfit.toFixed(4)}`);
                            }
                            const exitRaw = applySlippage(openTrade.takeProfit, 'BUY', slippageBpsValue);
                            openTrade.exit = roundToTick(exitRaw, safeTick);
                            openTrade.actualTP = true;
                            closeReason = 'TP';
                        } else {
                            if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                                console.log(`🎯 SHORT [${timeframe}] SAME BAR SL HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= SL=${openTrade.stopLoss.toFixed(4)}`);
                            }
                            const exitRaw = applySlippage(openTrade.stopLoss, 'BUY', slippageBpsValue);
                            openTrade.exit = roundToTick(exitRaw, safeTick);
                            openTrade.actualSL = true;
                            closeReason = 'SL';
                        }
                        openTrade.exitBarIndex = i;
                        shouldClose = true;
                    } else if (hitSl) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 SHORT [${timeframe}] SL HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= SL=${openTrade.stopLoss.toFixed(4)}`);
                        }
                        const exitRaw = applySlippage(openTrade.stopLoss, 'BUY', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.exitBarIndex = i;
                        openTrade.actualSL = true;
                        shouldClose = true;
                        closeReason = 'SL';
                    } else if (hitTp) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 SHORT [${timeframe}] TP HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= TP=${openTrade.takeProfit.toFixed(4)}`);
                        }
                        const exitRaw = applySlippage(openTrade.takeProfit, 'BUY', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.exitBarIndex = i;
                        openTrade.actualTP = true;
                        shouldClose = true;
                        closeReason = 'TP';
                    }
                }
                
                // İşlemi kapat
                if (shouldClose) {
                    // Kar/Zarar hesapla
                    let profit = 0;
                    if (openTrade.signal === 'LONG') {  // ✅ .direction yerine .signal kullan
                        profit = ((openTrade.exit - openTrade.entry) / openTrade.entry) * 100;
                    } else {
                        profit = ((openTrade.entry - openTrade.exit) / openTrade.entry) * 100;
                    }
                    const feePct = (feeBpsValue * 2) / 100;
                    profit -= feePct;
                    
                    // KAPALANMIŞ İŞLEM - Yeni object oluştur (reference problemi önle)
                    const barCount = openTrade.exitBarIndex - openTrade.barIndex;
                    let durationFormatted = '';
                    
                    if (barCount === 0) {
                        durationFormatted = 'Aynı bar';
                    } else {
                        durationFormatted = barCount + ' bar';
                    }
                    
                    const closedTrade = {
                        ...openTrade,
                        profit: profit,  // Number olarak
                        isOpen: false,   // KESIN FALSE
                        duration: durationFormatted,  // "2s 30d" veya "45d" format
                        closeReason: closeReason  // ✅ DEBUG: TP/SL?
                    };
                    
                    // İstatistikleri güncelle
                    if (profit > 0) {
                        wins++;
                        totalWinProfit += profit;
                    } else {
                        losses++;
                        totalLossProfit += profit;
                    }
                    totalProfit += profit;
                    
                    console.log(`❌ İŞLEM KAPANDI [${timeframe}] bar=${i} ${openTrade.signal} barsSince=${barsSinceEntry} duration=${durationFormatted} exit=${openTrade.exit.toFixed(4)} profit=${profit.toFixed(2)}% reason=${closeReason}`);
                    
                    // Results'a ekle (kapalı işlem)
                    results.push(closedTrade);
                    if (openTrade && openTrade.signal) {
                        activeSignalDirections.delete(`${symbol.toUpperCase()}:${openTrade.signal}`);
                    }
                    openTrade = null;
                    openTradeEntryBar = -1;
                    
                    // İŞLEM KAPANDI - Bu bar'da yeni işlem AÇMA, sonraki bar'a geç!
                    continue;
                }
                
                // Hala açık işlem varsa yeni işlem AÇMA
                if (openTrade !== null) {
                    continue;  // ADIM 2'ye gitme, sonraki bar'a geç
                }
            }
            
            // ============================================
            // ADIM 2: YENİ SİNYAL KONTROLÜ
            // ============================================
            
            const windowStart = Math.max(0, i - indicatorWindowSize);
            const windowCloses = closes.slice(windowStart, i);
            const windowHighs = highs.slice(windowStart, i);
            const windowLows = lows.slice(windowStart, i);
            const windowVolumes = volumes.slice(windowStart, i);
            
            const indicators = calculateAlarmIndicators(windowCloses, windowHighs, windowLows, windowVolumes);
            if (!indicators) {
                continue;
            }

            const signal = generateSignalScoreAligned(indicators, confidenceThreshold, strategyConfig);
            if (normalizedDirectionFilter !== 'BOTH' && normalizedDirectionFilter !== signal.direction) {
                continue;
            }

            const lastOpenMs = resolveKlineOpenTimeMs(backtestKlines[i]);
            const nowMs = lastOpenMs + 1;
            const timeframeMs = minutes * 60 * 1000;
            const barStartMs = Number.isFinite(lastOpenMs) ? lastOpenMs : 0;
            const barEndMs = barStartMs + (Number.isFinite(timeframeMs) && timeframeMs > 0 ? timeframeMs : 60 * 60 * 1000);
            const isWithinOpenWindow = nowMs >= barStartMs && nowMs < barEndMs;
            if (!isWithinOpenWindow) {
                continue;
            }
            const directionKey = `${symbol.toUpperCase()}:${signal.direction}`;
            if (activeSignalDirections.has(directionKey)) {
                continue;
            }

            const shouldOpenTrade = signal && signal.triggered;
            
            // DEBUG: Log ekle
            if (i < MIN_BACKTEST_WINDOW + 5 || i > closes.length - 10) {
                const entryPriceDebug = opens[i];
                const tpDebug = signal.direction === 'SHORT'
                    ? entryPriceDebug * (1 - takeProfitPercent / 100)
                    : entryPriceDebug * (1 + takeProfitPercent / 100);
                const slDebug = signal.direction === 'SHORT'
                    ? entryPriceDebug * (1 + stopLossPercent / 100)
                    : entryPriceDebug * (1 - stopLossPercent / 100);
                console.log(`🔄 [${timeframe}] bar=${i} signal=${signal.direction} score=${signal.score} TP=${tpDebug.toFixed(4)} SL=${slDebug.toFixed(4)} shouldOpen=${shouldOpenTrade}`);
            }
            
            if (!shouldOpenTrade) {
                continue;
            }
            
            // ✅ SON BAR'DA DA İŞLEM AÇILABILSIN (futures için önemli - çoğu zaman son bar'da signal)
            // Eski kod: if (i === closes.length - 1) continue;  // Bu son bar'ı engelliyor
            
            // ============================================
            // ADIM 3: YENİ İŞLEM AÇ
            // ============================================
            
            const entrySide = signal.direction === 'SHORT' ? 'SELL' : 'BUY';
            const entryRaw = applySlippage(opens[i], entrySide, slippageBpsValue);
            const entryPrice = roundToTick(entryRaw, safeTick);
            const rawTakeProfit = signal.direction === 'SHORT'
                ? entryPrice * (1 - takeProfitPercent / 100)
                : entryPrice * (1 + takeProfitPercent / 100);
            const rawStopLoss = signal.direction === 'SHORT'
                ? entryPrice * (1 + stopLossPercent / 100)
                : entryPrice * (1 - stopLossPercent / 100);
            const takeProfit = roundToTick(rawTakeProfit, safeTick);
            const stopLoss = roundToTick(rawStopLoss, safeTick);
            
            // Tarih ve saat (Türkiye saati)
            const signalBarIndex = Math.max(0, i - 1);
            const tradeTimestampRaw = resolveKlineCloseTimeMs(backtestKlines[signalBarIndex]);
            const tradeTimestamp = Number.isFinite(tradeTimestampRaw)
                ? Math.min(tradeTimestampRaw, serverNowMs)
                : serverNowMs;
            const tradeDate = new Date(tradeTimestamp);
            const tradeTime = tradeDate.toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Istanbul'
            });
            const turkeyDate = tradeDate;
            
            // TP/SL yüzdeleri
            const tpPercent = ((takeProfit - entryPrice) / entryPrice) * 100;
            const slPercent = ((stopLoss - entryPrice) / entryPrice) * 100;
            
            // Açık işlemi oluştur
            openTrade = {
                timestamp: tradeTimestamp,
                barIndex: i,
                exitBarIndex: i,
                date: turkeyDate.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }),
                time: tradeTime,
                signal: signal.direction,
                entry: entryPrice,
                exit: entryPrice,
                takeProfit: takeProfit,
                stopLoss: stopLoss,
                profit: 0,
                score: signal.score,
                duration: 'AKTİF',
                actualTP: false,
                actualSL: false,
                tpPercent: parseFloat(tpPercent.toFixed(2)),
                slPercent: parseFloat(slPercent.toFixed(2)),
                isOpen: true
            };

            activeSignalDirections.add(directionKey);
            
            openTradeEntryBar = i;
            console.log(`✅ YENİ İŞLEM AÇILDI [${timeframe}] bar=${i} ${signal.direction} entry=${entryPrice.toFixed(4)} TP=${takeProfit.toFixed(4)} SL=${stopLoss.toFixed(4)}`);

            // ENTRY BAR TP/SL KONTROLÜ
            const entryBarHigh = highs[i];
            const entryBarLow = lows[i];
            let closeOnEntryBar = false;
            let entryCloseReason = null;

            if (openTrade.signal === 'LONG') {
                const hitSl = entryBarLow <= openTrade.stopLoss;
                const hitTp = entryBarHigh >= openTrade.takeProfit;

                if (hitSl && hitTp) {
                    const resolvedHit = await resolveSameCandleFirstTouch(
                        symbol,
                        marketType,
                        timeframe,
                        Number(backtestKlines[i]?.[0]),
                        Number(backtestKlines[i]?.[6]),
                        openTrade.signal,
                        openTrade.takeProfit,
                        openTrade.stopLoss,
                        Number(opens[i])
                    );
                    if (resolvedHit === 'TP') {
                        const exitRaw = applySlippage(openTrade.takeProfit, 'SELL', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.actualTP = true;
                        entryCloseReason = 'TP';
                    } else {
                        const exitRaw = applySlippage(openTrade.stopLoss, 'SELL', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.actualSL = true;
                        entryCloseReason = 'SL';
                    }
                    closeOnEntryBar = true;
                } else if (hitSl) {
                    const exitRaw = applySlippage(openTrade.stopLoss, 'SELL', slippageBpsValue);
                    openTrade.exit = roundToTick(exitRaw, safeTick);
                    openTrade.actualSL = true;
                    entryCloseReason = 'SL';
                    closeOnEntryBar = true;
                } else if (hitTp) {
                    const exitRaw = applySlippage(openTrade.takeProfit, 'SELL', slippageBpsValue);
                    openTrade.exit = roundToTick(exitRaw, safeTick);
                    openTrade.actualTP = true;
                    entryCloseReason = 'TP';
                    closeOnEntryBar = true;
                }
            } else {
                const hitSl = entryBarHigh >= openTrade.stopLoss;
                const hitTp = entryBarLow <= openTrade.takeProfit;

                if (hitSl && hitTp) {
                    const resolvedHit = await resolveSameCandleFirstTouch(
                        symbol,
                        marketType,
                        timeframe,
                        Number(backtestKlines[i]?.[0]),
                        Number(backtestKlines[i]?.[6]),
                        openTrade.signal,
                        openTrade.takeProfit,
                        openTrade.stopLoss,
                        Number(opens[i])
                    );
                    if (resolvedHit === 'TP') {
                        const exitRaw = applySlippage(openTrade.takeProfit, 'BUY', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.actualTP = true;
                        entryCloseReason = 'TP';
                    } else {
                        const exitRaw = applySlippage(openTrade.stopLoss, 'BUY', slippageBpsValue);
                        openTrade.exit = roundToTick(exitRaw, safeTick);
                        openTrade.actualSL = true;
                        entryCloseReason = 'SL';
                    }
                    closeOnEntryBar = true;
                } else if (hitSl) {
                    const exitRaw = applySlippage(openTrade.stopLoss, 'BUY', slippageBpsValue);
                    openTrade.exit = roundToTick(exitRaw, safeTick);
                    openTrade.actualSL = true;
                    entryCloseReason = 'SL';
                    closeOnEntryBar = true;
                } else if (hitTp) {
                    const exitRaw = applySlippage(openTrade.takeProfit, 'BUY', slippageBpsValue);
                    openTrade.exit = roundToTick(exitRaw, safeTick);
                    openTrade.actualTP = true;
                    entryCloseReason = 'TP';
                    closeOnEntryBar = true;
                }
            }

            if (closeOnEntryBar) {
                openTrade.exitBarIndex = i;
                let profit = 0;
                if (openTrade.signal === 'LONG') {
                    profit = ((openTrade.exit - openTrade.entry) / openTrade.entry) * 100;
                } else {
                    profit = ((openTrade.entry - openTrade.exit) / openTrade.entry) * 100;
                }
                const feePct = (feeBpsValue * 2) / 100;
                profit -= feePct;

                const closedTrade = {
                    ...openTrade,
                    profit: profit,
                    isOpen: false,
                    duration: 'Aynı bar',
                    closeReason: entryCloseReason
                };

                if (profit > 0) {
                    wins++;
                    totalWinProfit += profit;
                } else {
                    losses++;
                    totalLossProfit += profit;
                }
                totalProfit += profit;

                results.push(closedTrade);
                activeSignalDirections.delete(directionKey);
                console.log(`❌ ENTRY BAR KAPANIŞ [${timeframe}] bar=${i} ${openTrade.signal} profit=${profit.toFixed(2)}% reason=${entryCloseReason}`);
                openTrade = null;
                openTradeEntryBar = -1;
                continue;
            }
        }
        
        // ============================================
        // ADIM 4: DÖNGÜ BİTTİKTEN SONRA AÇIK İŞLEM KONTROLÜ
        // ============================================
        
        console.log(`📊 [${timeframe}] Backtest döngü bitti: totalTrades=${results.length}, openTrade=${openTrade ? 'var' : 'yok'}, wins=${wins}, losses=${losses}, totalProfit=${totalProfit.toFixed(2)}%`);
        
        // Eğer hala açık işlem varsa açık bırak
        let lastOpenTradeFromBacktest = null;
        if (openTrade !== null) {
            lastOpenTradeFromBacktest = {
                ...openTrade,
                profit: 0,
                isOpen: true,
                duration: 'AKTİF'
            };
        }
        
        // ============================================
        // ADIM 5: RESULTS'I TARİH'E GÖRE SIRALA (EN YENİ ÖN)
        // ============================================
        
        results.sort((a, b) => b.timestamp - a.timestamp);
        
        // ============================================
        // ADIM 6: İSTATİSTİKLER VE PROFIT'LER
        // ============================================
        
        // Sadece kapalı işlemler için istatistikleri hesapla
        const closedTrades = results.filter(t => !t.isOpen);
        
        // Kapalı işlemlerin profit'ini yeniden hesapla (format'sız number olarak)
        wins = 0;
        losses = 0;
        totalProfit = 0;
        totalWinProfit = 0;
        totalLossProfit = 0;
        
        closedTrades.forEach(trade => {
            // Profit string'den number'a çevir
            let profitValue = parseFloat(trade.profit);
            
            if (profitValue > 0) {
                wins++;
                totalWinProfit += profitValue;
            } else if (profitValue < 0) {
                losses++;
                totalLossProfit += profitValue;
            }
            totalProfit += profitValue;
        });
        
        const totalTrades = closedTrades.length;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const avgProfit = totalTrades > 0 ? totalProfit / totalTrades : 0;
        
        // Profit Factor hesaplaması: (Toplam kazanan trades kar) / (Abs toplam kaybeden trades zarar)
        let profitFactor = 0;
        if (Math.abs(totalLossProfit) > 0) {
            profitFactor = totalWinProfit / Math.abs(totalLossProfit);
        } else if (totalWinProfit > 0) {
            profitFactor = totalWinProfit;
        }
        
        // LONG/SHORT ayrı TP/SL ortalamaları hesapla
        const longTrades = results.filter(t => t.signal === 'LONG');
        const shortTrades = results.filter(t => t.signal === 'SHORT');
        
        const longAverages = {
            avgTPPercent: longTrades.length > 0 ? 
                longTrades.reduce((sum, t) => sum + t.tpPercent, 0) / longTrades.length : 5,
            avgSLPercent: longTrades.length > 0 ? 
                longTrades.reduce((sum, t) => sum + t.slPercent, 0) / longTrades.length : -3
        };
        
        const shortAverages = {
            avgTPPercent: shortTrades.length > 0 ? 
                shortTrades.reduce((sum, t) => sum + t.tpPercent, 0) / shortTrades.length : -5,
            avgSLPercent: shortTrades.length > 0 ? 
                shortTrades.reduce((sum, t) => sum + t.slPercent, 0) / shortTrades.length : 3
        };
        
        // SON BAR (grafikle senkronizasyon için) - TAM OLARAK SON BAR İÇİN SİNYAL
        let lastTrade = null;
        try {
            // Son barı kontrol et, bar açılışı için bir önceki bar verileriyle sinyal üret
            const lastBarIndex = closes.length - 1;
            const closedBarIndex = hasLiveOpenBar ? closes.length : lastBarIndex;
            const signalBarIndex = closedBarIndex - 1;
            if (signalBarIndex >= MIN_BACKTEST_WINDOW) {
                const lastWindowStart = Math.max(0, closedBarIndex - indicatorWindowSize);
                const lastWindowCloses = closes.slice(lastWindowStart, closedBarIndex);
                const lastWindowHighs = highs.slice(lastWindowStart, closedBarIndex);
                const lastWindowLows = lows.slice(lastWindowStart, closedBarIndex);
                const lastWindowVolumes = volumes.slice(lastWindowStart, closedBarIndex);

                const lastIndicators = calculateAlarmIndicators(lastWindowCloses, lastWindowHighs, lastWindowLows, lastWindowVolumes);
                if (lastIndicators) {
                    const lastSignal = generateSignalScoreAligned(lastIndicators, confidenceThreshold);
                    const lastDirectionOk = normalizedDirectionFilter === 'BOTH' || normalizedDirectionFilter === lastSignal.direction;
                    const entryBarForLastSignal = hasLiveOpenBar
                        ? liveOpenBar
                        : backtestKlines[closedBarIndex];
                    const lastOpenMs = resolveKlineOpenTimeMs(entryBarForLastSignal);
                    const lastNowMs = lastOpenMs + 1;
                    const lastTimeframeMs = minutes * 60 * 1000;
                    const lastBarStartMs = Number.isFinite(lastOpenMs) ? lastOpenMs : 0;
                    const lastBarEndMs = lastBarStartMs + (Number.isFinite(lastTimeframeMs) && lastTimeframeMs > 0 ? lastTimeframeMs : 60 * 60 * 1000);
                    const lastWithinOpenWindow = lastNowMs >= lastBarStartMs && lastNowMs < lastBarEndMs;

                    // SADECE triggered true olan sinyalleri göster (confidence threshold gecenler)
                    if (lastSignal && lastSignal.triggered && lastDirectionOk && lastWithinOpenWindow) {
                // ÖNEMLİ: Son kapalı işlem ile lastTrade arasında çakışma var mı kontrol et
                // Eğer son işlem belirsiz durumdaysa (0% profit, actualTP=false, actualSL=false), 
                // yeni sinyal gösterme
                let canShowLastTrade = true;
                
                if (results.length > 0) {
                    const lastClosedTrade = results[results.length - 1];  // En eski (ilk) trade
                    // Aslında results sort'lanmamış, tarih sırasında olması gerek
                    // Ama burada gerçek kapalı işlemler var (TP/SL hit olanlar)
                    
                    // Eğer son işlem 0% profit ise, bu "phantom close"
                    const lastProfitStr = lastClosedTrade.profit || '0%';
                    const lastProfitValue = parseFloat(lastProfitStr);
                    
                    // Eğer 0% profit ve ne actualTP ne de actualSL ise, bu açık işlem anlamında
                    if (Math.abs(lastProfitValue) < 0.01 && !lastClosedTrade.actualTP && !lastClosedTrade.actualSL) {
                        // Bu "phantom close", yeni sinyal gösterme
                        canShowLastTrade = false;
                        console.log('Phantom close detected:', {
                            profit: lastProfitValue,
                            actualTP: lastClosedTrade.actualTP,
                            actualSL: lastClosedTrade.actualSL,
                            signal: lastClosedTrade.signal
                        });
                    }
                }
                
                if (canShowLastTrade) {
                    const lastSignalBarIndex = Math.max(0, signalBarIndex);
                    const lastBarTimestampRaw = resolveKlineCloseTimeMs(backtestKlines[lastSignalBarIndex]);
                    const lastBarTimestamp = Number.isFinite(lastBarTimestampRaw)
                        ? Math.min(lastBarTimestampRaw, serverNowMs)
                        : serverNowMs;
                    const lastBarTimeUTC = new Date(lastBarTimestamp);
                    const lastTimeStr = lastBarTimeUTC.toLocaleTimeString('tr-TR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'Europe/Istanbul'
                    });
                    
                    const lastBarDateTurkey = new Date(lastBarTimestamp);
                    
                    const lastEntrySide = lastSignal.direction === 'SHORT' ? 'SELL' : 'BUY';
                    const entryOpenPrice = hasLiveOpenBar
                        ? Number(liveOpenBar?.[1])
                        : Number(opens[closedBarIndex]);
                    const safeEntryOpenPrice = Number.isFinite(entryOpenPrice)
                        ? entryOpenPrice
                        : Number(closes[lastSignalBarIndex]);
                    const lastEntryRaw = applySlippage(safeEntryOpenPrice, lastEntrySide, slippageBpsValue);
                    const lastEntryPrice = roundToTick(lastEntryRaw, safeTick);
                    const lastTakeProfitRaw = lastSignal.direction === 'SHORT'
                        ? lastEntryPrice * (1 - takeProfitPercent / 100)
                        : lastEntryPrice * (1 + takeProfitPercent / 100);
                    const lastStopLossRaw = lastSignal.direction === 'SHORT'
                        ? lastEntryPrice * (1 + stopLossPercent / 100)
                        : lastEntryPrice * (1 - stopLossPercent / 100);
                    const lastTakeProfit = roundToTick(lastTakeProfitRaw, safeTick);
                    const lastStopLoss = roundToTick(lastStopLossRaw, safeTick);

                    // Kar/Zarar hesapla
                    let lastTradeProfit = 0;
                    const lastExitSide = lastSignal.direction === 'SHORT' ? 'BUY' : 'SELL';
                    const markPrice = hasLiveOpenBar
                        ? Number(liveOpenBar?.[4] ?? liveOpenBar?.[1])
                        : Number(closes[lastBarIndex]);
                    const safeMarkPrice = Number.isFinite(markPrice) ? markPrice : lastEntryPrice;
                    const lastExitRaw = applySlippage(safeMarkPrice, lastExitSide, slippageBpsValue);
                    const lastExitPrice = roundToTick(lastExitRaw, safeTick);
                    if (lastSignal.direction === 'LONG') {
                        lastTradeProfit = ((lastExitPrice - lastEntryPrice) / lastEntryPrice) * 100;
                    } else {
                        lastTradeProfit = ((lastEntryPrice - lastExitPrice) / lastEntryPrice) * 100;
                    }
                    const lastFeePct = (feeBpsValue * 2) / 100;
                    lastTradeProfit -= lastFeePct;
                    
                    lastTrade = {
                        timestamp: lastBarTimestamp,
                        barIndex: closedBarIndex,  // Kapalı bar'ı işaret et
                        date: lastBarDateTurkey.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }),
                        time: lastTimeStr,
                        signal: lastSignal.direction,
                        entry: lastEntryPrice,
                        exit: closes[lastBarIndex],
                        takeProfit: lastTakeProfit,
                        stopLoss: lastStopLoss,
                        profit: lastTradeProfit,  // Kar/Zarar (number)
                        score: lastSignal.score,
                        duration: 'AÇIK',  // Son bar'da yeni açılan işlem
                        isOpen: true,  // Bu AÇIK işlem
                        actualTP: false,  // Henüz TP vurmadı
                        actualSL: false   // Henüz SL vurmadı
                    };
                }
                    }
                }
            }
        } catch (error) {
            console.warn('Last bar signal calculation error:', error);
        }
        
        // Tüm işlemleri (lastTrade + results) tarih sırasına göre sort et - YENİ EN BAŞTA
        let allTrades = results;
        
        // ⚠️ ÖNEMLİ: Eğer backtest'in sonunda AÇIK işlem varsa, o HERŞEYİ GEÇER!
        // Signal'tan gelen lastTrade'i kaldır, yerine lastOpenTradeFromBacktest'i kullan
        if (lastOpenTradeFromBacktest && (lastOpenTradeFromBacktest.duration === 'AÇIK' || lastOpenTradeFromBacktest.isOpen === true)) {
            lastTrade = lastOpenTradeFromBacktest; // Kesin olarak set et
            console.log('🔴 BACKTEST AÇIK İŞLEM VAR - Signal\'den gelen işlem çıkarılıyor');
        } else if (lastOpenTradeFromBacktest && lastTrade === null) {
            // Backtest açık işlem var ama durum açık değilse, lastTrade null ise kullan
            lastTrade = lastOpenTradeFromBacktest;
        }
        
        if (lastTrade) {
            allTrades = [lastTrade, ...results];
        }
        
        // En yeni en başta olacak şekilde sort et
        allTrades.sort((a, b) => {
            const timeA = new Date(a.timestamp).getTime();
            const timeB = new Date(b.timestamp).getTime();
            return timeB - timeA; // B > A ise B önce (yeni en başta)
        });
        
        // Eğer lastTrade hala null ise, SİRALANMIŞ allTrades listesinden SON açık işlemi bul
        // (allTrades zaten yeni en başta sıralanmış)
        if (!lastTrade && allTrades.length > 0) {
            // allTrades'in başından (en yeni) arayarak ilk açık işlemi bul = EN SON açık işlem
            const openTrade = allTrades.find(t => t.duration === 'AÇIK' || t.isOpen === true);
            if (openTrade) {
                lastTrade = openTrade;
                console.log(`🔴 EN SON AÇIK İŞLEM (SIRALANMIS LISTEDEN) BULUNDU:`, {
                    signal: openTrade.signal,
                    entry: openTrade.entry,
                    time: openTrade.time,
                    date: openTrade.date,
                    duration: openTrade.duration
                });
            }
        }
        
        return {
            totalTrades: totalTrades,
            wins: wins,
            losses: losses,
            winRate: winRate.toFixed(2) + '%',
            averageProfit: avgProfit.toFixed(2) + '%',
            totalProfit: totalProfit.toFixed(2) + '%',
            profitFactor: profitFactor.toFixed(2),
            trades: allTrades.slice(0, 500), // Tarih sırasıyla en yeni en başta, max 500 işlem
            lastTrade: lastTrade,  // Son işlem (senkronizasyon için)
            averages: {
                LONG: {
                    avgTPPercent: parseFloat(longAverages.avgTPPercent.toFixed(2)),
                    avgSLPercent: parseFloat(longAverages.avgSLPercent.toFixed(2))
                },
                SHORT: {
                    avgTPPercent: parseFloat(shortAverages.avgTPPercent.toFixed(2)),
                    avgSLPercent: parseFloat(shortAverages.avgSLPercent.toFixed(2))
                }
            },
            tickSize: safeTick,
            klines: klines  // Klines verisini de döndür
        };
        
    } catch (error) {
        console.error('Backtest error:', error);
        return null;
    }
}

// 8. AI/ML TAHMİN (TensorFlow.js ile)
async function createPredictionModel() {
    const model = tf.sequential();
    
    model.add(tf.layers.lstm({
        units: 50,
        returnSequences: true,
        inputShape: [10, 1]
    }));
    
    model.add(tf.layers.lstm({
        units: 50,
        returnSequences: false
    }));
    
    model.add(tf.layers.dense({
        units: 1
    }));
    
    model.compile({
        optimizer: 'adam',
        loss: 'meanSquaredError'
    });
    
    return model;
}

async function predictNextPrice(prices) {
    try {
        // Basit lineer regression ile tahmin
        const n = prices.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        
        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += prices[i];
            sumXY += i * prices[i];
            sumX2 += i * i;
        }
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        
        const nextPrice = slope * n + intercept;
        const lastPrice = prices[prices.length - 1];
        const change = ((nextPrice - lastPrice) / lastPrice) * 100;
        
        // Confidence hesapla (R^2 + volatilite dengesi)
        let ssTot = 0;
        let ssRes = 0;
        const meanY = sumY / n;
        for (let i = 0; i < n; i++) {
            const predictedY = slope * i + intercept;
            const diffTot = prices[i] - meanY;
            const diffRes = prices[i] - predictedY;
            ssTot += diffTot * diffTot;
            ssRes += diffRes * diffRes;
        }
        const r2 = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);

        // Volatilite (son getiriler)
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            const prev = prices[i - 1];
            if (prev > 0) returns.push((prices[i] - prev) / prev);
        }
        const meanRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        let variance = 0;
        for (let i = 0; i < returns.length; i++) {
            const diff = returns[i] - meanRet;
            variance += diff * diff;
        }
        const vol = returns.length ? Math.sqrt(variance / returns.length) : 0;
        const volPct = vol * 100;

        const r2Score = Math.max(0, Math.min(100, r2 * 100));
        const stabilityScore = Math.max(0, Math.min(100, 100 - volPct * 6));

        // Basit geçmiş hata (MAE) ile güven
        let mae = 0;
        for (let i = 0; i < n; i++) {
            const predictedY = slope * i + intercept;
            mae += Math.abs(prices[i] - predictedY);
        }
        mae = mae / n;
        const meanPrice = sumY / n;
        const maePct = meanPrice > 0 ? (mae / meanPrice) * 100 : 0;

        const maeScore = Math.max(0, Math.min(100, 100 - maePct * 6));

        let confidence = Math.round(
            (r2Score * 0.45) +
            (stabilityScore * 0.20) +
            (maeScore * 0.35)
        );

        if (!Number.isFinite(confidence)) confidence = 50;
        confidence = Math.max(5, Math.min(95, confidence));
        
        return {
            predictedPrice: nextPrice,  // String yerine number döndür
            predictedChange: change.toFixed(2) + '%',
            direction: change > 0 ? 'UP' : 'DOWN',
            confidence: confidence,
            model: 'Linear Regression'
        };
    } catch (error) {
        console.error('Prediction error:', error);
        return null;
    }
}
// 9. ALARM SİSTEMİ (Supabase ile)
class AlarmSystem {
    constructor(supabaseClient = null) {
        this.alarms = [];
        this.checkInterval = null;
        this.supabase = supabaseClient;
        this.userId = null;
        this.telegramChatId = null;
        this.subscription = null;
        // Kaydedilmiş alarmları yükle
        this.loadAlarms();
    }
    
    setSupabaseClient(supabaseClient, userId, telegramChatId = null) {
        this.supabase = supabaseClient;
        this.userId = userId;
        this.telegramChatId = telegramChatId;
        // Eski subscription'ı durdur
        this.stopRealtimeSubscription();
        // Supabase'den alarmları yeniden yükle
        this.loadAlarms();
        // Real-time subscription başlat
        if (window.REALTIME_ENABLED) {
            this.startRealtimeSubscription();
        }
    }

    getLocalActiveAlarmCount() {
        return this.alarms.filter(alarm => alarm.active !== false).length;
    }

    async getAlarmLimitInfo() {
        const fallback = {
            limit: null,
            activeCount: this.getLocalActiveAlarmCount()
        };

        if (!this.supabase || !this.userId) {
            return fallback;
        }

        try {
            const { data: profile, error: profileError } = await this.supabase
                .from('user_profiles')
                .select('membership_type, is_admin, max_alarm_count')
                .eq('id', this.userId)
                .maybeSingle();

            if (profileError) {
                console.warn('⚠️ Alarm limiti profili okunamadı:', profileError.message || profileError);
                return fallback;
            }

            const isAdmin = !!profile?.is_admin;
            const rawOverride = Number(profile?.max_alarm_count);
            const hasOverride = Number.isInteger(rawOverride) && rawOverride > 0;
            const membershipType = String(profile?.membership_type || 'standard').toLowerCase();

            let limit = null;
            if (!isAdmin) {
                if (hasOverride) {
                    limit = rawOverride;
                } else if (membershipType === 'plus' || membershipType === 'premium') {
                    limit = 3;
                } else {
                    limit = 0;
                }
            }

            const { count, error: countError } = await this.supabase
                .from('alarms')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', this.userId)
                .eq('type', 'user_alarm')
                .or('is_active.eq.true,is_active.is.null');

            if (countError) {
                console.warn('⚠️ Aktif alarm sayısı okunamadı:', countError.message || countError);
                return {
                    limit,
                    activeCount: fallback.activeCount
                };
            }

            return {
                limit,
                activeCount: Number(count || 0)
            };
        } catch (error) {
            console.warn('⚠️ Alarm limit kontrolü hata verdi:', error);
            return fallback;
        }
    }
    
    async addAlarm(symbolOrAlarm, targetPrice, condition, type = 'price') {
        // Eğer ilk parametre object ise (yeni format)
        let alarm;
        if (typeof symbolOrAlarm === 'object') {
            alarm = {
                id: Date.now() + Math.random(),
                status: symbolOrAlarm.status || 'ACTIVE',
                ...symbolOrAlarm
            };
        } else {
            // Eski format: (symbol, targetPrice, condition, type)
            const resolvedMarketType = (window.getMarketType && window.getMarketType()) || window.CURRENT_MARKET_TYPE || 'spot';
            alarm = {
                id: Date.now() + Math.random(),
                symbol: symbolOrAlarm,
                targetPrice,
                condition, // 'above' veya 'below'
                type: type === 'price' ? 'PRICE_LEVEL' : type, // 'price' -> 'PRICE_LEVEL'
                marketType: resolvedMarketType,
                active: true,
                status: 'ACTIVE',
                createdAt: new Date(),
                triggered: false,
                triggeredAt: null
            };
        }

        const { limit, activeCount } = await this.getAlarmLimitInfo();
        if (Number.isInteger(limit) && activeCount >= limit) {
            throw new Error(`Maksimum aktif alarm limitiniz doldu (${limit}).`);
        }
        
        this.alarms.push(alarm);
        const saved = await this.saveAlarms();
        if (!saved) {
            this.alarms = this.alarms.filter(a => a.id !== alarm.id);
            localStorage.setItem('crypto_alarms', JSON.stringify(this.alarms));
            throw new Error('Alarm kaydedilemedi');
        }
        
        // Telegram'a gönder
        await this.sendTelegramAlarmCreated(alarm);
        return alarm;
    }
    
    async removeAlarm(id) {
        console.log('🗑️ [REMOVE ALARM] Başlatılıyor, id:', id, 'type:', typeof id);
        
        // ID'yi number ve string olarak convert et (Supabase type mismatch)
        const numId = Number(id);
        const strId = String(id);
        
        const alarm = this.alarms.find(a => {
            const aIdNum = Number(a.id);
            const aIdStr = String(a.id);
            console.log('🔍 Checking alarm:', { aIdNum, aIdStr, numId, strId, match: aIdNum === numId || aIdStr === strId });
            return aIdNum === numId || aIdStr === strId;
        });
        console.log('📋 Found alarm:', alarm);
        
        if (!alarm) {
            console.error('❌ Alarm bulunamadı:', { id, numId, strId });
            return;
        }
        
        // Önce local array'den sil
        this.alarms = this.alarms.filter(a => {
            const aIdNum = Number(a.id);
            return aIdNum !== numId;
        });
        console.log('📋 After filter, alarms length:', this.alarms.length);
        
        // localStorage'a kaydet
        localStorage.setItem('crypto_alarms', JSON.stringify(this.alarms));
        console.log('💾 localStorage kaydedildi');

        // Supabase'den sil
        if (this.supabase && this.userId) {
            try {
                console.log('🔄 Supabase DELETE çalışıyor:', { user_id: this.userId, id: numId, type: 'user_alarm' });
                let deletedRows = 0;
                if (Number.isFinite(numId)) {
                    const deleteResult = await this.supabase
                        .from('alarms')
                        .delete()
                        .eq('user_id', this.userId)
                        .eq('id', numId)
                        .eq('type', 'user_alarm')
                        .select('id');
                    deletedRows = deleteResult?.data?.length || 0;
                    console.log('🗑️ Supabase DELETE result:', deleteResult);
                }

                if (deletedRows === 0 && alarm) {
                    console.warn('⚠️ Alarm id eşleşmedi, alanlara göre silme deneniyor...');
                    let fallbackDelete = this.supabase
                        .from('alarms')
                        .delete()
                        .eq('user_id', this.userId)
                        .eq('type', 'user_alarm')
                        .eq('symbol', alarm.symbol || 'BTCUSDT')
                        .eq('timeframe', alarm.timeframe || '1h')
                        .eq('market_type', alarm.marketType || 'spot');

                    if (alarm.type === 'PRICE_LEVEL' || alarm.type === 'price') {
                        if (alarm.targetPrice || alarm.target_price) {
                            fallbackDelete = fallbackDelete.eq('target_price', alarm.targetPrice || alarm.target_price);
                        }
                        if (alarm.condition) {
                            fallbackDelete = fallbackDelete.eq('condition', alarm.condition);
                        }
                    } else if (alarm.type === 'ACTIVE_TRADE' || alarm.type === 'trade') {
                        if (alarm.entryPrice || alarm.entry_price) {
                            fallbackDelete = fallbackDelete.eq('entry_price', alarm.entryPrice || alarm.entry_price);
                        }
                    }

                    const fallbackResult = await fallbackDelete.select('id');
                    deletedRows = fallbackResult?.data?.length || 0;
                    console.log('🗑️ Fallback delete result:', fallbackResult);
                }

                console.log('🗑️ Alarm silindi:', { id: numId, symbol: alarm?.symbol, deletedRows });

                // Alarm sinyallerini de temizle
                if (Number.isFinite(numId)) {
                    const deleteSignalsResult = await this.supabase
                        .from('active_signals')
                        .delete()
                        .eq('user_id', this.userId)
                        .eq('alarm_id', numId);
                    console.log('🧹 Active signals temizlendi:', deleteSignalsResult);
                }
                await this.loadAlarms();
            } catch (error) {
                console.error('❌ Supabase silme hatası:', error);
                // Hata olursa alarmı geri ekle
                if (alarm) {
                    this.alarms.push(alarm);
                    localStorage.setItem('crypto_alarms', JSON.stringify(this.alarms));
                    console.log('↩️ Alarm geri eklendi');
                }
            }
        }
    }

    async deactivateAlarm(id) {
        console.log('⏹️ [DEACTIVATE] Alarm deaktif ediliyor...', { id });
        
        const alarm = this.alarms.find(a => a.id === id);
        if (!alarm) {
            console.error('❌ [DEACTIVATE] Alarm bulunamadı!', { id });
            return;
        }
        
        console.log('📊 [DEACTIVATE] Alarm bulundu:', { 
            symbol: alarm.symbol, 
            type: alarm.type,
            currentStatus: alarm.status 
        });
        
        alarm.active = false;
        alarm.status = 'CLOSED';
        await this.saveAlarms();
        
        console.log('📱 [DEACTIVATE] Telegram bildirimi gönderiliyor...');
        try {
            // Telegram bildirimi gönder - Alarm pasif oldu
            await this.sendTelegramAlarmPassive(alarm);
            console.log('✅ [DEACTIVATE] Telegram bildirimi gönderimi tamamlandı');
        } catch (telegramError) {
            console.error('❌ [DEACTIVATE] Telegram gönderimi hatası:', telegramError);
        }
    }
    
    async checkAlarms(currentPrice, symbol) {
        const now = new Date();
        const triggered = [];
        
        for (let alarm of this.alarms) {
            if (alarm.symbol !== symbol) continue;
            
            let shouldTrigger = false;
            let triggerReason = '';
            
            // Zaten tetiklenmiş alarmları atla (çift trigger'ı önlemek için)
            if (alarm.triggered) {
                continue;
            }
            
            // TIP 1: Fiyat seviye alarmları (PRICE_LEVEL)
            if (alarm.type === 'PRICE_LEVEL' && alarm.active) {
                if (alarm.condition === 'above' && currentPrice >= alarm.targetPrice) {
                    shouldTrigger = true;
                    triggerReason = `Fiyat ${alarm.targetPrice}'ın üzerine çıktı`;
                } else if (alarm.condition === 'below' && currentPrice <= alarm.targetPrice) {
                    shouldTrigger = true;
                    triggerReason = `Fiyat ${alarm.targetPrice}'ın altına indi`;
                }
            }
            
            // ACTIVE_TRADE (işlem alarmları) - TP/SL kontrol
            if (alarm.type === 'ACTIVE_TRADE') {
                const status = String(alarm.status || '').toUpperCase();
                if (status !== 'ACTIVE' && status !== 'AKTIF') {
                    continue;
                }
                if (alarm.direction === 'LONG') {
                    if (currentPrice >= alarm.takeProfit) {
                        shouldTrigger = true;
                        triggerReason = `✅ TP'YE ULAŞTI`;
                    } else if (currentPrice <= alarm.stopLoss) {
                        shouldTrigger = true;
                        triggerReason = `⛔ SL'YE İNDİ`;
                    }
                } else if (alarm.direction === 'SHORT') {
                    if (currentPrice <= alarm.takeProfit) {
                        shouldTrigger = true;
                        triggerReason = `✅ TP'YE ULAŞTI`;
                    } else if (currentPrice >= alarm.stopLoss) {
                        shouldTrigger = true;
                        triggerReason = `⛔ SL'YE ÇIKTI`;
                    }
                }
            }
            
            if (shouldTrigger) {
                alarm.triggered = true;
                alarm.triggeredAt = now;
                if (alarm.type === 'ACTIVE_TRADE') {
                    alarm.status = 'CLOSED';
                }
                // Telegram gönderimi için gerekli bilgileri kaydet
                alarm.currentPrice = currentPrice;
                alarm.triggerReason = triggerReason;
                triggered.push(alarm);
                
                // Browser notification
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification(`🚨 ${symbol} - ${triggerReason}`, {
                        body: `Şu anki fiyat: $${currentPrice.toFixed(2)}`,
                        icon: 'https://raw.githubusercontent.com/Pymmdrza/Cryptocurrency_Logos/mainx/PNG/btc.png'
                    });
                }
                
                // Audio alert
                this.playAlertSound();
            }
        }
        
        if (triggered.length > 0) {
            // ÖNCE Supabase'e kaydet
            await this.saveAlarms();
            
            // SONRA Telegram'a gönder
            for (let alarm of triggered) {
                await this.sendTelegramNotification(symbol, alarm, alarm.currentPrice, alarm.triggerReason);
            }
            
            console.log('✅ Alarmlar tetiklendi, Telegram\'a gönderildi');
        }
        
        return triggered;
    }
    
    playAlertSound() {
        const audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==');
        audio.volume = 0.3;
        audio.play().catch(() => {});
    }

    async sendTelegramNotification(symbol, alarm, currentPrice = null, triggerReason = '') {
        console.log('🔔 [TELEGRAM] BAŞLANDI - Bildirim gönderiliyor...', { 
            type: alarm.type, 
            symbol, 
            reason: triggerReason, 
            userId: this.userId,
            intersectionDetected: alarm.intersectionDetected 
        });

        const payload = {
            type: alarm.type,
            symbol: symbol,
            direction: alarm.direction,
            entryPrice: alarm.entryPrice || alarm.entry_price,
            takeProfit: alarm.takeProfit || alarm.take_profit,
            stopLoss: alarm.stopLoss || alarm.stop_loss,
            targetPrice: alarm.targetPrice || alarm.target_price,
            condition: alarm.condition,
            currentPrice: currentPrice,
            triggerReason: triggerReason,
            intersectionDetected: alarm.intersectionDetected,
            marketType: alarm.marketType || alarm.market_type,
            timeframe: alarm.timeframe
        };

        await this.sendAlarmNotificationToEdge('trigger', payload);
    }

    async sendTelegramAlarmCreated(alarm) {
        console.log('🔔 [TELEGRAM] Alarm bildirimi gönderiliyor (oluşturma):', { type: alarm.type, symbol: alarm.symbol });
        const payload = {
            type: alarm.type,
            symbol: alarm.symbol,
            targetPrice: alarm.targetPrice || alarm.target_price || alarm.price || alarm.target,
            condition: alarm.condition,
            direction: alarm.direction,
            entryPrice: alarm.entryPrice || alarm.entry_price,
            takeProfit: alarm.takeProfit || alarm.take_profit,
            stopLoss: alarm.stopLoss || alarm.stop_loss,
            marketType: alarm.marketType || alarm.market_type,
            timeframe: alarm.timeframe
        };

        await this.sendAlarmNotificationToEdge('created', payload);
    }

    async sendAlarmNotificationToEdge(notificationType, alarmPayload) {
        if (!this.supabase || !this.userId) {
            return { ok: false, error: 'missing_supabase_or_user' };
        }

        try {
            const { data, error } = await this.supabase.functions.invoke('check-alarm-signals', {
                body: {
                    action: 'alarm_notification',
                    notification_type: notificationType,
                    alarm: alarmPayload
                }
            });

            if (error) {
                console.warn('⚠️ [TELEGRAM] Edge bildirim hatasi:', error);
                return { ok: false, error: error.message || String(error) };
            }

            return data || { ok: true };
        } catch (error) {
            console.error('❌ [TELEGRAM] Edge bildirim hatasi:', error);
            return { ok: false, error: error?.message || 'unknown_error' };
        }
    }

    async sendTelegramAlarmPassive(alarm) {
        console.log('🔔 [TELEGRAM PASIF] BAŞLADI - Alarm pasif duruma geçti!', { 
            type: alarm.type, 
            symbol: alarm.symbol,
            id: alarm.id,
            userId: this.userId,
            supabaseExists: !!this.supabase
        });

        if (!this.supabase || !this.userId) {
            console.error('❌ [TELEGRAM PASIF] KRİTİK: Supabase veya userId eksik!');
            return;
        }

        try {
            const payload = {
                type: alarm.type,
                symbol: alarm.symbol,
                direction: alarm.direction,
                entryPrice: alarm.entryPrice || alarm.entry_price,
                takeProfit: alarm.takeProfit || alarm.take_profit,
                stopLoss: alarm.stopLoss || alarm.stop_loss,
                closePrice: alarm.closePrice || alarm.currentPrice,
                marketType: alarm.marketType || alarm.market_type,
                timeframe: alarm.timeframe
            };

            await this.sendAlarmNotificationToEdge('passive', payload);
        } catch (error) {
            console.error('❌ [TELEGRAM PASIF] 🔴 KRITIK HATA 🔴:', error.message);
        }
    }

    async sendTelegramAlarmEnded(alarm, reason = 'deleted') {
        if (!this.supabase || !this.userId) return;

        try {
            let message = '';

            if (alarm.type === 'PRICE_LEVEL') {
                const targetPrice = alarm.targetPrice || alarm.price || alarm.target;
                if (!targetPrice) return;
                message = `🚫 *${alarm.symbol}* - Alarm Kapatıldı`;
            } else if (alarm.type === 'ACTIVE_TRADE') {
                const directionEmoji = alarm.direction === 'LONG' ? '📈' : '📉';
                message = `${directionEmoji} *${alarm.symbol}* - ${alarm.direction} İşlem Silindi`;
            } else {
                return;
            }

            const payload = {
                type: alarm.type,
                symbol: alarm.symbol,
                direction: alarm.direction,
                marketType: alarm.marketType || alarm.market_type,
                timeframe: alarm.timeframe,
                reason: reason,
                note: message
            };

            await this.sendAlarmNotificationToEdge('ended', payload);
            console.log('✅ Alarm kapatıldı, Telegram\'a gönderildi');

        } catch (error) {
            // Hata sessizce yönet
        }
    }
    
    async saveAlarms() {
        // localStorage'a her zaman kaydet (offline support)
        localStorage.setItem('crypto_alarms', JSON.stringify(this.alarms));
        
        console.log('💾 saveAlarms çağrıldı, supabase:', !!this.supabase, 'userId:', this.userId, 'alarms length:', this.alarms.length);
        
        // Supabase'e de kaydet (eğer client varsa)
        if (this.supabase && this.userId) {
            try {
                let hadError = false;
                for (const alarm of this.alarms) {
                    const autoTradeEnabled = alarm.autoTradeEnabled || alarm.auto_trade_enabled || false;
                    const baseData = {
                        user_id: this.userId,
                        symbol: alarm.symbol || 'BTCUSDT',
                        timeframe: alarm.timeframe || '1h',
                        market_type: resolveMarketType(alarm.marketType || alarm.market_type || alarm.market),
                        type: 'user_alarm',
                        is_active: alarm.active !== false,
                        telegram_enabled: true,
                        telegram_chat_id: this.telegramChatId || null,
                        confidence_score: String(alarm.confidenceScore || alarm.confidence_score || '60'),
                        tp_percent: String(alarm.takeProfitPercent || alarm.tp_percent || '5'),
                        sl_percent: String(alarm.stopLossPercent || alarm.sl_percent || '3'),
                        auto_trade_enabled: autoTradeEnabled
                    };

                    let payload = baseData;
                    if (alarm.type === 'price' || alarm.type === 'PRICE_LEVEL') {
                        payload = {
                            ...baseData,
                            target_price: alarm.targetPrice || alarm.target_price,
                            condition: alarm.condition || 'above'
                        };
                    } else if (alarm.type === 'trade' || alarm.type === 'ACTIVE_TRADE') {
                        payload = {
                            ...baseData,
                            direction: alarm.direction || 'LONG',
                            entry_price: alarm.entryPrice || alarm.entry_price,
                            take_profit: alarm.takeProfit || alarm.take_profit,
                            stop_loss: alarm.stopLoss || alarm.stop_loss
                        };
                    } else {
                        payload = {
                            ...baseData,
                            target_price: alarm.targetPrice || alarm.target_price,
                            condition: alarm.condition || 'above'
                        };
                    }

                    const alarmIdNum = Number(alarm.id);
                    if (Number.isInteger(alarmIdNum)) {
                        const { data: updated, error: updateError } = await this.supabase
                            .from('alarms')
                            .update(payload)
                            .eq('user_id', this.userId)
                            .eq('id', alarmIdNum)
                            .eq('type', 'user_alarm')
                            .select('id')
                            .maybeSingle();

                        if (updateError || !updated?.id) {
                            hadError = true;
                            const { data: inserted, error: insertError } = await this.supabase
                                .from('alarms')
                                .insert(payload)
                                .select('id')
                                .maybeSingle();
                            if (!insertError && inserted?.id) {
                                alarm.id = String(inserted.id);
                            } else if (insertError) {
                                hadError = true;
                            }
                        }
                    } else {
                        const { data: inserted, error: insertError } = await this.supabase
                            .from('alarms')
                            .insert(payload)
                            .select('id')
                            .maybeSingle();
                        if (!insertError && inserted?.id) {
                            alarm.id = String(inserted.id);
                        } else if (insertError) {
                            hadError = true;
                        }
                    }
                }

                if (hadError) {
                    console.error('❌ Alarmlar kismi kaydedildi, hata var');
                    return false;
                }

                console.log('💾 Alarmlar alarms tablosuna kaydedildi');
                await this.loadAlarms();
                return true;
            } catch (error) {
                console.error('❌ Supabase kayıt hatası:', error);
                return false;
            }
        } else {
            console.log('⚠️ Supabase client veya userId yok, sadece localStorage kaydedildi');
            return true;
        }
    }
    
    async loadAlarms() {
        // Supabase'den yükle (varsa)
        if (this.supabase && this.userId) {
            try {
                const { data, error } = await this.supabase
                    .from('alarms')
                    .select('*')
                    .eq('user_id', this.userId)
                    .eq('type', 'user_alarm');
                
                if (error) throw error;

                if (Array.isArray(data) && data.length === 0) {
                    this.alarms = [];
                    localStorage.removeItem('crypto_alarms');
                    console.log('📥 alarms tablosunda kayıt yok, local alarm cache temizlendi');
                    return;
                }
                
                if (data && data.length > 0) {
                    this.alarms = data.map(item => {
                        const autoTradeEnabled = item.auto_trade_enabled === true;
                        const parsedTp = Number(item.tp_percent);
                        const parsedSl = Number(item.sl_percent);
                        const baseAlarm = {
                            id: String(item.id),  // Convert BIGSERIAL number to string for consistent type handling
                            symbol: item.symbol,
                            timeframe: item.timeframe,
                            marketType: item.market_type || 'spot',
                            active: item.is_active,
                            status: item.status || 'ACTIVE',
                            createdAt: item.created_at,
                            confidenceScore: parseInt(item.confidence_score) || 60,
                            takeProfitPercent: Number.isFinite(parsedTp) ? parsedTp : 5,
                            stopLossPercent: Number.isFinite(parsedSl) ? parsedSl : 3,
                            auto_trade_enabled: autoTradeEnabled,
                            autoTradeEnabled: autoTradeEnabled
                        };
                        
                        // Alarm türüne göre ek alanlar
                        if (item.target_price) {
                            // Price level alarm
                            return {
                                ...baseAlarm,
                                type: 'PRICE_LEVEL',
                                targetPrice: parseFloat(item.target_price),
                                condition: item.condition || 'above',
                                name: `${item.symbol} - ${item.condition} ${item.target_price}`,
                                description: `Fiyat alarmı: ${item.condition} $${item.target_price}`
                            };
                        } else if (item.entry_price) {
                            // Active trade alarm
                            return {
                                ...baseAlarm,
                                type: 'ACTIVE_TRADE',
                                direction: item.direction || 'LONG',
                                entryPrice: parseFloat(item.entry_price),
                                takeProfit: parseFloat(item.take_profit),
                                stopLoss: parseFloat(item.stop_loss),
                                name: `${item.symbol} - ${item.direction} Trade`,
                                description: `Giriş: $${item.entry_price}, TP: $${item.take_profit}, SL: $${item.stop_loss}`
                            };
                        }
                        
                        // Default
                        return {
                            ...baseAlarm,
                            type: 'PRICE_LEVEL',
                            name: `${item.symbol} - Alarm`,
                            description: `Güven skoru: ${item.confidence_score}%, TP: ${item.tp_percent}%, SL: ${item.sl_percent}%`
                        };
                    });
                    console.log(`📥 alarms tablosundan ${this.alarms.length} alarm yüklendi`);
                    localStorage.setItem('crypto_alarms', JSON.stringify(this.alarms));
                    return;
                }
            } catch (error) {
                console.error('Supabase yükleme hatası:', error);
                console.log('localStorage\'dan yükleme yapılıyor...');
            }
        }
        
        // localStorage'dan yükle (fallback veya offline)
        const saved = localStorage.getItem('crypto_alarms');
        if (saved) {
            const parsed = JSON.parse(saved);
            this.alarms = (Array.isArray(parsed) ? parsed : []).map(alarm => {
                const autoTradeEnabled = alarm.auto_trade_enabled ?? alarm.autoTradeEnabled ?? false;
                return {
                    ...alarm,
                    auto_trade_enabled: autoTradeEnabled,
                    autoTradeEnabled: autoTradeEnabled
                };
            });
        }
    }
    
    startMonitoring(interval = 10000) {
        if (this.checkInterval) clearInterval(this.checkInterval);
        
        this.checkInterval = setInterval(() => {
            // Bu fonksiyon dışarıdan çağrılacak
        }, interval);
    }
    
    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    startRealtimeSubscription() {
        if (!this.supabase || !this.userId || !window.REALTIME_ENABLED) return;

        // Eski subscription'ı durdur
        this.stopRealtimeSubscription();

        console.log('🔄 Real-time alarm subscription başlatılıyor...');

        this.subscription = this.supabase
            .channel('alarms_changes')
            .on('postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'alarms',
                    filter: `user_id=eq.${this.userId}`
                },
                (payload) => {
                    console.log('📡 Alarm değişikliği algılandı:', payload.eventType, payload.new || payload.old);

                    // Alarmları yeniden yükle ve UI'yi güncelle
                    this.loadAlarms().then(() => {
                        // Global loadAlarms fonksiyonunu çağır (eğer varsa)
                        if (typeof loadAlarms === 'function') {
                            loadAlarms();
                        }
                    });
                }
            )
            .subscribe((status) => {
                console.log('📡 Alarm subscription durumu:', status);
            });
    }

    stopRealtimeSubscription() {
        if (this.subscription) {
            console.log('🔄 Real-time alarm subscription durduruluyor...');
            this.supabase.removeChannel(this.subscription);
            this.subscription = null;
        }
    }
}

// 10. RISK HESAP MAKİNESİ
class RiskCalculator {
    constructor() {
        this.defaultRiskPerTrade = 2; // %2
        this.minRiskReward = 1.5;
    }
    
    calculatePositionSize(accountBalance, entryPrice, stopLoss, riskPercentage = null) {
        const riskPct = riskPercentage || this.defaultRiskPerTrade;
        const riskAmount = (accountBalance * riskPct) / 100;
        const riskPerUnit = Math.abs(entryPrice - stopLoss);
        
        if (riskPerUnit === 0) return 0;
        
        const positionSize = riskAmount / riskPerUnit;
        const positionValue = positionSize * entryPrice;
        
        return {
            positionSize: positionSize.toFixed(8),
            positionValue: positionValue.toFixed(2),
            riskAmount: riskAmount.toFixed(2),
            riskPercentage: riskPct,
            stopLossDistance: (riskPerUnit / entryPrice * 100).toFixed(2) + '%'
        };
    }
    
    calculateRiskReward(entry, stopLoss, takeProfit) {
        const risk = Math.abs(entry - stopLoss);
        const reward = Math.abs(takeProfit - entry);
        const ratio = reward / risk;
        
        return {
            ratio: ratio.toFixed(2),
            risk: risk.toFixed(2),
            reward: reward.toFixed(2),
            status: ratio >= this.minRiskReward ? '✅ Favorable' : '❌ Unfavorable'
        };
    }
    
    calculateMaxDrawdown(trades) {
        if (!trades || trades.length === 0) return 0;
        
        let peak = trades[0].balance;
        let maxDrawdown = 0;
        
        for (const trade of trades) {
            if (trade.balance > peak) {
                peak = trade.balance;
            }
            
            const drawdown = ((peak - trade.balance) / peak) * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }
        
        return maxDrawdown.toFixed(2) + '%';
    }
}

// 11. HABER ENTEGRASYONU (Cryptopanic API - Ücretsiz)
async function fetchCryptoNews(coin = 'BTC', limit = 10) {
    try {
        // Türkçe kripto haberleri RSS kaynakları
        const rssFeeds = [
            'https://tr.investing.com/rss/news_301.rss',  // Investing.com Kripto
            'https://www.kriptofoni.com/rss'              // Kriptofoni
        ];
        
        let allNews = [];
        
        console.log(`🔍 ${coin} için haber aranıyor...`);
        
        // Her RSS feed'den haberler çek
        for (const feedUrl of rssFeeds) {
            try {
                // RSS'i direkt JSON'a dönüştür
                const rss2jsonUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
                
                const response = await fetch(rss2jsonUrl, {
                    headers: { 'User-Agent': 'CryptoAnalysisApp/1.0' }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.items && data.items.length > 0) {
                        const newsItems = data.items.map(item => ({
                            title: item.title || 'Başlıksız',
                            url: item.link || '#',
                            source: data.feed.title || 'Kripto Haberleri',
                            published_at: new Date(item.pubDate || Date.now()).toISOString(),
                            sentiment: analyzeSentiment(item.title + ' ' + (item.description || ''))
                        }));
                        allNews.push(...newsItems);
                        console.log(`✓ ${feedUrl} başarıyla yüklendi (${newsItems.length} haber)`);
                    }
                } else {
                    console.log(`✗ ${feedUrl} - HTTP ${response.status}`);
                }
            } catch (e) {
                console.log('RSS error:', feedUrl, e.message);
            }
        }
        
        console.log(`📊 Toplam ${allNews.length} haber alındı`);
        
        // Coin'e göre haberler filtrele
        const coinKeywords = {
            'BTCUSDT': ['bitcoin', 'btc'],
            'ETHUSDT': ['ethereum', 'eth'],
            'BNBUSDT': ['binance', 'bnb', 'bsc'],
            'ADAUSDT': ['cardano', 'ada'],
            'XRPUSDT': ['ripple', 'xrp'],
            'DOGEUSDT': ['dogecoin', 'doge'],
            'SOLUSDT': ['solana', 'sol'],
            'MATICUSDT': ['polygon', 'matic'],
            'LTCUSDT': ['litecoin', 'ltc'],
            'AVAXUSDT': ['avalanche', 'avax'],
            'MYTHUSDT': ['myth', 'mytherium'],
            'DOTUSDT': ['polkadot', 'dot'],
            'LINKUSDT': ['chainlink', 'link']
        };
        
        const keywords = coinKeywords[coin] || [];
        let filteredNews = [];
        
        // Eğer spesifik coin keywords varsa filtrele
        if (keywords.length > 0) {
            filteredNews = allNews.filter(item => {
                const titleLower = item.title.toLowerCase();
                return keywords.some(keyword => titleLower.includes(keyword));
            });
            console.log(`🎯 ${coin} için filtreleme: ${filteredNews.length}/${allNews.length}`);
        }
        
        // Haberler varsa sırala, limit yap
        if (filteredNews.length > 0) {
            const result = filteredNews
                .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
                .slice(0, limit);
            console.log(`✅ ${coin} için ${result.length} haber gösterilecek`);
            return result;
        }
        
        // Coin-spesifik haber bulunamadı
        console.log(`⚠️ ${coin} için haber bulunamadı (keywords: ${keywords.join(', ')})`);
        return [];
        
    } catch (error) {
        console.warn('News fetch error:', error.message);
        return [];
    }
}

// RSS başlık ve açıklamadan duygu analizi
function analyzeSentiment(text) {
    const positiveWords = ['artış', 'yükseliş', 'kazanç', 'iyi', 'başarı', 'rally', 'bull', 'pompa', 'rekor', 'büyüme'];
    const negativeWords = ['düşüş', 'kaybı', 'kötü', 'zararda', 'kayıp', 'bear', 'crash', 'düştü', 'risk', 'uyarı'];
    
    const lower = text.toLowerCase();
    
    const posCount = positiveWords.filter(word => lower.includes(word)).length;
    const negCount = negativeWords.filter(word => lower.includes(word)).length;
    
    if (posCount > negCount) return 'positive';
    if (negCount > posCount) return 'negative';
    return 'neutral';
}

// 12. SENTIMENT ANALİZİ
async function fetchMarketSentiment() {
    try {
        // Fear & Greed Index
        const fearGreedUrl = 'https://api.alternative.me/fng/?limit=1';
        const response = await fetch(fearGreedUrl);
        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
            return {
                fearGreedIndex: data.data[0].value,
                classification: data.data[0].value_classification,
                timestamp: data.data[0].timestamp
            };
        }
        
        return {
            fearGreedIndex: 50,
            classification: 'Neutral',
            timestamp: Date.now()
        };
        
    } catch (error) {
        console.error('Sentiment fetch error:', error);
        return null;
    }
}

// Export fonksiyonları
window.AdvancedIndicators = {
    analyzeMultiTimeframe,
    calculateFibonacciLevels,
    calculateVWAP,
    calculateVolumeProfile,
    detectPatterns,
    detectDivergence,
    calculateAlarmIndicators,
    generateSignalScoreAligned,
    generateAdvancedSignal,
    runBacktest,
    predictNextPrice,
    AlarmSystem,
    RiskCalculator,
    fetchCryptoNews,
    fetchMarketSentiment
};