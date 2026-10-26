"""
ClearRun - run the whole app on your own computer.

    Windows:      python run.py        (or double-click start-windows.bat)
    Mac / Linux:  python3 run.py       (or double-click start-mac.command)

Needs only Python 3.8+ (no installs). Opens http://localhost:8000 in your browser.
Press Ctrl+C in this window to stop.

What it serves:
  /               the ClearRun app (index.html)
  /api/risk       the Python customer risk model (same code Vercel runs)
  /api/invoice    AI invoice reading if ANTHROPIC_API_KEY is set; otherwise the page reads invoices itself
  other /api/...  "not found", so the app keeps accounts and data in your browser
"""
import json
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "api"))
import risk  # noqa: E402  (api/risk.py -> loads api/_risk/customer_risk.py and its data)
import invoice  # noqa: E402  (api/invoice.py -> optional AI invoice reading, needs ANTHROPIC_API_KEY)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self):
        body = b"Not found"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/risk":
            try:
                return self._json(200, risk.customers_payload())
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": f"Risk model failed: {e}"})
        if path == "/api/invoice":
            return self._json(200, {"configured": bool(invoice.os.environ.get("ANTHROPIC_API_KEY", "").strip())})
        if path.startswith("/api/"):
            return self._not_found()
        if path.startswith("/api") or path.startswith("/extras") or path.endswith(".py"):
            return self._not_found()          # don't serve source files
        return super().do_GET()

    def do_POST(self):
        if self.command == "POST" and self.path.split("?")[0] == "/api/invoice":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > invoice.MAX_B64 + 10_000:
                    return self._json(413, {"error": "The image is too large (keep it under about 5 MB)."})
                body = json.loads(self.rfile.read(length) or b"{}")
                return self._json(*invoice.extract(body.get("image", ""), body.get("media_type", "image/jpeg")))
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": f"Invoice reader failed: {e}"})
        if self.path.split("?")[0] == "/api/risk":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                return self._json(200, risk.deal_payload(body))
            except SystemExit as e:
                return self._json(400, {"error": str(e).replace(" Use --list to see names.", "")})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": f"Risk model failed: {e}"})
        return self._not_found()

    do_PUT = do_DELETE = do_POST

    def log_message(self, fmt, *args):
        pass


def free_port(start=8000):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found between 8000 and 8049.")


def main():
    if sys.version_info < (3, 8):
        raise SystemExit("ClearRun needs Python 3.8 or newer. Download it from https://www.python.org/downloads/")
    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://localhost:{port}"
    print("=" * 52)
    print(f"  ClearRun is running at  {url}")
    print("  Keep this window open. Press Ctrl+C to stop.")
    print("=" * 52)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
