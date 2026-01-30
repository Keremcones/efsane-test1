# 🔧 WebSocket Bağlantı Hatası Çözümü

## 📍 Sorunlar
1. **"Ping received after close"** → Bağlantı kapanmış ama server ping gönderiyor
2. **"ERR_NETWORK_IO_SUSPENDED"** → Ağ kesintisi, browser suspend

## 🔍 Kök Nedenler
- ❌ Global `wsConnection` variable (multiple symbols clash)
- ❌ Ping timeout mekanizması yok
- ❌ Connection timeout yok
- ❌ Reconnect retry logic eksik/yanlış
- ❌ Browser suspend'den recovery yok

---

## ✅ Çözüm

**Yol:** `public/index.html` satır 2410-2520

**Eski kodu** şu ile değiştir:

```javascript
// ==========================================
// WebSocket Manager v2 (Fixed)
// ==========================================
const wsState = {};

function initWSState(symbol) {
    const n = symbol.toLowerCase();
    if (!wsState[n]) {
        wsState[n] = {
            conn: null,
            retries: 0,
            retryTo: null,
            pingTo: null,
            lastMsg: Date.now()
        };
    }
    return wsState[n];
}

function startWebSocketUpdates(symbol) {
    if (!symbol) return;
    const n = symbol.toLowerCase();
    const s = initWSState(symbol);
    
    // Eski bağlantıyı kapat
    if (s.conn) try { s.conn.close(1000); } catch(e) {}
    if (s.retryTo) clearTimeout(s.retryTo);
    if (s.pingTo) clearTimeout(s.pingTo);
    
    const url = `wss://stream.binance.com:9443/ws/${n}@ticker`;
    console.log(`🔌 WS başlanıyor: ${symbol}`);
    
    try {
        s.conn = new WebSocket(url);
        const connTo = setTimeout(() => {
            if (s.conn.readyState !== WebSocket.OPEN) {
                console.warn(`⏱️ Connection timeout: ${symbol}`);
                s.conn.close();
                reconnectWS(symbol);
            }
        }, 10000);
        
        s.conn.onopen = () => {
            clearTimeout(connTo);
            s.retries = 0;
            s.lastMsg = Date.now();
            console.log(`✅ WS bağlı: ${symbol}`);
            setupPingCheck(symbol);
        };
        
        s.conn.onmessage = (e) => {
            s.lastMsg = Date.now();
            if (s.pingTo) clearTimeout(s.pingTo);
            setupPingCheck(symbol);
            
            try {
                const d = JSON.parse(e.data);
                const p = parseFloat(d.c);
                if (!isFinite(p)) return;
                
                localStorage.setItem(`price_${symbol}`, p);
                window.currentPriceData = p;
                updatePriceDisplay?.(p, d.P);
                loadAlarms?.();
                checkActiveTradeLevels?.(symbol, p);
                alarmSystem?.checkAlarms?.(p, symbol);
            } catch(x) {
                console.error(`Parse hatası (${symbol}):`, x.message);
            }
        };
        
        s.conn.onerror = (e) => {
            clearTimeout(connTo);
            console.error(`❌ WS hata (${symbol}):`, e?.type || e);
            startPollingUpdates?.(symbol);
            reconnectWS(symbol);
        };
        
        s.conn.onclose = (e) => {
            clearTimeout(connTo);
            console.log(`⛔ WS kapalı (${symbol}). Code: ${e.code}`);
            if (s.pingTo) clearTimeout(s.pingTo);
            s.conn = null;
            
            if (e.code !== 1000) reconnectWS(symbol);
        };
        
    } catch(e) {
        console.error(`Oluşturma hatası (${symbol}):`, e.message);
        startPollingUpdates?.(symbol);
        reconnectWS(symbol);
    }
}

function setupPingCheck(symbol) {
    const s = wsState[symbol.toLowerCase()];
    if (!s) return;
    
    if (s.pingTo) clearTimeout(s.pingTo);
    
    // 30 saniye timeout - ping yoksa kapat
    s.pingTo = setTimeout(() => {
        console.warn(`⏱️ Ping timeout (${symbol})`);
        if (s.conn) s.conn.close();
    }, 30000);
}

function reconnectWS(symbol) {
    const n = symbol.toLowerCase();
    const s = wsState[n];
    if (!s) return;
    
    if (s.retries >= 5) {
        console.warn(`❌ Max retry (${symbol}). Polling aktif.`);
        startPollingUpdates?.(symbol);
        return;
    }
    
    s.retries++;
    const delay = 3000 * Math.pow(1.5, s.retries - 1);
    console.log(`🔄 Reconnect ${s.retries}/5 in ${Math.round(delay/1000)}s (${symbol})`);
    
    if (s.retryTo) clearTimeout(s.retryTo);
    s.retryTo = setTimeout(() => startWebSocketUpdates(symbol), delay);
}

function stopWebSocketUpdates(symbol) {
    if (!symbol) {
        Object.keys(wsState).forEach(s => stopWebSocketUpdates(s));
        return;
    }
    
    const n = symbol.toLowerCase();
    const s = wsState[n];
    if (!s) return;
    
    if (s.retryTo) clearTimeout(s.retryTo);
    if (s.pingTo) clearTimeout(s.pingTo);
    
    if (s.conn && s.conn.readyState === WebSocket.OPEN) {
        try {
            s.conn.close(1000, "Normal closure");
            console.log(`✅ WS kapatıldı: ${symbol}`);
        } catch(e) {}
    }
    
    delete wsState[n];
}

// Browser arka plana alındığında recovery
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        console.log("📱 Sayfa geri getirildi - WS reconnecting...");
        Object.keys(wsState).forEach(s => {
            if (wsState[s].conn) startWebSocketUpdates(s);
        });
    }
});

// Sayfa kapatılırken cleanup
window.addEventListener("beforeunload", () => {
    stopWebSocketUpdates();
});
```

---

## 🎯 Neler Düzeltildi

| Sorun | Çözüm |
|-------|--------|
| Global state clash | Symbol başına ayrı `wsState` object |
| Ping timeout yok | 30s timeout, message yoksa close |
| Connection timeout yok | 10s timeout, açılmazsa reconnect |
| Retry logic kötü | Exponential backoff: 3s → 4.5s → 6.75s → 10.1s → 15.2s |
| Browser suspend crash | `visibilitychange` listener ile recovery |
| Memory leak | Page unload'da `beforeunload` listener ile cleanup |

---

## 🧪 Test (Browser Console)

```javascript
// Tek symbol test
startWebSocketUpdates('XAGUSDT')

// Birden fazla symbol
startWebSocketUpdates('BTCUSDT')
startWebSocketUpdates('ETHUSDT')

// Bağlantı kapat
stopWebSocketUpdates('XAGUSDT')

// Tüm bağlantıları kapat
stopWebSocketUpdates()

// State check
console.log(wsState)
```

---

## ⚠️ Uyarı

Eğer VS Code'da düzenlemeye kapalı ise:
1. `public/index.html` açır
2. Satır 2410'dan başla
3. `function startWebSocketUpdates(symbol) {` bulunca
4. `function stopWebSocketUpdates(symbol) {` 'ın sonuna kadar seç
5. Üstteki kodu yapıştır
6. Kaydet (Ctrl+S)
7. Tarayıcı yenile (F5)
8. Console'da kontrol et
