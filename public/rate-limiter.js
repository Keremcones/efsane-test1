// ============================================
// RATE LIMITING & TIMEOUT UTILITIES
// ============================================

class RateLimiter {
    constructor(maxRequests = 1200, windowMs = 60000) {
        this.maxRequests = maxRequests;  // 1200 requests per minute for Binance
        this.windowMs = windowMs;
        this.requests = [];
        this.retryAfter = 0;
    }

    async wait() {
        const now = Date.now();
        
        // Cleanup old requests outside window
        this.requests = this.requests.filter(time => now - time < this.windowMs);
        
        // Check if we're rate limited
        if (Date.now() < this.retryAfter) {
            const waitTime = this.retryAfter - Date.now();
            console.warn(`⏳ Rate limited. Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        }
        
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = this.windowMs - (now - oldestRequest);
            console.warn(`⏳ Rate limiter: ${this.requests.length}/${this.maxRequests} requests. Waiting ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 100));
            this.requests = this.requests.filter(time => now - time < this.windowMs);
        }
        
        this.requests.push(now);
    }

    setRetryAfter(ms) {
        this.retryAfter = Date.now() + ms;
    }

    reset() {
        this.requests = [];
        this.retryAfter = 0;
    }
}

// Global rate limiter for Binance API
const binanceRateLimiter = new RateLimiter(1200, 60000);

// ============================================
// TIMEOUT WRAPPER
// ============================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeout);
        return response;
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
        }
        throw error;
    }
}

// ============================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================

async function fetchWithRetry(
    url, 
    options = {}, 
    maxRetries = 3, 
    baseDelayMs = 1000,
    timeoutMs = 30000
) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Apply rate limiting
            await binanceRateLimiter.wait();
            
            const response = await fetchWithTimeout(url, options, timeoutMs);
            
            if (!response.ok) {
                if (response.status === 429) {
                    // Rate limited by Binance
                    const retryAfter = response.headers.get('Retry-After') || (60 * Math.pow(2, attempt));
                    binanceRateLimiter.setRetryAfter(retryAfter * 1000);
                    console.warn(`⚠️ Rate limited by Binance. Retry-After: ${retryAfter}s`);
                    
                    const delayMs = retryAfter * 1000;
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            
            return response;
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries - 1) {
                const delayMs = baseDelayMs * Math.pow(2, attempt);
                console.warn(`⚠️ Request failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    
    throw new Error(`Failed after ${maxRetries} retries: ${lastError.message}`);
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        RateLimiter,
        binanceRateLimiter,
        fetchWithTimeout,
        fetchWithRetry
    };
}
