// Vercel Serverless Function - CORS Proxy
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

    // Binance tarafından bloklanmamak için User-Agent ve headers ekle
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      },
      timeout: 10000,
    });

    // Status 451 ve benzeri hataları kontrol et
    if (response.status === 451) {
      console.warn('⚠️ IP blocked by Binance - Status 451');
      return res.status(503).json({ 
        error: 'Service temporarily unavailable',
        message: 'Binance API temporarily unavailable. Please try again later.' 
      });
    }

    if (!response.ok) {
      console.warn(`⚠️ API returned status ${response.status}`);
    }

    const data = await response.json();
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    return res.status(500).json({ 
      error: 'Failed to fetch data',
      message: error.message 
    });
  }
}
