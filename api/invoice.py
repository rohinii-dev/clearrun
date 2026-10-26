"""
ClearRun invoice reader API (optional, higher accuracy)  ->  /api/invoice

POST /api/invoice  {"image": "<base64>", "media_type": "image/jpeg"}
  -> {"source": "claude", "fields": {customer, invoice_no, invoice_date, due_date, amount, gstin, terms_days},
      "confidence": {...}, "raw_text": "..."}

Uses Claude's vision through the Anthropic Messages API when the ANTHROPIC_API_KEY environment variable
is set (Vercel: Project -> Settings -> Environment Variables). Optional: CLAUDE_MODEL (default below).
Without a key it answers 501, and the ClearRun page reads the invoice in the browser instead (Tesseract OCR).
Standard library only.
"""
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-haiku-5-5"
MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_B64 = 7_000_000          # ~5 MB image; the page shrinks big photos before sending

PROMPT = """You are reading a business invoice (often Indian, amounts in rupees, dates day-first).
Return ONLY a JSON object, no other text, with exactly these keys:
{"customer": billed-to / buyer business name or null,
 "invoice_no": invoice number or null,
 "invoice_date": "YYYY-MM-DD" or null,
 "due_date": "YYYY-MM-DD" or null,
 "amount": final total payable as a number (no commas or symbols) or null,
 "gstin": buyer GSTIN if shown, else seller GSTIN, else null,
 "terms_days": payment terms in days as a number (e.g. "Net 30" -> 30) or null,
 "seller": seller / issuer business name or null,
 "confidence": {"customer": "high|medium|low", "amount": "high|medium|low", "due_date": "high|medium|low"}}
Use the grand total (after tax), not a subtotal. If a value is not visible, use null. Never invent values."""


def extract(image_b64, media_type):
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        return 501, {"error": "Server invoice reading is not configured (no ANTHROPIC_API_KEY). The page will read it in the browser."}
    if media_type not in MEDIA_TYPES:
        return 400, {"error": "Use a JPG, PNG or WEBP image of the invoice."}
    if not image_b64 or len(image_b64) > MAX_B64:
        return 400, {"error": "The image is missing or too large (keep it under about 5 MB)."}
    body = {
        "model": os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL),
        "max_tokens": 600,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
            {"type": "text", "text": PROMPT},
        ]}],
    }
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode("utf-8"), method="POST", headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        return 502, {"error": f"The invoice reader service returned an error ({e.code}).", "detail": detail}
    except Exception as e:  # noqa: BLE001  (timeouts, network)
        return 502, {"error": f"Could not reach the invoice reader service: {e}"}
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return 502, {"error": "The invoice could not be read. Try a clearer, straight photo."}
    try:
        fields = json.loads(match.group(0))
    except json.JSONDecodeError:
        return 502, {"error": "The invoice could not be read. Try a clearer, straight photo."}
    conf = fields.pop("confidence", {}) or {}
    clean = {k: fields.get(k) for k in ("customer", "invoice_no", "invoice_date", "due_date", "amount", "gstin", "terms_days", "seller")}
    try:
        clean["amount"] = None if clean["amount"] in (None, "") else float(str(clean["amount"]).replace(",", ""))
    except ValueError:
        clean["amount"] = None
    return 200, {"source": "claude", "fields": clean, "confidence": conf, "raw_text": ""}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_B64 + 10_000:
                return self._send(413, {"error": "The image is too large (keep it under about 5 MB)."})
            body = json.loads(self.rfile.read(length) or b"{}")
            status, data = extract(body.get("image", ""), body.get("media_type", "image/jpeg"))
            self._send(status, data)
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"Invoice reader failed: {e}"})

    def do_GET(self):
        configured = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
        self._send(200, {"configured": configured, "model": os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL) if configured else None})

    def log_message(self, *args):
        pass
