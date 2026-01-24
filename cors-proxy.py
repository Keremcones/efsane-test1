#!/usr/bin/env python3
"""
CORS Proxy - Binance API isteklerini proxy yapar
http://localhost:3001/?url=https://api.binance.com/...
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import json
import sys

class CORSProxyHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # CORS headers
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        # Query parametrelerinden URL'yi al
        parsed_url = urlparse(self.path)
        query_params = parse_qs(parsed_url.query)
        
        if 'url' not in query_params:
            self.wfile.write(json.dumps({'error': 'URL parametresi gerekli'}).encode())
            return
        
        target_url = query_params['url'][0]
        
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            req = urllib.request.Request(target_url, headers=headers)
            
            with urllib.request.urlopen(req, timeout=10) as response:
                data = response.read().decode('utf-8')
                self.wfile.write(data.encode())
                print(f"✅ Proxy: {target_url}")
        except Exception as e:
            error_response = json.dumps({'error': str(e)})
            self.wfile.write(error_response.encode())
            print(f"❌ Proxy error: {target_url} - {e}")
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def log_message(self, format, *args):
        # Terminal çıktısını temiz tutmak için
        pass

if __name__ == '__main__':
    PORT = 3001
    server = HTTPServer(('localhost', PORT), CORSProxyHandler)
    print(f"🚀 CORS Proxy çalışıyor: http://localhost:{PORT}")
    print(f"📝 Örnek: http://localhost:{PORT}/?url=https://api.binance.com/api/v3/ticker/24hr")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n✋ Proxy durduruldu")
        sys.exit(0)
