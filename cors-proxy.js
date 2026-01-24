// CORS proxy middleware - Binance API isteklerini proxy yapar
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3001;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Query string'den orijinal URL'yi al
  const queryParams = new url.URLSearchParams(url.parse(req.url).query);
  const targetUrl = queryParams.get('url');

  if (!targetUrl) {
    res.writeHead(400);
    res.end('URL parametresi gerekli');
    return;
  }

  try {
    const protocol = targetUrl.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    protocol.get(targetUrl, options, (apiRes) => {
      let data = '';

      apiRes.on('data', (chunk) => {
        data += chunk;
      });

      apiRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', (error) => {
      console.error('Proxy error:', error);
      res.writeHead(500);
      res.end('Proxy hatası');
    });
  } catch (error) {
    console.error('Error:', error);
    res.writeHead(500);
    res.end('Hata occurred');
  }
});

server.listen(PORT, () => {
  console.log(`CORS Proxy server çalışıyor: http://localhost:${PORT}`);
  console.log('Örnek kullanım: http://localhost:3001/?url=https://api.binance.com/api/v3/ticker/24hr');
});
