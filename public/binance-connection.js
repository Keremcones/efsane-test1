(function() {
    const originalFetch = window.fetch.bind(window);
    const SPOT_HOSTS = [
        'api.binance.com',
        'api1.binance.com',
        'api2.binance.com',
        'api3.binance.com',
        'api4.binance.com',
        'data-api.binance.vision'
    ];
    const FUTURES_HOSTS = [
        'fapi.binance.com',
        'fapi1.binance.com',
        'fapi2.binance.com',
        'fapi3.binance.com',
        'fapi4.binance.com'
    ];
    const SPOT_PATH = '/api/v3';
    const FUTURES_PATH = '/fapi/v1';
    const PROXY_BASES = ['/api/cors-proxy?url='];
    const SPOT_BASE_KEY = 'binanceSpotBase';
    const FUTURES_BASE_KEY = 'binanceFuturesBase';

    const statusState = {
        mode: 'offline'
    };

    function ensureStatusEl() {
        let el = document.getElementById('binanceConnectionStatus');
        if (!el) {
            el = document.createElement('div');
            el.id = 'binanceConnectionStatus';
            el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:8px 12px;border-radius:10px;font-size:12px;color:#fff;background:rgba(180,60,60,0.9);box-shadow:0 6px 16px rgba(0,0,0,0.2);';
            document.body.appendChild(el);
        }
        return el;
    }

    function setStatus(mode) {
        statusState.mode = mode;
        const el = ensureStatusEl();
        if (mode === 'connected') {
            el.textContent = '✅ Bagli';
            el.style.background = 'rgba(0, 150, 90, 0.92)';
        } else if (mode === 'proxy') {
            el.textContent = '🔶 Proxy';
            el.style.background = 'rgba(200, 150, 0, 0.92)';
        } else {
            el.textContent = '❌ Baglanti yok';
            el.style.background = 'rgba(180, 60, 60, 0.92)';
        }
    }

    function getCachedBase(storageKey) {
        try {
            return localStorage.getItem(storageKey);
        } catch (error) {
            return null;
        }
    }

    function setCachedBase(storageKey, base) {
        try {
            localStorage.setItem(storageKey, base);
        } catch (error) {
            // Ignore storage errors.
        }
    }

    function reorderWithCached(baseList, storageKey) {
        const cached = getCachedBase(storageKey);
        if (cached && baseList.includes(cached)) {
            return [cached, ...baseList.filter(base => base !== cached)];
        }
        return baseList;
    }

    function normalizePath(path) {
        if (!path) return '/';
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }
        return path.startsWith('/') ? path : `/${path}`;
    }

    function buildUrl(base, path, prefix) {
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }
        const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
        const normalizedPath = normalizePath(path);
        if (normalizedPath.startsWith('/api/') || normalizedPath.startsWith('/fapi/')) {
            return `${normalizedBase}${normalizedPath}`;
        }
        return `${normalizedBase}${prefix}${normalizedPath}`;
    }

    function shouldExpectJson(url) {
        return /\/exchangeInfo|\/klines|\/ticker|\/depth|\/trades|\/aggTrades|ticker\/price|\/ping/i.test(url);
    }

    function isJsonResponse(res) {
        const contentType = res.headers.get('content-type') || '';
        return contentType.includes('application/json') || contentType.includes('text/plain');
    }

    function buildProxyUrl(proxyBase, targetUrl) {
        const encoded = encodeURIComponent(targetUrl);
        return `${proxyBase}${encoded}`;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await originalFetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async function tryUrls(urls, options, retries, timeoutMs) {
        let lastError = null;
        for (const url of urls) {
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const res = await fetchWithTimeout(url, options, timeoutMs);
                    if (res.ok && shouldExpectJson(url) && !isJsonResponse(res)) {
                        lastError = new Error('Non-JSON response');
                        continue;
                    }
                    if (res.ok) return res;
                    lastError = new Error(`HTTP ${res.status}`);
                } catch (error) {
                    lastError = error;
                }
            }
        }
        throw lastError || new Error('Request failed');
    }

    function getSpotBaseList() {
        return reorderWithCached(SPOT_HOSTS.map(host => `https://${host}`), SPOT_BASE_KEY);
    }

    function getFuturesBaseList() {
        return reorderWithCached(FUTURES_HOSTS.map(host => `https://${host}`), FUTURES_BASE_KEY);
    }

    function getTypeFromUrl(urlObj) {
        const host = urlObj.hostname;
        const isBinanceHost = SPOT_HOSTS.includes(host)
            || FUTURES_HOSTS.includes(host)
            || host.endsWith('binance.com')
            || host.endsWith('binance.vision');
        if (!isBinanceHost) return null;
        if (FUTURES_HOSTS.includes(host) || host.startsWith('fapi')) return 'futures';
        if (SPOT_HOSTS.includes(host) || host.startsWith('api')) return 'spot';
        if (urlObj.pathname.includes('/fapi/')) return 'futures';
        if (urlObj.pathname.includes('/api/')) return 'spot';
        return null;
    }

    async function requestWithFallback(type, path, options, opts) {
        const timeoutMs = opts?.timeoutMs ?? 10000;
        const retries = opts?.retries ?? 2;
        const baseList = type === 'futures' ? getFuturesBaseList() : getSpotBaseList();
        const prefix = type === 'futures' ? FUTURES_PATH : SPOT_PATH;
        const urls = baseList.map(base => buildUrl(base, path, prefix));

        try {
            const res = await tryUrls(urls, options, retries, timeoutMs);
            const selectedBase = new URL(res.url).origin;
            const storageKey = type === 'futures' ? FUTURES_BASE_KEY : SPOT_BASE_KEY;
            setCachedBase(storageKey, selectedBase);
            if (type === 'futures') {
                window.BINANCE_FUTURES_API_BASE = `${selectedBase}${FUTURES_PATH}`;
            } else {
                window.BINANCE_SPOT_API_BASE = `${selectedBase}${SPOT_PATH}`;
            }
            setStatus('connected');
            return res;
        } catch (error) {
            const proxyUrls = PROXY_BASES.flatMap(proxyBase =>
                urls.map(url => buildProxyUrl(proxyBase, url))
            );
            try {
                const res = await tryUrls(proxyUrls, options, retries, timeoutMs);
                setStatus('proxy');
                return res;
            } catch (proxyError) {
                setStatus('offline');
                throw proxyError;
            }
        }
    }

    async function detectBase(type) {
        const path = type === 'futures' ? '/ping' : '/ping';
        try {
            await requestWithFallback(type, path, {}, { retries: 1, timeoutMs: 4000 });
        } catch (error) {
            // Status handled in requestWithFallback.
        }
    }

    const BinanceAPI = {
        spotFetch(path, options = {}, opts = {}) {
            return requestWithFallback('spot', path, options, opts);
        },
        futuresFetch(path, options = {}, opts = {}) {
            return requestWithFallback('futures', path, options, opts);
        },
        fetchUrl(url, options = {}, opts = {}) {
            try {
                const urlObj = new URL(url, window.location.origin);
                const type = getTypeFromUrl(urlObj);
                if (!type) {
                    return originalFetch(url, options);
                }
                const path = urlObj.pathname + urlObj.search;
                return requestWithFallback(type, path, options, opts);
            } catch (error) {
                return originalFetch(url, options);
            }
        },
        getSpotBase() {
            const base = getCachedBase(SPOT_BASE_KEY) || `https://${SPOT_HOSTS[0]}`;
            return `${base}${SPOT_PATH}`;
        },
        getFuturesBase() {
            const base = getCachedBase(FUTURES_BASE_KEY) || `https://${FUTURES_HOSTS[0]}`;
            return `${base}${FUTURES_PATH}`;
        },
        detect() {
            detectBase('spot');
            detectBase('futures');
        }
    };

    window.BinanceAPI = BinanceAPI;

    window.fetch = function(input, options) {
        if (typeof input === 'string') {
            return BinanceAPI.fetchUrl(input, options, {});
        }
        if (input && typeof input.url === 'string') {
            return BinanceAPI.fetchUrl(input.url, options, {});
        }
        return originalFetch(input, options);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', BinanceAPI.detect);
    } else {
        BinanceAPI.detect();
    }
})();
