(function() {
    const originalFetch = window.fetch.bind(window);
    const SPOT_HOSTS = [
        'api.binance.com',
        'api1.binance.com',
        'api2.binance.com',
        'api3.binance.com',
        'api4.binance.com'
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
    const FORCE_PROXY_ALWAYS = false;

    const statusState = {
        mode: 'offline',
        hideTimer: null
    };

    function setBinanceBlocked(flag) {
        try {
            window.BINANCE_BLOCKED = Boolean(flag);
        } catch (error) {
            // Ignore assignment failures.
        }
    }

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
        const el = document.getElementById('binanceConnectionStatus');
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    function shouldForceProxy() {
        return FORCE_PROXY_ALWAYS;
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
        return /\/exchangeInfo|\/klines|\/ticker|\/depth|\/trades|\/aggTrades|ticker\/price|\/ping|\/time/i.test(url);
    }

    function isJsonResponse(res) {
        const contentType = res.headers.get('content-type') || '';
        return contentType.includes('application/json') || contentType.includes('text/plain');
    }

    function buildProxyUrl(proxyBase, targetUrl) {
        const encoded = encodeURIComponent(targetUrl);
        return `${proxyBase}${encoded}&t=${Date.now()}`;
    }

    function isBinanceTarget(url) {
        try {
            const target = new URL(url, window.location.origin);
            const host = target.hostname;
            return host.endsWith('binance.com') || host.endsWith('binance.vision');
        } catch (error) {
            return false;
        }
    }

    function extractTargetUrl(maybeProxyUrl) {
        try {
            if (!maybeProxyUrl.includes('/api/cors-proxy?url=')) return maybeProxyUrl;
            const param = maybeProxyUrl.split('/api/cors-proxy?url=')[1] || '';
            return decodeURIComponent(param);
        } catch (error) {
            return maybeProxyUrl;
        }
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

    function shouldForceProxyStatus(status) {
        return status === 418 || status === 429 || status === 451 || status === 403;
    }

    async function isValidJsonPayload(res) {
        try {
            const data = await res.clone().json();
            if (Array.isArray(data)) return true;
            if (data && typeof data === 'object' && 'code' in data && 'msg' in data) {
                return false;
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    function sanitizeRequestOptions(options) {
        const sanitized = { ...(options || {}) };
        const headers = new Headers(sanitized.headers || {});
        headers.delete('cache-control');
        headers.delete('pragma');
        headers.delete('expires');
        headers.delete('user-agent');
        if (!headers.has('Accept')) {
            headers.set('Accept', 'application/json');
        }
        sanitized.headers = headers;
        if ('cache' in sanitized) {
            delete sanitized.cache;
        }
        return sanitized;
    }

    async function tryUrls(urls, options, retries, timeoutMs, allowForceProxy) {
        let lastError = null;
        const requestOptions = sanitizeRequestOptions(options || {});
        for (const url of urls) {
            const checkUrl = extractTargetUrl(url);
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const res = await fetchWithTimeout(url, requestOptions, timeoutMs);
                    if (res.ok) {
                        setBinanceBlocked(false);
                    }
                    if (res.ok && shouldExpectJson(checkUrl)) {
                        if (!isJsonResponse(res)) {
                            if (isBinanceTarget(checkUrl)) {
                                setBinanceBlocked(true);
                            }
                            lastError = new Error('Non-JSON response');
                            continue;
                        }
                        const valid = await isValidJsonPayload(res);
                        if (!valid) {
                            if (isBinanceTarget(checkUrl)) {
                                setBinanceBlocked(true);
                            }
                            lastError = new Error('Invalid JSON payload');
                            continue;
                        }
                    }
                    if (res.ok) return res;
                    if (res.status === 451 || res.status === 403) {
                        setBinanceBlocked(true);
                    }
                    if (allowForceProxy && shouldForceProxyStatus(res.status)) {
                        const error = new Error('force_proxy');
                        error.forceProxy = true;
                        throw error;
                    }
                    lastError = new Error(`HTTP ${res.status}`);
                } catch (error) {
                    if (isBinanceTarget(checkUrl)) {
                        const message = String(error && error.message ? error.message : '');
                        if (error?.name === 'TypeError' || message.includes('Failed to fetch') || message.includes('NetworkError')) {
                            setBinanceBlocked(true);
                            if (allowForceProxy) {
                                const proxyError = new Error('force_proxy');
                                proxyError.forceProxy = true;
                                throw proxyError;
                            }
                        }
                    }
                    if (error && error.forceProxy) {
                        throw error;
                    }
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
        const proxyUrls = PROXY_BASES.flatMap(proxyBase =>
            urls.map(url => buildProxyUrl(proxyBase, url))
        );

        if (shouldForceProxy() && PROXY_BASES.length) {
            try {
                const res = await tryUrls(proxyUrls, options, retries, timeoutMs);
                return res;
            } catch (error) {
                setStatus('offline');
                throw error;
            }
        }

        try {
            const res = await tryUrls(urls, options, retries, timeoutMs, true);
            const selectedBase = new URL(res.url).origin;
            const storageKey = type === 'futures' ? FUTURES_BASE_KEY : SPOT_BASE_KEY;
            setCachedBase(storageKey, selectedBase);
            if (type === 'futures') {
                window.BINANCE_FUTURES_API_BASE = `${selectedBase}${FUTURES_PATH}`;
            } else {
                window.BINANCE_SPOT_API_BASE = `${selectedBase}${SPOT_PATH}`;
            }
            return res;
        } catch (error) {
            if (!proxyUrls.length) {
                throw error;
            }
            try {
                const res = await tryUrls(proxyUrls, options, retries, timeoutMs, false);
                return res;
            } catch (proxyError) {
                throw proxyError;
            }
        }
    }

    async function detectBase(type) {
        const path = '/time';
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
