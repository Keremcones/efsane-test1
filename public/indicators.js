// Teknik İndikatör Hesaplama Fonksiyonları

function calculateSMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period) return 50;

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
    return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    if (!ema12 || !ema26) return null;
    
    const macdLine = ema12 - ema26;
    return { macd: macdLine, signal: 0, histogram: 0 };
}

function calculateBollingerBands(prices, period = 20) {
    const sma = calculateSMA(prices, period);
    if (!sma) return null;
    
    const slice = prices.slice(-period);
    const squaredDiffs = slice.map(price => Math.pow(price - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(variance);
    
    return {
        upper: sma + (stdDev * 2),
        middle: sma,
        lower: sma - (stdDev * 2)
    };
}

function calculateStochastic(highs, lows, closes, period = 14) {
    if (closes.length < period) return null;
    
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const currentClose = closes[closes.length - 1];
    
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    
    const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    return { k, d: k };
}

function calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return null;
    
    let tr = [];
    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];
        
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        
        tr.push(Math.max(tr1, tr2, tr3));
    }
    
    return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateADX(highs, lows, closes, period = 14) {
    const atr = calculateATR(highs, lows, closes, period);
    if (!atr) return null;
    
    let dmPlus = 0, dmMinus = 0;
    for (let i = 1; i < highs.length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        
        if (upMove > downMove && upMove > 0) dmPlus += upMove;
        if (downMove > upMove && downMove > 0) dmMinus += downMove;
    }
    
    const diPlus = (dmPlus / period / atr) * 100;
    const diMinus = (dmMinus / period / atr) * 100;
    const dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
    
    return dx;
}

function calculateOBV(closes, volumes) {
    let obv = 0;
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) obv += volumes[i];
        else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    return obv;
}

function calculateCCI(highs, lows, closes, period = 20) {
    if (closes.length < period) return null;
    
    const tps = closes.map((close, i) => (highs[i] + lows[i] + close) / 3);
    const sma = calculateSMA(tps, period);
    
    const slice = tps.slice(-period);
    const meanDev = slice.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;
    
    const currentTP = tps[tps.length - 1];
    return (currentTP - sma) / (0.015 * meanDev);
}

function findSupportResistance(highs, lows, closes) {
    const period = Math.min(50, closes.length);
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    
    const pivots = [];
    for (let i = 2; i < period - 2; i++) {
        // Tepe noktası
        if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
            recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
            pivots.push({ price: recentHighs[i], type: 'resistance' });
        }
        // Dip noktası
        if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
            recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
            pivots.push({ price: recentLows[i], type: 'support' });
        }
    }
    
    const currentPrice = closes[closes.length - 1];
    const supports = pivots
        .filter(p => p.type === 'support' && p.price < currentPrice)
        .sort((a, b) => b.price - a.price)
        .slice(0, 3);
    
    const resistances = pivots
        .filter(p => p.type === 'resistance' && p.price > currentPrice)
        .sort((a, b) => a.price - b.price)
        .slice(0, 3);
    
    // Yeterli seviye yoksa hesaplanmış seviyeler ekle
    while (supports.length < 3) {
        const minPrice = Math.min(...recentLows);
        const level = currentPrice - (currentPrice - minPrice) * (0.3 * (supports.length + 1));
        supports.push({ price: level, type: 'support' });
    }
    
    while (resistances.length < 3) {
        const maxPrice = Math.max(...recentHighs);
        const level = currentPrice + (maxPrice - currentPrice) * (0.3 * (resistances.length + 1));
        resistances.push({ price: level, type: 'resistance' });
    }
    
    return { supports, resistances };
}

// YENİ EKLENEN: Divergence hesaplama
function calculateDivergence(prices, rsiValues, lookback = 30) {
    if (!prices || !rsiValues || prices.length < lookback || rsiValues.length < lookback) {
        return null;
    }
    
    const recentPrices = prices.slice(-lookback);
    const recentRSI = rsiValues.slice(-lookback);
    
    // Fiyat ve RSI tepe/dip noktalarını bul
    const pricePeaks = findPricePeaks(recentPrices);
    const priceTroughs = findPriceTroughs(recentPrices);
    const rsiPeaks = findRSIPeaks(recentRSI);
    const rsiTroughs = findRSITroughs(recentRSI);
    
    let bearishDivergence = false;
    let bullishDivergence = false;
    
    // Bearish Divergence: Fiyat yükseliyor, RSI düşüyor
    if (pricePeaks.length >= 2 && rsiPeaks.length >= 2) {
        const lastPricePeak = pricePeaks[pricePeaks.length - 1];
        const prevPricePeak = pricePeaks[pricePeaks.length - 2];
        const lastRSIPeak = rsiPeaks[rsiPeaks.length - 1];
        const prevRSIPeak = rsiPeaks[rsiPeaks.length - 2];
        
        if (lastPricePeak.value > prevPricePeak.value && 
            lastRSIPeak.value < prevRSIPeak.value) {
            bearishDivergence = true;
        }
    }
    
    // Bullish Divergence: Fiyat düşüyor, RSI yükseliyor
    if (priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
        const lastPriceTrough = priceTroughs[priceTroughs.length - 1];
        const prevPriceTrough = priceTroughs[priceTroughs.length - 2];
        const lastRSITrough = rsiTroughs[rsiTroughs.length - 1];
        const prevRSITrough = rsiTroughs[rsiTroughs.length - 2];
        
        if (lastPriceTrough.value < prevPriceTrough.value && 
            lastRSITrough.value > prevRSITrough.value) {
            bullishDivergence = true;
        }
    }
    
    return {
        bearishDivergence,
        bullishDivergence,
        hasDivergence: bearishDivergence || bullishDivergence,
        type: bearishDivergence ? 'BEARISH' : bullishDivergence ? 'BULLISH' : 'NONE'
    };
}

// Yardımcı fonksiyonlar
function findPricePeaks(prices, threshold = 0.02) {
    const peaks = [];
    for (let i = 2; i < prices.length - 2; i++) {
        if (prices[i] > prices[i-1] && prices[i] > prices[i-2] &&
            prices[i] > prices[i+1] && prices[i] > prices[i+2]) {
            peaks.push({ index: i, value: prices[i] });
        }
    }
    return peaks;
}

function findPriceTroughs(prices) {
    const troughs = [];
    for (let i = 2; i < prices.length - 2; i++) {
        if (prices[i] < prices[i-1] && prices[i] < prices[i-2] &&
            prices[i] < prices[i+1] && prices[i] < prices[i+2]) {
            troughs.push({ index: i, value: prices[i] });
        }
    }
    return troughs;
}

function findRSIPeaks(rsiValues) {
    return findPricePeaks(rsiValues);
}

function findRSITroughs(rsiValues) {
    return findPriceTroughs(rsiValues);
}

// RSI array hesaplama
function calculateRSIArray(prices, period = 14) {
    if (prices.length < period + 1) return Array(prices.length).fill(50);
    
    const rsiArray = [];
    for (let i = period; i <= prices.length; i++) {
        const slice = prices.slice(i - period, i);
        rsiArray.push(calculateRSI(slice, period));
    }
    
    // Başlangıç değerlerini doldur
    while (rsiArray.length < prices.length) {
        rsiArray.unshift(50);
    }
    
    return rsiArray;
}

// Güncellenmiş calculateIndicators
function calculateIndicators(closes, highs, lows, volumes) {
    const indicators = {
        sma20: calculateSMA(closes, 20),
        sma50: calculateSMA(closes, 50),
        ema12: calculateEMA(closes, 12),
        ema26: calculateEMA(closes, 26),
        rsi: calculateRSI(closes, 14),
        macd: calculateMACD(closes),
        bb: calculateBollingerBands(closes, 20),
        stoch: calculateStochastic(highs, lows, closes, 14),
        atr: calculateATR(highs, lows, closes, 14),
        adx: calculateADX(highs, lows, closes, 14),
        obv: calculateOBV(closes, volumes),
        cci: calculateCCI(highs, lows, closes, 20)
    };
    
    // Yeni eklenenler
    indicators.rsiArray = calculateRSIArray(closes, 14);
    indicators.divergence = calculateDivergence(closes, indicators.rsiArray);
    
    return indicators;
}

function generateSignal(indicators, price, sr) {
    const rsi = indicators.rsi;
    const macd = indicators.macd;
    const adx = indicators.adx;
    const cci = indicators.cci;
    const divergence = indicators.divergence;
    
    let score = 0;
    
    // RSI sinyalleri
    if (rsi < 30) score += 2;
    else if (rsi < 40) score += 1;
    else if (rsi > 70) score -= 2;
    else if (rsi > 60) score -= 1;
    
    // MACD sinyali
    if (macd.macd > 0) score += 1;
    else score -= 1;
    
    // ADX trend gücü
    if (adx > 25) score += (score > 0 ? 1 : -1);
    
    // CCI
    if (cci < -100) score += 1;
    else if (cci > 100) score -= 1;
    
    // Divergence bonusları
    if (divergence) {
        if (divergence.bullishDivergence) score += 3;
        if (divergence.bearishDivergence) score -= 3;
    }
    
    const direction = score > 0 ? 'LONG' : 'SHORT';
    
    // Trading seviyeleri
    let entry, stop, tp;
    
    if (direction === 'LONG') {
        entry = price;
        stop = sr.supports[0]?.price || (price * 0.97);
        tp = sr.resistances[0]?.price || (price * 1.05);
    } else {
        entry = price;
        stop = sr.resistances[0]?.price || (price * 1.03);
        tp = sr.supports[0]?.price || (price * 0.95);
    }
    
    return {
        direction,
        entry: entry.toFixed(2),
        stop: stop.toFixed(2),
        tp: tp.toFixed(2),
        score: Math.abs(score),
        hasDivergence: divergence?.hasDivergence || false,
        divergenceType: divergence?.type || 'NONE'
    };
}
