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

    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('❌ Proxy error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch data',
      message: error.message 
    });
  }
}
