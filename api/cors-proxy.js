export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    res.status(400).json({ error: 'Missing url' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch (error) {
    res.status(400).json({ error: 'Invalid url' });
    return;
  }

  const allowedHosts = new Set([
    'api.binance.com',
    'fapi.binance.com',
    'api1.binance.com',
    'api2.binance.com',
    'api3.binance.com',
    'api4.binance.com',
    'fapi1.binance.com',
    'fapi2.binance.com',
    'fapi3.binance.com',
    'fapi4.binance.com',
    'data-api.binance.vision'
  ]);
  if (!allowedHosts.has(targetUrl.hostname)) {
    res.status(400).json({ error: 'Host not allowed' });
    return;
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: req.headers.accept || '*/*',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(upstream.status).send(body);
  } catch (error) {
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
