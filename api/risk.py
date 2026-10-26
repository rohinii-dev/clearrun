"""
ClearRun customer risk API (Vercel Python serverless function)  ->  /api/risk

GET  /api/risk                      -> customers with decision, score, reasons and next-order actions
POST /api/risk  {"customer": "Delta Traders", "amount": 300000, "terms": 30}
POST /api/risk  {"new": {"type": "Trader/Retailer", "years": 2, "order": 120000}, "amount": 120000, "terms": 30}
                                    -> deal decision, actions, expected payment dates

Client's own data (stateless: send it with each request):
POST /api/risk  {"action": "analyze", "dataset": {"invoices": [...], "customers": [...]}}
                                    -> same answer as GET, but for the uploaded customers (+ "errors")
POST /api/risk  {"dataset": {...}, "customer": "Acme Traders", "amount": 50000, "terms": 30}
                                    -> deal check against the uploaded customers
  invoices row:  {customer, amount, due_date, invoice_date?, paid_date?, invoice_no?}   (no paid_date = still unpaid)
  customers row: {name, type?, years?, terms?, promises_kept?, promises_broken?}      (optional)

The model and its data live in api/_risk/ (folders starting with "_" are not turned into endpoints).
"""
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "_risk"))
import customer_risk as cr  # noqa: E402

_MODEL = None


def model():
    global _MODEL
    if _MODEL is None:
        _MODEL = cr.RiskModel(HERE / "_risk" / "data")
    return _MODEL


def _r(x, nd=0):
    return None if x is None else round(float(x), nd)


def model_for(body):
    """Sample data by default; the uploaded dataset when the request carries one."""
    if body and body.get("dataset") is not None:
        return cr.RiskModel(HERE / "_risk" / "data", dataset=body["dataset"])
    return model()


def customers_payload(m=None):
    m = m or model()
    out = []
    for c in sorted((c for c in m.custs.values() if c["source"] == "current"), key=lambda c: -c["b"]["score"]):
        b = c["b"]
        nxt = m.deal(b["avg_order"] or 100000, c["terms"], customer=c)
        out.append(dict(
            name=c["name"], type=c["type"], years=c["years"], terms=c["terms"],
            decision=b["class"], score=_r(b["score"]),
            typical_delay=_r(b["typical_pred"]), bad_delay=_r(b["bad_pred"]),
            paid_invoices=b["n"], confidence=b["confidence"],
            owed=_r(b["owed"]), overdue=_r(b["overdue_amount"]), avg_order=_r(b["avg_order"]),
            reasons=b["reasons"], next_order_actions=nxt["plan"]["actions"]))
    return dict(today=m.today.isoformat(), types=cr.TYPES, customers=out,
                source="uploaded" if m.uploaded else "sample",
                errors=m.dataset_errors[:50])


def deal_payload(body):
    m = model_for(body)
    if body.get("action") == "analyze":
        return customers_payload(m)
    amount = float(body.get("amount") or 0)
    terms = int(body.get("terms") or 30)
    if amount <= 0:
        raise ValueError("Enter the deal amount.")
    similar = None
    if body.get("new"):
        n = body["new"]
        prof = dict(ctype=n.get("type"), years=float(n.get("years") or 3),
                    order=float(n.get("order") or amount), terms=terms)
        d = m.deal(amount, terms, new_profile=prof)
        p = m.predict_new(prof["ctype"], prof["years"], prof["order"], terms)
        similar = [dict(name=nm, type=t, similarity=round(100 / (1 + dist)), score=_r(s), decision=cr.risk_class(s))
                   for nm, t, dist, s in p["neighbours"]]
        typical, bad, confidence = p["typical"], p["bad"], p["confidence"]
    else:
        c = m.find(str(body.get("customer", "")))
        d = m.deal(amount, terms, customer=c)
        typical, bad, confidence = c["b"]["typical_pred"], c["b"]["bad_pred"], c["b"]["confidence"]
    plan = d["plan"]
    return dict(
        who=d["who"], decision=d["cls"], score=_r(d["score"]), confidence=confidence,
        typical_delay=_r(typical), bad_delay=_r(bad),
        due=d["due"].isoformat(), expected=d["expected"].isoformat(), bad_case=d["bad_case"].isoformat(),
        owed_now=_r(d["owed_now"]), overdue=_r(d["overdue"]), exposure=_r(d["exposure"]), limit=_r(d["limit"]),
        actions=plan["actions"],
        plan=dict(terms=plan["terms"], advance=_r(plan["advance"]), on_credit=_r(plan["on_credit"]),
                  arrival=plan["arrival_planned"].isoformat(), arrival_if_asked=plan["arrival_asked"].isoformat(),
                  # days from the model's "today" -> the UI turns these into forecast weeks
                  arrival_days=(plan["arrival_planned"] - m.today).days),
        similar=similar)


class handler(BaseHTTPRequestHandler):
    def _send(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._send(200, customers_payload())
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"Risk model failed: {e}"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            self._send(200, deal_payload(body))
        except SystemExit as e:      # the model reports bad input (unknown customer / type) this way
            self._send(400, {"error": str(e).replace(" Use --list to see names.", "")})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:       # noqa: BLE001
            self._send(500, {"error": f"Risk model failed: {e}"})

    def log_message(self, *args):    # keep serverless logs quiet
        pass
