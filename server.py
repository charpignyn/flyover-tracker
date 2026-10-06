import http.server, urllib.request, time, os, hashlib

CACHE_DIR = 'cache'
TTL = 2 * 3600  # CelesTrak met à jour ~toutes les 2 h

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/celestrak/'):
            return self.proxy()
        super().do_GET()

    def proxy(self):
        upstream = 'https://celestrak.org/' + self.path[len('/celestrak/'):]
        os.makedirs(CACHE_DIR, exist_ok=True)
        f = os.path.join(CACHE_DIR, hashlib.md5(upstream.encode()).hexdigest())
        fresh = os.path.exists(f) and time.time() - os.path.getmtime(f) < TTL
        if not fresh:
            try:
                req = urllib.request.Request(upstream, headers={'User-Agent': 'flyover-tracker/1.0'})
                data = urllib.request.urlopen(req, timeout=60).read()
                with open(f, 'wb') as fh:
                    fh.write(data)
            except Exception as e:
                if not os.path.exists(f):  # pas de cache de secours
                    self.send_error(502, str(e))
                    return
        with open(f, 'rb') as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

http.server.ThreadingHTTPServer(('', 8000), Handler).serve_forever()