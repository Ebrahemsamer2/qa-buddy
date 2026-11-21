"""QA Buddy demo server.

Serves the demo page and a deliberately slow search API:
  /api/search?q=...        waits 8 seconds before answering (the page gives up after 4)
  /api/search?q=...&fast=1 answers after 6 seconds (shows up as "Slow")

Run:  python3 server.py   then open http://localhost:8080
"""
import json
import os
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/search":
            params = parse_qs(url.query)
            time.sleep(6 if "fast" in params else 8)
            body = json.dumps({"results": [{"name": "Sara Ahmed"}, {"name": "Omar Khaled"}]}).encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the page already cancelled the request
            return
        super().do_GET()


if __name__ == "__main__":
    print("Demo running at http://localhost:8080  (Ctrl+C to stop)")
    here = os.path.dirname(os.path.abspath(__file__))
    ThreadingHTTPServer(("", 8080), partial(Handler, directory=here)).serve_forever()
