// Vercel Serverless Function - CORS Proxy with Retry
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Sadece Binance API'ye izin ver
    if (!url.includes('binance.com')) {
      return res.status(403).json({ error: 'Only Binance API requests are allowed' });
    }

    console.log('🔄 Proxying request to:', url);

    // Retry logic - 3 attempts
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': 'https://www.binance.com/',
            'Origin': 'https://www.binance.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          },
          timeout: 15000, // 15 second timeout
        });

        if (response.ok) {
          const data = await response.json();
          return res.status(200).json(data);
        }

        // If not ok, throw to retry
        lastError = `HTTP ${response.status}`;
        
        // Don't retry on 4xx errors
        if (response.status >= 400 && response.status < 500) {
          return res.status(response.status).json({
            error: `API returned ${response.status}`,
            message: 'Request failed'
          });
        }

        console.warn(`⚠️ Attempt ${attempt}/3 failed: ${lastError}`);
        
        if (attempt < 3) {
          // Exponential backoff: 1s, 2s, 4s
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }
      } catch (error) {
        lastError = error.message;
        console.warn(`⚠️ Attempt ${attempt}/3 failed: ${lastError}`);
        
        if (attempt < 3) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }
      }
    }

    // All retries failed
    console.error('❌ All retry attempts failed:', lastError);
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Binance API is currently unreachable. Please try again later.',
      details: lastError
    });

  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch data',
      message: error.message
    });
  }
}
