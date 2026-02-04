// GELİŞMİŞ TEKNİK İNDİKATÖRLER
// ============================

// Telegram bildirim şablonlarını içeri aktar
// (HTML'de <script src="telegram-notification-templates.js"></script> olmalı)

// (no helper) price formatting uses toFixed(2) where appropriate

const TELEGRAM_BOT_TOKEN_SAFE = typeof TELEGRAM_BOT_TOKEN !== 'undefined' ? TELEGRAM_BOT_TOKEN : null;

// 1. MULTI-TIMEFRAME ANALİZ
async function analyzeMultiTimeframe(symbol) {
    const timeframes = ['5m', '15m', '1h', '4h', '1d'];
    
    // Tüm API çağrılarını paralel yap (sequential yerine)
    const promises = timeframes.map(async (tf) => {
        try {
            const klinesUrl = `${window.getBinanceApiBase ? window.getBinanceApiBase() : "https://api.binance.com/api/v3"}/klines?symbol=${symbol}&interval=${tf}&limit=100`;
            const response = await fetch(klinesUrl);
            const klines = await response.json();
            
            const closes = klines.map(k => parseFloat(k[4]));
            const highs = klines.map(k => parseFloat(k[2]));
            const lows = klines.map(k => parseFloat(k[3]));
            const volumes = klines.map(k => parseFloat(k[5]));
            
            const indicators = calculateIndicators(closes, highs, lows, volumes);
            const sr = findSupportResistance(highs, lows, closes);
            const signal = generateAdvancedSignal(indicators, closes[closes.length-1], sr);
            
            return {
                timeframe: tf,
                signal: signal.direction,
                confidence: signal.score,
                price: closes[closes.length-1]
            };
        } catch (error) {
            console.error(`MTF error for ${tf}:`, error);
            return {
                timeframe: tf,
                signal: 'N/A',
                confidence: 0,
                price: 0
            };
        }
    });
    
    // Tüm promise'leri paralel çalıştır
    const results = await Promise.all(promises);
    return results;
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
    
    // GERÇEK SINYAL: confidence >= confidenceThreshold (kullanıcı ayarlanabilir)
    const isValidSignal = confidence >= confidenceThreshold;
    
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

function getConfidenceLevel(score) {
    if (score >= 80) return 'HIGH';
    if (score >= 60) return 'MEDIUM_HIGH';
    if (score >= 40) return 'MEDIUM';
    if (score >= 20) return 'LOW_MEDIUM';
    return 'LOW';
}

// 7. BACKTEST SİSTEMİ
async function runBacktest(symbol, timeframe, days = 30, confidenceThreshold = 70, takeProfitPercent = 5, stopLossPercent = 3, barCloseLimit = 5) {
    const results = [];
    console.log(`🔍 BACKTEST BAŞLADI: ${symbol} ${timeframe} | TP:${takeProfitPercent}% SL:${stopLossPercent}% Bar:${barCloseLimit}`);
    
    // Timeframe'e göre gerekli kline sayısını hesapla
    const timeframeMinutes = {
        '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
    };
    const minutes = timeframeMinutes[timeframe] || 60;
    const klinesPerDay = 24 * 60 / minutes;
    const neededKlines = Math.min(Math.ceil(days * klinesPerDay), 1000);
    
    try {
        // Son 999 kapanmış bar'ı al with retry & rate limiting
        const klinesUrl = `${window.getBinanceApiBase ? window.getBinanceApiBase() : "https://api.binance.com/api/v3"}/klines?symbol=${symbol}&interval=${timeframe}&limit=999`;
        const response = await fetchWithRetry(klinesUrl, {}, 3, 1000, 30000);
        const klines = await response.json();
        
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
        
        const closes = klines.map(k => parseFloat(k[4]));
        const highs = klines.map(k => parseFloat(k[2]));
        const lows = klines.map(k => parseFloat(k[3]));
        const volumes = klines.map(k => parseFloat(k[5]));
        
        // Sliding window ile backtest
        const windowSize = 100;
        let wins = 0;
        let losses = 0;
        let totalProfit = 0;
        let totalWinProfit = 0;
        let totalLossProfit = 0;
        
        // AÇIK İŞLEM TRACKING
        let openTrade = null;  // Şu anda açık olan işlem
        let openTradeEntryBar = -1;  // Açık işlemin giriş bar'ı
        
        // Her bar kontrol edilsin (SON AÇIK BAR HARIÇ - incomplete data)
        for (let i = windowSize; i < closes.length - 1; i++) {
            
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
                    // KURAL 1: TP'ye ulaştı mı? (BAR İÇİNDE HIT)
                    if (currentHigh >= openTrade.takeProfit) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 LONG [${timeframe}] TP HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= TP=${openTrade.takeProfit.toFixed(4)}`);
                        }
                        openTrade.exit = openTrade.takeProfit;  // ✅ TP fiyatında hemen çık
                        openTrade.exitBarIndex = i;
                        openTrade.actualTP = true;
                        shouldClose = true;
                        closeReason = 'TP';
                    }
                    // KURAL 2: SL'ye ulaştı mı? (BAR İÇİNDE HIT)
                    else if (currentLow <= openTrade.stopLoss) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 LONG [${timeframe}] SL HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= SL=${openTrade.stopLoss.toFixed(4)}`);
                        }
                        openTrade.exit = openTrade.stopLoss;  // ✅ SL fiyatında hemen çık
                        openTrade.exitBarIndex = i;
                        openTrade.actualSL = true;
                        shouldClose = true;
                        closeReason = 'SL';
                    }
                    // KURAL 3: barCloseLimit kadar bar geçti mi?
                    else if (barsSinceEntry >= barCloseLimit) {
                        if (barsSinceEntry === barCloseLimit) {
                            console.log(`📊 LONG [${timeframe}] barCloseLimit: entry=${openTradeEntryBar} i=${i} bars=${barsSinceEntry}/${barCloseLimit}`);
                        }
                        openTrade.exit = closes[i];
                        openTrade.exitBarIndex = i;
                        shouldClose = true;
                        closeReason = 'barCloseLimit';
                    }
                } else {
                    // SHORT işlem
                    // KURAL 1: TP'ye ulaştı mı? (BAR İÇİNDE HIT)
                    if (currentLow <= openTrade.takeProfit) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 SHORT [${timeframe}] TP HIT bar${barsSinceEntry}: LOW=${currentLow.toFixed(4)} <= TP=${openTrade.takeProfit.toFixed(4)}`);
                        }
                        openTrade.exit = openTrade.takeProfit;  // ✅ TP fiyatında hemen çık
                        openTrade.exitBarIndex = i;
                        openTrade.actualTP = true;
                        shouldClose = true;
                        closeReason = 'TP';
                    }
                    // KURAL 2: SL'ye ulaştı mı? (BAR İÇİNDE HIT)
                    else if (currentHigh >= openTrade.stopLoss) {
                        if (barsSinceEntry >= 4 && barsSinceEntry <= 6) {
                            console.log(`🎯 SHORT [${timeframe}] SL HIT bar${barsSinceEntry}: HIGH=${currentHigh.toFixed(4)} >= SL=${openTrade.stopLoss.toFixed(4)}`);
                        }
                        openTrade.exit = openTrade.stopLoss;  // ✅ SL fiyatında hemen çık
                        openTrade.exitBarIndex = i;
                        openTrade.actualSL = true;
                        shouldClose = true;
                        closeReason = 'SL';
                    }
                    // KURAL 3: barCloseLimit kadar bar geçti mi?
                    else if (barsSinceEntry >= barCloseLimit) {
                        if (barsSinceEntry === barCloseLimit) {
                            console.log(`📊 SHORT [${timeframe}] barCloseLimit: entry=${openTradeEntryBar} i=${i} bars=${barsSinceEntry}/${barCloseLimit}`);
                        }
                        openTrade.exit = closes[i];
                        openTrade.exitBarIndex = i;
                        shouldClose = true;
                        closeReason = 'barCloseLimit';
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
                        closeReason: closeReason  // ✅ DEBUG: TP/SL/barCloseLimit?
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
            
            const windowCloses = closes.slice(i - windowSize, i);
            const windowHighs = highs.slice(i - windowSize, i);
            const windowLows = lows.slice(i - windowSize, i);
            const windowVolumes = volumes.slice(i - windowSize, i);
            
            const indicators = calculateIndicators(windowCloses, windowHighs, windowLows, windowVolumes);
            const sr = findSupportResistance(windowHighs, windowLows, windowCloses);
            
            const signalScore = generateSignalScoreAligned(
                indicators,
                windowCloses[windowCloses.length - 1],
                sr,
                windowCloses,
                windowVolumes,
                confidenceThreshold
            );
            
            const shouldOpenTrade = signalScore && signalScore.triggered;
            
            // DEBUG: Log ekle
            if (i < windowSize + 5 || i > closes.length - 10) {
                console.log(`🔄 [${timeframe}] bar=${i} signal=${signal.direction} score=${signal.score} TP=${signal.tp?.toFixed(4)} SL=${signal.stop?.toFixed(4)} shouldOpen=${shouldOpenTrade}`);
            }
            
            if (!shouldOpenTrade) {
                continue;
            }
            
            // ✅ SON BAR'DA DA İŞLEM AÇILABILSIN (futures için önemli - çoğu zaman son bar'da signal)
            // Eski kod: if (i === closes.length - 1) continue;  // Bu son bar'ı engelliyor
            
            // ============================================
            // ADIM 3: YENİ İŞLEM AÇ
            // ============================================
            
            const entryPrice = windowCloses[windowCloses.length - 1];
            const direction = signalScore.direction;
            const takeProfit = direction === 'SHORT'
                ? entryPrice * (1 - takeProfitPercent / 100)
                : entryPrice * (1 + takeProfitPercent / 100);
            const stopLoss = direction === 'SHORT'
                ? entryPrice * (1 + stopLossPercent / 100)
                : entryPrice * (1 - stopLossPercent / 100);
            const signal = {
                direction,
                score: signalScore.score,
                tp: takeProfit,
                stop: stopLoss,
                isValidSignal: true
            };
            
            // Tarih ve saat (Türkiye saati)
            const tradeDate = new Date(klines[i][0]);
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
                timestamp: klines[i][0],
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
            
            openTradeEntryBar = i;
            console.log(`✅ YENİ İŞLEM AÇILDI [${timeframe}] bar=${i} ${signal.direction} entry=${entryPrice.toFixed(4)} TP=${takeProfit.toFixed(4)} SL=${stopLoss.toFixed(4)}`);
        }
        
        // ============================================
        // ADIM 4: DÖNGÜ BİTTİKTEN SONRA AÇIK İŞLEM KONTROLÜ
        // ============================================
        
        console.log(`📊 [${timeframe}] Backtest döngü bitti: totalTrades=${results.length}, openTrade=${openTrade ? 'var' : 'yok'}, wins=${wins}, losses=${losses}, totalProfit=${totalProfit.toFixed(2)}%`);
        
        // Eğer hala açık işlem varsa VE barCloseLimit'i geçmişse, kapat!
        let lastOpenTradeFromBacktest = null;
        if (openTrade !== null) {
            const barsOpen = (closes.length - 1) - openTradeEntryBar;
            
            // barCloseLimit kontrolü: Eğer geçmişse kapat, değilse açık bırak
            if (barsOpen >= barCloseLimit) {
                // ✅ barCloseLimit'i geçti, işlemi kapat
                console.log(`📊 AÇIK İŞLEM KAPATILDI [${timeframe}] barCloseLimit: bars=${barsOpen}/${barCloseLimit} (döngü sonu)`);
                
                let profit = 0;
                openTrade.exit = closes[closes.length - 1];
                openTrade.exitBarIndex = closes.length - 1;
                
                if (openTrade.signal === 'LONG') {
                    profit = ((openTrade.exit - openTrade.entry) / openTrade.entry) * 100;
                } else {
                    profit = ((openTrade.entry - openTrade.exit) / openTrade.entry) * 100;
                }
                
                const barCount = openTrade.exitBarIndex - openTrade.barIndex;
                let durationFormatted = '';
                if (barCount === 0) {
                    durationFormatted = 'Aynı bar';
                } else {
                    durationFormatted = barCount + ' bar';
                }
                
                const closedTrade = {
                    ...openTrade,
                    profit: profit,
                    isOpen: false,
                    duration: durationFormatted,
                    closeReason: 'barCloseLimit'
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
                
                // Results'a ekle (kapalı işlem)
                results.push(closedTrade);
                openTrade = null;
                openTradeEntryBar = -1;
            } else {
                // ❌ barCloseLimit'i henüz geçmedi, açık bırak
                lastOpenTradeFromBacktest = {
                    ...openTrade,
                    profit: 0,  // Açık işlem için profit HER ZAMAN 0
                    isOpen: true,  // KESIN TRUE
                    duration: 'AKTİF'  // Açık işlem duration
                };
            }
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
            } else {
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
            // Son barı kontrol et, ama kapalı bar'a bak (lastBarIndex - 1)
            const lastBarIndex = closes.length - 1;
            const closedBarIndex = lastBarIndex - 1;  // Kapalı bar (sonuncudan bir öncesi)
            
            if (closedBarIndex < windowSize) {
                // Yeterli bar yok
                return { trades: results, lastTrade: null, averages };
            }
            
            const lastWindowStart = Math.max(0, closedBarIndex - windowSize);
            const lastWindowCloses = closes.slice(lastWindowStart, closedBarIndex + 1);
            const lastWindowHighs = highs.slice(lastWindowStart, closedBarIndex + 1);
            const lastWindowLows = lows.slice(lastWindowStart, closedBarIndex + 1);
            const lastWindowVolumes = volumes.slice(lastWindowStart, closedBarIndex + 1);
            
            const lastIndicators = calculateIndicators(lastWindowCloses, lastWindowHighs, lastWindowLows, lastWindowVolumes);
            const lastSR = findSupportResistance(lastWindowHighs, lastWindowLows, lastWindowCloses);
            
            const lastSignalScore = generateSignalScoreAligned(
                lastIndicators,
                closes[closedBarIndex],
                lastSR,
                lastWindowCloses,
                lastWindowVolumes,
                confidenceThreshold
            );
            const lastDirection = lastSignalScore.direction;
            const lastEntry = closes[closedBarIndex];
            const lastTp = lastDirection === 'SHORT'
                ? lastEntry * (1 - takeProfitPercent / 100)
                : lastEntry * (1 + takeProfitPercent / 100);
            const lastSl = lastDirection === 'SHORT'
                ? lastEntry * (1 + stopLossPercent / 100)
                : lastEntry * (1 - stopLossPercent / 100);
            const lastSignal = {
                direction: lastDirection,
                entry: lastEntry,
                tp: lastTp,
                stop: lastSl,
                score: lastSignalScore.score,
                isValidSignal: lastSignalScore.triggered
            };
            
            // SADECE isValidSignal true olan sinyalleri göster (confidence threshold geçenler)
            if (lastSignal && lastSignal.isValidSignal) {
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
                    const lastBarTimeUTC = new Date(klines[closedBarIndex][0]);
                    const lastTimeStr = lastBarTimeUTC.toLocaleTimeString('tr-TR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        timeZone: 'Europe/Istanbul'
                    });
                    
                    const lastBarDateTurkey = new Date(klines[closedBarIndex][0]);
                    
                    // Kar/Zarar hesapla
                    let lastTradeProfit = 0;
                    if (lastSignal.direction === 'LONG') {
                        lastTradeProfit = ((closes[lastBarIndex] - closes[closedBarIndex]) / closes[closedBarIndex]) * 100;
                    } else {
                        lastTradeProfit = ((closes[closedBarIndex] - closes[lastBarIndex]) / closes[closedBarIndex]) * 100;
                    }
                    
                    lastTrade = {
                        timestamp: klines[closedBarIndex][0],
                        barIndex: closedBarIndex,  // Kapalı bar'ı işaret et
                        date: lastBarDateTurkey.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }),
                        time: lastTimeStr,
                        signal: lastSignal.direction,
                        entry: lastSignal.entry,  // ✅ Sinyal alındığında gelen entry fiyatı (closes[closedBarIndex] DEĞİL)
                        exit: closes[lastBarIndex],
                        takeProfit: lastSignal.tp,
                        stopLoss: lastSignal.stop,
                        profit: lastTradeProfit,  // Kar/Zarar (number)
                        score: lastSignal.score,
                        duration: 'AÇIK',  // Son bar'da yeni açılan işlem
                        isOpen: true,  // Bu AÇIK işlem
                        actualTP: false,  // Henüz TP vurmadı
                        actualSL: false   // Henüz SL vurmadı
                    };
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
            trades: allTrades.slice(0, 50), // Tarih sırasıyla en yeni en başta, max 50 işlem
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
        this.startRealtimeSubscription();
    }
    
    async addAlarm(symbolOrAlarm, targetPrice, condition, type = 'price') {
        // Eğer ilk parametre object ise (yeni format)
        let alarm;
        if (typeof symbolOrAlarm === 'object') {
            alarm = {
                id: Date.now() + Math.random(),
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
                createdAt: new Date(),
                triggered: false,
                triggeredAt: null
            };
        }
        
        this.alarms.push(alarm);
        await this.saveAlarms();
        
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

                if (alarm) {
                    // Fallback: alarm_id eşleşmezse ilgili sembol/timeframe sinyallerini temizle
                    let fallbackSignalDelete = this.supabase
                        .from('active_signals')
                        .delete()
                        .eq('user_id', this.userId)
                        .eq('symbol', alarm.symbol || 'BTCUSDT');

                    if (alarm.timeframe) {
                        fallbackSignalDelete = fallbackSignalDelete.eq('timeframe', alarm.timeframe);
                    }
                    if (alarm.marketType) {
                        fallbackSignalDelete = fallbackSignalDelete.eq('market_type', alarm.marketType);
                    }

                    const fallbackSignalsResult = await fallbackSignalDelete;
                    console.log('🧹 Active signals fallback temizlendi:', fallbackSignalsResult);
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
        alarm.status = 'KAPATILDI';
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
            if (alarm.type === 'ACTIVE_TRADE' && alarm.status === 'AKTIF') {
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
                    alarm.status = 'KAPATILDI';
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
        
        if (!this.supabase || !this.userId) {
            console.error('❌ [TELEGRAM] Supabase veya userId eksik - Bildirim gönderilemiyor');
            console.error('  - Supabase:', !!this.supabase);
            console.error('  - UserId:', this.userId);
            return;
        }

        try {
            // Kullanıcının Telegram ayarlarını al
            console.log('📱 [TELEGRAM] user_settings sorgulanıyor...');
            const { data: userSettings, error } = await this.supabase
                .from('user_settings')
                .select('telegram_username, notifications_enabled')
                .eq('user_id', this.userId)
                .single();

            console.log('📊 [TELEGRAM] user_settings sorgu sonucu:', { 
                hasData: !!userSettings, 
                hasError: !!error,
                error: error?.message,
                username: userSettings?.telegram_username
            });

            if (error) {
                console.error('❌ [TELEGRAM] user_settings sorgu hatası:', error);
                throw error;
            }

            if (!userSettings) {
                console.error('❌ [TELEGRAM] user_settings kaydı bulunamadı');
                return;
            }

            if (!userSettings.notifications_enabled) {
                console.warn('⚠️ [TELEGRAM] Bildirimler devre dışı');
                return;
            }

            if (!userSettings.telegram_username) {
                console.error('❌ [TELEGRAM] Telegram Chat ID (username) boş');
                return;
            }

            let messageText = '';

            // PRICE_LEVEL (fiyat seviye) alarmı için detaylı mesaj
            if (alarm.type === 'PRICE_LEVEL') {
                const conditionText = alarm.condition === 'above' ? '⬆️ FİYAT ÜZERİNE ÇIKTI' : '⬇️ FİYAT ALTINA İNDİ';
                
                // Alarm kurulduğu fiyattan itibaren kar/zarar hesapla
                const profit = ((currentPrice - alarm.targetPrice) / alarm.targetPrice * 100).toFixed(2);
                const profitEmoji = parseFloat(profit) > 0 ? '💚' : '❤️';
                
                messageText = `
🚨 *${symbol}* Alarm Pasif Oldu!

${conditionText}
🎯 Hedef Fiyat: *$${alarm.targetPrice?.toFixed(2) || '?'}*
💹 Güncel Fiyat: *$${currentPrice?.toFixed(2) || '?'}*
${profitEmoji} Değişim: *${profit}%*

⏰ Zaman: ${new Date().toLocaleString('tr-TR')}
                `.trim();
            } else if (alarm.type === 'ACTIVE_TRADE') {
                // İşlem kapanış alarmı - entry, TP, SL ve kar/zarar göster
                const directionEmoji = alarm.direction === 'LONG' ? '📈' : '📉';
                const entryPrice = alarm.entryPrice || currentPrice;
                
                // Kar/zarar hesapla
                const profit = alarm.direction === 'LONG'
                    ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2)
                    : ((entryPrice - currentPrice) / entryPrice * 100).toFixed(2);
                const profitEmoji = parseFloat(profit) > 0 ? '💚' : '❤️';
                
                // Kesişim algılandı mı kontrol et
                if (alarm.intersectionDetected) {
                    // Pasif alarmlarla kesişim mesajı
                    messageText = `
📍 *PASIF ALARM KESİŞİMİ ALGILANDI*

${directionEmoji} *${symbol}* - ${alarm.direction} İşlem

💰 Giriş Fiyatı: *$${entryPrice?.toFixed(2) || '?'}*
🎯 Güncel Fiyat: *$${currentPrice?.toFixed(2) || '?'}*
${profitEmoji} Mevcut Kar/Zarar: *${profit}%*

🚨 ${alarm.triggerReason || 'Pasif alarm seviyesine ulaştı'}

📊 Detaylar:
• Take Profit: $${alarm.takeProfit?.toFixed(2) || '?'}
• Stop Loss: $${alarm.stopLoss?.toFixed(2) || '?'}
• Zaman: ${new Date().toLocaleString('tr-TR')}
                    `.trim();
                } else {
                    // Normal işlem kapanış mesajı (TP/SL)
                    messageText = `
${directionEmoji} *${symbol}* - ${alarm.direction} İşlem Kapandı

💰 Giriş Fiyatı: *$${entryPrice?.toFixed(2) || '?'}*
🎯 Çıkış Fiyatı: *$${currentPrice?.toFixed(2) || '?'}*
${profitEmoji} Kar/Zarar: *${profit}%*

📊 Detaylar:
• Take Profit: $${alarm.takeProfit?.toFixed(2) || '?'}
• Stop Loss: $${alarm.stopLoss?.toFixed(2) || '?'}
• Kapatılma: ${new Date().toLocaleString('tr-TR')}
                    `.trim();
                }
            } else {
                // Diğer alarm türleri için fallback
                messageText = `🚨 *${symbol}* Alarm Tetiklendi!\n⏰ Zaman: ${new Date().toLocaleString('tr-TR')}`;
            }

            if (!messageText) {
                console.warn('⚠️ Mesaj metni boş, gönderme yapılmıyor');
                return;
            }

            const chatId = userSettings.telegram_username;

            if (!TELEGRAM_BOT_TOKEN_SAFE) {
                console.warn('⚠️ [TELEGRAM] Bot token tanımlı değil, gönderim atlandı');
                return;
            }

            console.log('📤 [TELEGRAM] Mesaj hazırlanıyor:', { 
                chatId,
                type: alarm.type,
                symbol,
                messagePreview: messageText.substring(0, 100) + '...'
            });

            // Telegram API'ye gönder
            console.log('🌐 [TELEGRAM] Edge Function çağrılıyor...');
            const response = await fetch(
                'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/dynamic-responder',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramUsername: chatId,
                        botToken: TELEGRAM_BOT_TOKEN_SAFE,
                        message: messageText,
                        parse_mode: 'Markdown'
                    })
                }
            );

            if (!response.ok) {
                console.error('❌ [TELEGRAM] Fetch başarısız, status:', response.status);
                const text = await response.text();
                console.error('❌ [TELEGRAM] Hata detayı:', text);
                throw new Error(`Telegram API hatası: ${response.status} - ${text}`);
            }

            const result = await response.json();
            console.log('✅ [TELEGRAM] API yanıtı başarılı:', result);

            if (result.ok || result.success) {
                console.log('✅ [TELEGRAM] ✨ Telegram bildirimi başarıyla gönderildi ✨');
            } else {
                console.warn('⚠️ [TELEGRAM] API başarılı yanıt verdi ama ok/success false:', result);
            }

        } catch (error) {
            console.error('❌ [TELEGRAM] 🔴 TELEGRAM BİLDİRİM GÖNDERME HATASI 🔴:', error.message);
            console.error('   Detay:', error);
        }
    }

    async sendTelegramAlarmCreated(alarm) {
        console.log('� [TELEGRAM] Alarm bildirimi gönderiliyor (oluşturma):', { type: alarm.type, symbol: alarm.symbol });
        
        if (!this.supabase || !this.userId) {
            return;
        }

        try {
            console.log('📱 Supabase user_settings kontrol ediliyor...');
            const { data: userSettings, error } = await this.supabase
                .from('user_settings')
                .select('telegram_username, notifications_enabled')
                .eq('user_id', this.userId)
                .single();

            console.log('📊 user_settings sorgusu:', { userSettings, error });

            if (error) {
                console.warn('⚠️ Sorgu hatası:', error.message);
                return;
            }

            if (!userSettings) {
                console.warn('⚠️ user_settings kaydı bulunamadı');
                return;
            }

            if (!userSettings.telegram_username) {
                console.warn('⚠️ Telegram username (Chat ID) boş');
                return;
            }

            if (!userSettings.notifications_enabled) {
                console.log('ℹ️ Notifications devre dışı');
                return;
            }

            // Telegram şablonunu oluştur
            let messageText;
            const targetPrice = alarm.targetPrice || alarm.price || alarm.target;
            
            if (targetPrice) {
                messageText = TelegramNotificationTemplates.alarmCreated({
                    symbol: alarm.symbol,
                    targetPrice: Number(targetPrice).toFixed(2),
                    condition: alarm.condition || 'N/A',
                    timestamp: new Date().toLocaleString('tr-TR')
                });
            } else {
                // Fiyat hedefi yoksa basit mesaj
                messageText = `✅ *Alarm Oluşturuldu!*\n\n📊 Kripto: *${alarm.symbol}*\n⏰ Saat: ${new Date().toLocaleString('tr-TR')}`;
            }

            const chatId = userSettings.telegram_username;

            console.log('📤 Telegram mesajı gönderiliyor:', {
                chatId,
                messageLength: messageText.length,
                botTokenExists: !!TELEGRAM_BOT_TOKEN_SAFE
            });

            if (!TELEGRAM_BOT_TOKEN_SAFE) {
                console.warn('⚠️ [TELEGRAM] Bot token tanımlı değil, gönderim atlandı');
                return;
            }

            const response = await fetch(
                'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/dynamic-responder',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramUsername: chatId,
                        botToken: TELEGRAM_BOT_TOKEN_SAFE,
                        message: messageText,
                        parse_mode: 'Markdown'
                    })
                }
            );

            const result = await response.json();
            console.log('✅ Alarm oluşturuldu, Telegram\'a gönderildi');

        } catch (error) {
            console.error('❌ [TELEGRAM] sendTelegramAlarmCreated error:', error);
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
            console.error('   - this.supabase:', !!this.supabase);
            console.error('   - this.userId:', this.userId);
            return;
        }

        try {
            // Kullanıcının Telegram ayarlarını al
            console.log('📱 [TELEGRAM PASIF] user_settings sorgulanıyor...');
            const { data: userSettings, error } = await this.supabase
                .from('user_settings')
                .select('telegram_username, notifications_enabled')
                .eq('user_id', this.userId)
                .single();

            console.log('📊 [TELEGRAM PASIF] Sorgu sonucu:', {
                success: !error,
                error: error?.message,
                hasUsername: !!userSettings?.telegram_username,
                notificationsEnabled: userSettings?.notifications_enabled
            });

            if (error) {
                console.error('❌ [TELEGRAM PASIF] Supabase sorgu hatası:', error.message);
                return;
            }

            if (!userSettings) {
                console.error('❌ [TELEGRAM PASIF] user_settings kaydı bulunamadı');
                return;
            }

            if (!userSettings.telegram_username) {
                console.error('❌ [TELEGRAM PASIF] Telegram username boş!');
                console.log('   - user_settings:', userSettings);
                return;
            }

            if (!userSettings.notifications_enabled) {
                console.warn('⚠️ [TELEGRAM PASIF] Bildirimler devre dışı kullanıcı tarafından');
                return;
            }

            let messageText = '';

            // ACTIVE_TRADE (işlem) alarmı için
            if (alarm.type === 'ACTIVE_TRADE') {
                console.log('📈 [TELEGRAM PASIF] ACTIVE_TRADE mesajı hazırlanıyor...');
                
                const directionEmoji = alarm.direction === 'LONG' ? '📈' : '📉';
                const entryPrice = alarm.entryPrice || 0;
                const currentPrice = alarm.closePrice || alarm.currentPrice || entryPrice;
                
                // Kar/zarar hesapla
                let pnl = 0;
                if (alarm.direction === 'LONG') {
                    pnl = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
                } else {
                    pnl = ((entryPrice - currentPrice) / entryPrice * 100).toFixed(2);
                }
                
                const pnlEmoji = parseFloat(pnl) > 0 ? '💚' : '❤️';
                
                messageText = `
${directionEmoji} *${alarm.symbol}* - ${alarm.direction} İşlem Pasif Oldu

💰 Giriş: *$${entryPrice?.toFixed(2) || '?'}*
🎯 Çıkış: *$${currentPrice?.toFixed(2) || '?'}*
${pnlEmoji} Kar/Zarar: *${pnl}%*

📊 İşlem Detayları:
• TP Seviyesi: $${alarm.takeProfit?.toFixed(2) || '?'}
• SL Seviyesi: $${alarm.stopLoss?.toFixed(2) || '?'}
• Durumu: KAPATILDI
• Zaman: ${new Date().toLocaleString('tr-TR')}

✅ İşlem başarıyla sonlandırıldı
                `.trim();
            } else if (alarm.type === 'PRICE_LEVEL') {
                console.log('📌 [TELEGRAM PASIF] PRICE_LEVEL mesajı hazırlanıyor...');
                
                // Fiyat seviyesi alarmı - sadeleştirilmiş mesaj
                messageText = `
⏹️ *${alarm.symbol}* - Alarm Kapatıldı

✅ Alarm başarıyla devre dışı bırakıldı
⏰ Zaman: ${new Date().toLocaleString('tr-TR')}
                `.trim();
            } else {
                console.warn('⚠️ [TELEGRAM PASIF] Bilinmeyen alarm tipi:', alarm.type);
                messageText = `⏹️ *${alarm.symbol}* Alarmı Pasif Hale Geçti\n⏰ Zaman: ${new Date().toLocaleString('tr-TR')}`;
            }

            if (!messageText) {
                console.error('❌ [TELEGRAM PASIF] Mesaj metni boş!');
                return;
            }

            const chatId = userSettings.telegram_username;

            console.log('📤 [TELEGRAM PASIF] Telegram mesajı gönderiliyor...', {
                chatId,
                messageLength: messageText.length,
                botTokenExists: !!TELEGRAM_BOT_TOKEN_SAFE
            });

            if (!TELEGRAM_BOT_TOKEN_SAFE) {
                console.warn('⚠️ [TELEGRAM PASIF] Bot token tanımlı değil, gönderim atlandı');
                return;
            }

            const response = await fetch(
                'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/dynamic-responder',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramUsername: chatId,
                        botToken: TELEGRAM_BOT_TOKEN_SAFE,
                        message: messageText,
                        parse_mode: 'Markdown'
                    })
                }
            );

            console.log('🌐 [TELEGRAM PASIF] API Response Status:', response.status, response.statusText);

            if (!response.ok) {
                console.error('❌ [TELEGRAM PASIF] API Hatası!', response.status);
                const text = await response.text();
                console.error('   - Response body:', text);
                return;
            }

            const result = await response.json();
            console.log('✅ [TELEGRAM PASIF] ✨ BAŞARILI ✨', result);

        } catch (error) {
            console.error('❌ [TELEGRAM PASIF] 🔴 KRITIK HATA 🔴:', error.message);
            console.error('   - Stack:', error.stack);
        }
    }

    async sendTelegramAlarmEnded(alarm, reason = 'deleted') {
        if (!this.supabase || !this.userId) return;

        try {
            const { data: userSettings } = await this.supabase
                .from('user_settings')
                .select('telegram_username, notifications_enabled')
                .eq('user_id', this.userId)
                .single();

            if (!userSettings || !userSettings.notifications_enabled || !userSettings.telegram_username) {
                return;
            }

            let message = '';
            
            // PRICE_LEVEL alarmları
            if (alarm.type === 'PRICE_LEVEL') {
                const targetPrice = alarm.targetPrice || alarm.price || alarm.target;
                if (!targetPrice) return;
                
                message = `
🚫 *${alarm.symbol}* - Alarm Kapatıldı

🎯 Hedef Fiyat: *$${Number(targetPrice).toFixed(2)}*
⏰ Zaman: ${new Date().toLocaleString('tr-TR')}
                `.trim();
            } 
            // ACTIVE_TRADE alarmları
            else if (alarm.type === 'ACTIVE_TRADE') {
                const directionEmoji = alarm.direction === 'LONG' ? '📈' : '📉';
                message = `
${directionEmoji} *${alarm.symbol}* - ${alarm.direction} İşlem Silindi

🚫 Alarm kapatıldı
⏰ Zaman: ${new Date().toLocaleString('tr-TR')}
                `.trim();
            } else {
                return;
            }

            const chatId = userSettings.telegram_username;

            if (!TELEGRAM_BOT_TOKEN_SAFE) {
                return;
            }

            await fetch(
                'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/dynamic-responder',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramUsername: chatId,
                        botToken: TELEGRAM_BOT_TOKEN_SAFE,
                        message: message,
                        parse_mode: 'Markdown'
                    })
                }
            );
            
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
                console.log('🗑️ Eski alarmları siliyorum...');
                // Önce eski verileri sil
                await this.supabase
                    .from('alarms')
                    .delete()
                    .eq('user_id', this.userId)
                    .eq('type', 'user_alarm');
                
                // Tüm alarmları bir kez map et ve insert et (loop değil!)
                const alarmsData = this.alarms.map(alarm => {
                    const autoTradeEnabled = alarm.autoTradeEnabled || alarm.auto_trade_enabled || false;
                    const rawBarCloseLimit = alarm.barCloseLimit ?? alarm.bar_close_limit;
                    const normalizedBarCloseLimit = (rawBarCloseLimit === null || rawBarCloseLimit === undefined)
                        ? 5
                        : (Number.isFinite(Number(rawBarCloseLimit)) && Number(rawBarCloseLimit) > 0
                            ? Number(rawBarCloseLimit)
                            : 5);
                    const resolvedBarCloseLimit = autoTradeEnabled ? null : normalizedBarCloseLimit;
                    const baseData = {
                        user_id: this.userId,
                        symbol: alarm.symbol || 'BTCUSDT',
                        timeframe: alarm.timeframe || '1h',
                        market_type: alarm.marketType || 'spot',
                        type: 'user_alarm',
                        is_active: alarm.active !== false,
                        telegram_enabled: true,
                        telegram_chat_id: this.telegramChatId || null,
                        confidence_score: String(alarm.confidenceScore || alarm.confidence_score || '60'),
                        tp_percent: String(alarm.takeProfitPercent || alarm.tp_percent || '5'),
                        sl_percent: String(alarm.stopLossPercent || alarm.sl_percent || '3'),
                        bar_close_limit: resolvedBarCloseLimit,
                        auto_trade_enabled: autoTradeEnabled
                    };
                    
                    // Alarm türüne göre ek alanlar
                    if (alarm.type === 'price' || alarm.type === 'PRICE_LEVEL') {
                        return {
                            ...baseData,
                            target_price: alarm.targetPrice || alarm.target_price,
                            condition: alarm.condition || 'above'
                        };
                    } else if (alarm.type === 'trade' || alarm.type === 'ACTIVE_TRADE') {
                        return {
                            ...baseData,
                            direction: alarm.direction || 'LONG',
                            entry_price: alarm.entryPrice || alarm.entry_price,
                            take_profit: alarm.takeProfit || alarm.take_profit,
                            stop_loss: alarm.stopLoss || alarm.stop_loss
                        };
                    }
                    
                    // Default olarak price alarm
                    return {
                        ...baseData,
                        target_price: alarm.targetPrice || alarm.target_price,
                        condition: alarm.condition || 'above'
                    };
                });
                
                // Eğer boş değilse insert et
                if (alarmsData.length > 0) {
                    console.log('📤 Insert data:', alarmsData.length, 'alarms');
                    const insertResult = await this.supabase
                        .from('alarms')
                        .insert(alarmsData);
                    
                    console.log('✅ Insert result:', insertResult);
                }
                
                console.log('💾 Alarmlar alarms tablosuna kaydedildi');
                // Supabase id'lerini local'e senkronize et
                await this.loadAlarms();
            } catch (error) {
                console.error('❌ Supabase kayıt hatası:', error);
            }
        } else {
            console.log('⚠️ Supabase client veya userId yok, sadece localStorage kaydedildi');
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
                
                if (data && data.length > 0) {
                    this.alarms = data.map(item => {
                        const autoTradeEnabled = item.auto_trade_enabled === true;
                        const rawBarCloseLimit = item.bar_close_limit;
                        const barCloseLimitValue = (rawBarCloseLimit === null || rawBarCloseLimit === undefined)
                            ? (autoTradeEnabled ? null : 5)
                            : (Number.isFinite(Number(rawBarCloseLimit)) && Number(rawBarCloseLimit) > 0
                                ? Number(rawBarCloseLimit)
                                : (autoTradeEnabled ? null : 5));
                        const barCloseLimitDisplay = barCloseLimitValue === null ? 99 : barCloseLimitValue;
                        const baseAlarm = {
                            id: String(item.id),  // Convert BIGSERIAL number to string for consistent type handling
                            symbol: item.symbol,
                            timeframe: item.timeframe,
                            marketType: item.market_type || 'spot',
                            active: item.is_active,
                            createdAt: item.created_at,
                            confidenceScore: parseInt(item.confidence_score) || 60,
                            takeProfitPercent: parseInt(item.tp_percent) || 5,
                            stopLossPercent: parseInt(item.sl_percent) || 3,
                            barCloseLimit: barCloseLimitValue,
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
                            description: `Güven skoru: ${item.confidence_score}%, TP: ${item.tp_percent}%, SL: ${item.sl_percent}%, Bar: ${barCloseLimitDisplay}`
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
        if (!this.supabase || !this.userId) return;

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

    // 6.1 BACKEND-ALIGNED SİNYAL SKORU (Alarm ile aynı)
    function generateSignalScoreAligned(indicators, price, sr, closes, volumes, userConfidenceThreshold = 70) {
        const macdValue = Number(indicators?.macd?.macd ?? indicators?.macd ?? 0);
        const stochK = Number(indicators?.stoch?.k ?? indicators?.stoch?.K ?? 0);

        // TREND (%40)
        let trendScore = 0;
        if (indicators.ema12 > indicators.ema26 && indicators.sma20 > indicators.sma50) {
            trendScore += 30;
        } else if (indicators.ema12 < indicators.ema26 && indicators.sma20 < indicators.sma50) {
            trendScore -= 30;
        }
        if (indicators.adx > 25) {
            trendScore += Math.min((indicators.adx - 25) * 0.8, 20);
        }

        // MOMENTUM (%30)
        let momentumScore = 0;
        if (indicators.rsi < 30) momentumScore += 25;
        else if (indicators.rsi < 40) momentumScore += 15;
        else if (indicators.rsi > 70) momentumScore -= 25;
        else if (indicators.rsi > 60) momentumScore -= 15;

        momentumScore += macdValue > 0 ? 10 : -10;
        if (stochK < 20) momentumScore += 10;
        else if (stochK > 80) momentumScore -= 10;

        // VOLUME (%15)
        let volumeScore = 0;
        let obvTrend = 'flat';
        if (Array.isArray(closes) && closes.length >= 2) {
            if (closes[closes.length - 1] > closes[closes.length - 2]) obvTrend = 'rising';
            else if (closes[closes.length - 1] < closes[closes.length - 2]) obvTrend = 'falling';
        }
        if (obvTrend === 'rising') volumeScore += 10;
        else if (obvTrend === 'falling') volumeScore -= 10;

        const volumeMA = Array.isArray(volumes) && volumes.length > 0
            ? volumes.reduce((a, b) => a + b, 0) / volumes.length
            : 0;
        if (volumeMA > 0) volumeScore += 15;
        else volumeScore -= 10;

        // SUPPORT/RESISTANCE (%15)
        let srScore = 0;
        const nearestSupport = sr?.supports?.[0]?.price || (price * 0.95);
        const nearestResistance = sr?.resistances?.[0]?.price || (price * 1.05);
        if (nearestSupport > 0 && nearestResistance > 0 && price > 0) {
            const distanceToSupport = (price - nearestSupport) / price;
            const distanceToResistance = (nearestResistance - price) / price;
            if (distanceToSupport < 0.02) srScore += 15;
            if (distanceToResistance < 0.02) srScore -= 15;
        }

        const normalizedTrendScore = (trendScore / 50) * 40;
        const normalizedMomentumScore = (momentumScore / 50) * 30;
        const normalizedVolumeScore = (volumeScore / 25) * 15;
        const normalizedSRScore = (srScore / 30) * 15;
        const totalScore = normalizedTrendScore + normalizedMomentumScore + normalizedVolumeScore + normalizedSRScore;

        const direction = totalScore > 0 ? 'LONG' : 'SHORT';
        const confidence = Math.min(Math.max(Math.abs(totalScore), 0), 100);
        const triggered = confidence >= userConfidenceThreshold;

        return {
            direction,
            score: Math.round(confidence),
            triggered
        };
    }
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
    generateAdvancedSignal,
    runBacktest,
    predictNextPrice,
    AlarmSystem,
    RiskCalculator,
    fetchCryptoNews,
    fetchMarketSentiment
};