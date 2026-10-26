"""
Customer Risk Model (standalone, Python standard library only)
==============================================================
Answers three questions:
  1. How risky is each EXISTING customer, based on how they actually paid?
       -> score 0-100 and a decision: Full credit / Limited credit / Advance only
  2. A NEW customer walks in. How will they likely pay?   -> compare with the most similar past customers
  3. I'm about to make a DEAL. When will the money really arrive, and WHAT SHOULD I DO?
       -> concrete actions picked from the customer's weak spots (shorter credit days, post-dated cheque,
          split delivery, part advance, collect overdue first, ...), with the new expected arrival date

Run:
  python customer_risk.py                                    # score every customer
  python customer_risk.py --new --type "Trader/Retailer" --years 2 --order 120000 --terms 30
  python customer_risk.py --deal "Delta Traders" --amount 300000 --terms 30
  python customer_risk.py --deal NEW --type "Govt/PSU" --years 20 --amount 500000 --terms 60
  python customer_risk.py --backtest                         # how accurate are new-customer predictions?

HOW IT WORKS (no machine learning, every number can be explained)
-----------------------------------------------------------------
Existing customer -> 6 behaviour signals from their invoices, each worth fixed points:
    Lateness          typical (median) days late          0 days = 0 pts ... 45+ days = 25 pts
    Unpredictability  bad case (80th pct) minus typical    0 days = 0 pts ... 30+ days = 15 pts
    Very late         share of invoices paid 45+ days late (or unpaid that long)      up to 20 pts
    Broken promises   share of payment promises broken                                up to 15 pts
    Overdue now       oldest unpaid invoice, days past due 0 = 0 pts ... 60+ days = 15 pts
    Slowing down      last 4 payments 7+ days later than usual                        10 pts
  Score = sum (0-100).   0-30 Full credit  |  31-55 Limited credit  |  56-100 Advance only

New customer -> profile: type, years in business, typical order size, credit terms asked.
  Distance to every past customer with enough history (5+ paid invoices):
    type differs        3.0
    years in business   1.5 x |log(1+a) - log(1+b)| / log(31)
    order size          1.0 x |log(a) - log(b)| / log(100)
    credit terms        1.0 x |a - b| / 60
  Take the 5 closest; weight each by 1 / (distance + 0.1); predict their weighted average
  score, typical delay and bad-case delay. Show who they are, so the prediction is explainable.

Existing customer with little history -> mix own score with the similar-customers prediction:
  weight on own history = n / (n + 5) below 8 paid invoices, 100% at 8 or more.
"""
import argparse, csv, json, math
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
TYPES = ["Large company", "Govt/PSU", "SME manufacturer", "Distributor", "Trader/Retailer"]

# Classes are named by what the owner should DO.
FULL, LIMITED, ADVANCE = "Full credit", "Limited credit", "Advance only"
CLASSES = [FULL, LIMITED, ADVANCE]

# Credit limit = factor x monthly billing x (credit days + typical delay) / 30
# i.e. roughly how much a customer normally owes you at any time, with headroom that shrinks as risk grows.
DEAL_RULES = {FULL: dict(factor=1.5), LIMITED: dict(factor=1.0), ADVANCE: dict(factor=0.5)}
TERM_OPTIONS = [15, 30, 45, 60]      # shortest credit offered in practice: 15 days
OVERDUE_BLOCK_DAYS = 7               # overdue longer than this blocks a new dispatch (limited/advance customers)


# ----------------------------------------------------------------------------- data
def _d(s):
    return datetime.strptime(s, "%Y-%m-%d").date() if s else None


def _rows(p):
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load(data_dir):
    p = Path(data_dir)
    today = _d(json.loads((p / "business.json").read_text(encoding="utf-8"))["today"])
    prof = {int(r["id"]): (r["customer_type"], int(r["years_in_business"])) for r in _rows(p / "customer_profiles.csv")}
    custs = {}
    for fn, source in (("customers.csv", "current"), ("past_customers.csv", "past")):
        if (p / fn).exists():
            for r in _rows(p / fn):
                cid = int(r["id"])
                t, y = prof.get(cid, ("Trader/Retailer", 3))
                custs[cid] = dict(id=cid, name=r["name"], terms=int(r["credit_terms_days"]), kept=int(r["promises_kept"]),
                                  broken=int(r["promises_broken"]), type=t, years=y, source=source, invoices=[])
    for fn in ("invoices.csv", "past_invoices.csv"):
        if (p / fn).exists():
            for r in _rows(p / fn):
                c = custs.get(int(r["customer_id"]))
                if c:
                    c["invoices"].append(dict(no=r["invoice_no"], amount=float(r["amount"]), inv=_d(r["invoice_date"]),
                                              due=_d(r["due_date"]), paid=_d(r["paid_date"])))
    for c in custs.values():
        c["invoices"].sort(key=lambda i: i["due"])
    return today, custs


def _parse_date(v):
    """Accepts 2026-10-24, 24/10/2026, 24-10-2026, 24.10.2026 (Indian day-first). Empty -> None."""
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v[:10] if fmt == "%Y-%m-%d" else v, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date '{v}' (use YYYY-MM-DD or DD/MM/YYYY)")


MAX_ROWS = 20000


def load_dataset(dataset, today=None):
    """Turn an uploaded dataset into the same customer structure load() returns.
    dataset = {"invoices": [{customer, amount, invoice_date?, due_date, paid_date?}],
               "customers": [{name, type?, years?, terms?, promises_kept?, promises_broken?}]  (optional)}
    Returns (customers_dict, errors_list). Bad rows are skipped and reported, never fatal."""
    today = today or date.today()
    invoices = list(dataset.get("invoices") or [])
    profiles = list(dataset.get("customers") or [])
    if len(invoices) > MAX_ROWS or len(profiles) > MAX_ROWS:
        raise ValueError(f"Dataset too large: keep it under {MAX_ROWS} rows.")
    errors, custs, by_name = [], {}, {}

    def get(name):
        key = name.strip().lower()
        if key not in by_name:
            cid = f"u{len(by_name) + 1}"
            by_name[key] = cid
            custs[cid] = dict(id=cid, name=name.strip(), terms=None, kept=0, broken=0, type=None, years=None,
                              source="current", invoices=[])
        return custs[by_name[key]]

    for i, r in enumerate(profiles, 1):
        name = str(r.get("name") or r.get("customer") or "").strip()
        if not name:
            errors.append(f"customers row {i}: missing name"); continue
        c = get(name)
        t = str(r.get("type") or r.get("customer_type") or "").strip()
        match = next((x for x in TYPES if x.lower() == t.lower() or x.lower().startswith(t.lower()[:5])), None) if t else None
        if t and not match:
            errors.append(f"customers row {i}: unknown type '{t}', using Trader/Retailer")
        c["type"] = match or c["type"]
        for key, field, cast in (("years", "years", float), ("terms", "terms", int),
                                 ("promises_kept", "kept", int), ("promises_broken", "broken", int)):
            v = r.get(key)
            if v not in (None, ""):
                try:
                    c[field] = max(0, cast(float(v)))
                except (TypeError, ValueError):
                    errors.append(f"customers row {i}: '{key}' is not a number")

    for i, r in enumerate(invoices, 1):
        name = str(r.get("customer") or r.get("name") or "").strip()
        if not name:
            errors.append(f"invoices row {i}: missing customer"); continue
        try:
            amount = float(str(r.get("amount", "")).replace(",", "").replace("₹", "").strip())
            if amount <= 0:
                raise ValueError
        except ValueError:
            errors.append(f"invoices row {i}: amount must be a positive number"); continue
        try:
            due = _parse_date(r.get("due_date"))
            inv = _parse_date(r.get("invoice_date"))
            paid = _parse_date(r.get("paid_date"))
        except ValueError as e:
            errors.append(f"invoices row {i}: {e}"); continue
        if not due:
            errors.append(f"invoices row {i}: missing due_date"); continue
        inv = inv or due - timedelta(days=30)
        if paid and paid > today:
            paid = None                                  # a future "paid" date means not paid yet
        get(name)["invoices"].append(dict(no=str(r.get("invoice_no") or f"R{i}"), amount=amount, inv=inv, due=due, paid=paid))

    for c in custs.values():
        c["invoices"].sort(key=lambda x: x["due"])
        if c["terms"] is None:                           # infer usual credit terms from the invoices
            gaps = sorted((x["due"] - x["inv"]).days for x in c["invoices"])
            c["terms"] = gaps[len(gaps) // 2] if gaps else 30
        c["type"] = c["type"] or "Trader/Retailer"
        c["years"] = 3 if c["years"] is None else c["years"]
    return custs, errors


# ----------------------------------------------------------------------------- math helpers
def pct(xs, p):
    s = sorted(xs)
    if not s:
        return None
    i = p * (len(s) - 1); lo = int(i); hi = min(lo + 1, len(s) - 1)
    return s[lo] + (i - lo) * (s[hi] - s[lo])


def clamp01(x):
    return max(0.0, min(1.0, x))


def risk_class(score):
    return FULL if score <= 30 else LIMITED if score <= 55 else ADVANCE


# ----------------------------------------------------------------------------- 4. what to do (suggestions)
def action_plan(cls, amount, terms, typical, limit, owed, overdue, today, sig=None, is_new=False):
    """Concrete actions for this deal, chosen from WHY the customer is risky, with numbers filled in.
    sig: dict of the customer's signals (broken_rate, unpredictable, slowing, slowing_by, max_overdue,
         very_late_rate). None for a brand-new customer.
    Returns the actions, the suggested credit days, advance, amount on credit, and when the money
    should arrive under the suggested terms vs the requested ones."""
    sig = sig or {}
    typ = max(0, round(typical))
    exposure = owed + amount
    room = max(0.0, limit - owed)
    actions, new_terms, advance = [], terms, 0.0
    broken = (sig.get("broken_rate") or 0) >= 0.4
    unpredictable = sig.get("unpredictable", False)

    max_od = sig.get("max_overdue", 0)
    if overdue > 0 and cls != FULL:
        if max_od > OVERDUE_BLOCK_DAYS:
            actions.append(f"Collect the {inr(overdue)} already overdue (oldest {max_od} days) before dispatching this order.")
        else:
            actions.append(f"Remind them about the {inr(overdue)} that just became due ({max_od} days) when confirming.")

    if cls == FULL:
        actions.append(f"Give the requested {terms} days credit.")
        if overdue > 0:
            actions.append(f"Remind them about the {inr(overdue)} overdue when confirming the order.")
        if exposure > limit:
            on_credit = room if room > 0 else 0
            actions.append(f"Heavy exposure: total credit would be {inr(exposure)} against a {inr(limit)} limit. "
                           + (f"Dispatch {inr(on_credit)} now and the rest after their next invoice is paid."
                              if on_credit else "Dispatch after their oldest open invoice is paid."))
        if typ >= 15:
            actions.append(f"They usually pay {typ} days late. If you need the cash sooner, offer 1.5% off "
                           f"for payment within 7 days.")

    elif cls == LIMITED and room <= 0:
        # already owes more than this customer's limit: no new credit at all
        advance, new_terms = amount, 0
        actions.append(f"They already owe {inr(owed)}, above their {inr(limit)} credit limit: take this order fully in "
                       f"advance, or dispatch only after their open invoices are paid.")
        if broken:
            actions.append(f"Don't accept a verbal promise instead: they broke {round(sig['broken_rate'] * 100)}% of past promises.")

    elif cls == LIMITED:
        target = terms - typ                               # aim: money arrives around the day you originally expected
        new_terms = min(max([t for t in TERM_OPTIONS if t <= target] or [TERM_OPTIONS[0]]), terms)
        if new_terms < terms:
            actions.append(f"Give {new_terms} days credit instead of {terms}: they usually pay {typ} days late, so the "
                           f"money comes around day {new_terms + typ} instead of day {terms + typ}.")
        else:
            actions.append(f"Keep {terms} days credit, but expect payment around day {terms + typ}.")
        if exposure > limit:                               # part of this order fits under the limit
            advance = round(amount - room, -3)
            actions.append(f"Put only {inr(amount - advance)} on credit (keeps them under their {inr(limit)} limit) "
                           f"and take {inr(advance)} as advance.")
        # one safeguard, picked by the customer's weak spot
        if broken:
            actions.append(f"Take a post-dated cheque dated {today + timedelta(days=new_terms)} for the credit part: "
                           f"they broke {round(sig['broken_rate'] * 100)}% of payment promises, so don't rely on verbal commitments.")
        elif unpredictable:
            actions.append("Split the order into 2 deliveries; send the second only after the first invoice is paid "
                           "(their payment timing swings a lot).")
        elif not advance:
            advance = round(0.25 * amount, -3)
            actions.append(f"Take {inr(advance)} (25%) advance before dispatch; the rest on credit.")
        actions.append("Send a reminder 5 days before the due date and call on the due date.")

    else:  # ADVANCE
        full = (sig.get("very_late_rate") or 0) >= 0.3 or sig.get("max_overdue", 0) >= 60
        pct_adv = 1.0 if full else 0.5
        advance = round(pct_adv * amount, -3)
        new_terms = 0 if full else min(terms, 15)
        actions.append(f"Take {inr(advance)} ({pct_adv * 100:.0f}%) before dispatch.")
        if not full:
            actions.append(f"For the remaining {inr(amount - advance)}, take a post-dated cheque dated "
                           f"{today + timedelta(days=new_terms)} ({new_terms} days).")
        actions.append("Move them back to credit only after 3 invoices are paid on time.")

    if sig.get("slowing"):
        actions.append(f"Their payments slowed by {sig['slowing_by']:.0f} days recently: call to check how their business "
                       f"is doing before raising their credit.")
    if is_new:
        actions.append("New customer: start with this deal size and review after their first 3 invoices.")

    on_credit = max(0.0, amount - advance)
    asked = today + timedelta(days=terms + typ)
    planned = today + timedelta(days=new_terms + (typ if new_terms else 0))
    return dict(actions=actions, terms=new_terms, advance=advance, on_credit=on_credit,
                arrival_asked=asked, arrival_planned=planned, exposure=exposure, room=room)


# ----------------------------------------------------------------------------- 1. existing customer
def behaviour(c, today):
    """Six signals + score + plain-English reasons, from the customer's own invoices."""
    paid = [i for i in c["invoices"] if i["paid"]]
    open_ = [i for i in c["invoices"] if not i["paid"]]
    delays = [(i["paid"] - i["due"]).days for i in paid]
    n = len(delays)
    overdue_days = [(today - i["due"]).days for i in open_ if i["due"] < today]
    max_overdue = max(overdue_days) if overdue_days else 0
    typical = pct(delays, 0.5) if n else None
    bad = pct(delays, 0.8) if n else None
    very_late = sum(d >= 45 for d in delays) + sum(d >= 45 for d in overdue_days)
    very_late_rate = very_late / (n + len(overdue_days)) if (n + len(overdue_days)) else 0
    promises = c["kept"] + c["broken"]
    broken_rate = c["broken"] / promises if promises >= 2 else None
    recent = pct(delays[-4:], 0.5) if n >= 6 else None
    slowing = recent is not None and recent - typical >= 7
    old_typical = typical
    if slowing:  # trust the recent behaviour: shift typical and bad case to the recent level
        bad += recent - typical
        typical = recent
    amounts = [i["amount"] for i in c["invoices"]]
    recent_billing = [i["amount"] for i in c["invoices"] if (today - i["inv"]).days <= 180]

    pts, reasons = {}, []
    if n:
        pts["Lateness"] = 25 * clamp01(typical / 45)
        pts["Unpredictability"] = 15 * clamp01((bad - typical) / 30)
    pts["Very late"] = 20 * very_late_rate
    pts["Broken promises"] = 15 * (broken_rate if broken_rate is not None else 0.3)
    pts["Overdue now"] = 15 * clamp01(max_overdue / 60)
    pts["Slowing down"] = 10 if slowing else 0
    score = sum(pts.values()) if n else None

    if n:
        reasons.append(f"usually pays {typical:.0f} days late" if typical > 2 else "usually pays on time")
        if bad - typical >= 15:
            reasons.append(f"unpredictable (bad case {bad:.0f} days late)")
    if very_late_rate >= 0.2:
        reasons.append(f"{very_late_rate * 100:.0f}% of invoices 45+ days late")
    if broken_rate is not None and broken_rate >= 0.4:
        reasons.append(f"broke {c['broken']} of {promises} payment promises")
    if max_overdue > 15:
        reasons.append(f"an invoice is {max_overdue} days overdue")
    if slowing:
        reasons.append(f"slowing down: recent payments {recent - old_typical:.0f} days later than before")

    return dict(n=n, typical=typical, bad=bad, very_late_rate=very_late_rate, broken_rate=broken_rate,
                max_overdue=max_overdue, slowing=slowing, own_score=score, points=pts, reasons=reasons,
                unpredictable=bool(n) and (bad - typical) >= 15,
                slowing_by=(recent - old_typical) if slowing else 0,
                owed=sum(i["amount"] for i in open_), overdue_amount=sum(i["amount"] for i in open_ if i["due"] < today),
                avg_order=(sum(amounts) / len(amounts)) if amounts else None,
                monthly_billing=(sum(recent_billing) / 6) if recent_billing else None,
                confidence="high" if n >= 8 else "medium" if n >= 4 else "low")


# ----------------------------------------------------------------------------- 2. new customer (similarity)
def distance(a, b):
    """a, b: dicts with type, years, order, terms."""
    d = 3.0 * (a["type"] != b["type"])
    d += 1.5 * abs(math.log1p(a["years"]) - math.log1p(b["years"])) / math.log(31)
    d += 1.0 * abs(math.log(max(a["order"], 1)) - math.log(max(b["order"], 1))) / math.log(100)
    d += 1.0 * abs(a["terms"] - b["terms"]) / 60
    return d


class RiskModel:
    def __init__(self, data_dir=HERE / "data", k=5, min_history=5, dataset=None):
        """dataset=None -> the sample data. dataset={...} -> the client's own customers are scored, and the
        built-in past customers are kept only as the comparison pool for new / thin-history customers."""
        self.today, self.custs = load(data_dir)
        self.dataset_errors = []
        self.uploaded = dataset is not None
        if dataset is not None:
            self.today = date.today()
            pool = {cid: c for cid, c in self.custs.items() if c["source"] == "past"}
            mine, self.dataset_errors = load_dataset(dataset, self.today)
            if not mine:
                raise ValueError("No usable customers in the uploaded data. " + "; ".join(self.dataset_errors[:3]))
            self.custs = {**pool, **mine}
        self.k, self.min_history = k, min_history
        for c in self.custs.values():
            c["b"] = behaviour(c, self.today)
        # reference set = customers with enough paid invoices to trust their own score
        self.reference = [c for c in self.custs.values() if c["b"]["n"] >= min_history]
        for c in self.custs.values():
            self._finalise(c)

    def profile(self, c):
        return dict(type=c["type"], years=c["years"], order=c["b"]["avg_order"] or 100000, terms=c["terms"])

    def similar(self, prof, exclude=None):
        """The k most similar reference customers and the weighted prediction."""
        cands = [(distance(prof, self.profile(r)), r) for r in self.reference if r["id"] != exclude]
        cands.sort(key=lambda t: t[0])
        top = cands[:self.k]
        ws = [1 / (d + 0.1) for d, _ in top]
        W = sum(ws)
        avg = lambda key: sum(w * r["b"][key] for w, (_, r) in zip(ws, top)) / W
        scores = [r["b"]["own_score"] for _, r in top]
        classes = [risk_class(s) for s in scores]
        return dict(score=avg("own_score"), typical=avg("typical"), bad=avg("bad"),
                    neighbours=[(r["name"], r["type"], d, r["b"]["own_score"]) for d, r in top],
                    agreement=max(classes.count(x) for x in set(classes)) / len(classes),
                    classes=classes)

    def _finalise(self, c):
        """Final score: own history, mixed with similar customers when history is thin."""
        b = c["b"]; n = b["n"]
        w = 1.0 if n >= 8 else n / (n + 5)
        if w < 1.0:
            sim = self.similar(self.profile(c), exclude=c["id"])
            own = b["own_score"] if b["own_score"] is not None else sim["score"]
            # current problems (overdue now, broken promises) are facts, so they are kept on top of the mix
            b["score"] = w * own + (1 - w) * sim["score"] if n else sim["score"] + b["points"]["Overdue now"]
            b["typical_pred"] = w * (b["typical"] if n else 0) + (1 - w) * sim["typical"]
            b["bad_pred"] = w * (b["bad"] if n else 0) + (1 - w) * sim["bad"]
            b["similar"] = sim
            b["reasons"] = b["reasons"] + [f"little history ({n} paid invoices): mixed with {len(sim['neighbours'])} similar customers"]
        else:
            b["score"], b["typical_pred"], b["bad_pred"], b["similar"] = b["own_score"], b["typical"], b["bad"], None
        b["score"] = max(0.0, min(100.0, b["score"]))
        b["class"] = risk_class(b["score"])

    # ------------------------------------------------------------------ public answers
    def find(self, name):
        for c in self.custs.values():
            if c["name"].lower() == name.lower():
                return c
        raise SystemExit(f"No customer named '{name}'. Use --list to see names.")

    def predict_new(self, ctype, years, order, terms):
        if ctype not in TYPES:
            raise SystemExit(f"--type must be one of: {', '.join(TYPES)}")
        sim = self.similar(dict(type=ctype, years=years, order=order, terms=terms))
        sim["class"] = risk_class(sim["score"])
        sim["confidence"] = "high" if sim["agreement"] >= 0.8 else "medium" if sim["agreement"] >= 0.6 else "low"
        return sim

    def deal(self, amount, terms, customer=None, new_profile=None):
        """When will the money arrive, exposure after the deal, and credit guidance."""
        if customer:
            b = customer["b"]
            cls, score, typical, bad = b["class"], b["score"], b["typical_pred"], b["bad_pred"]
            owed, overdue = b["owed"], b["overdue_amount"]
            monthly = b["monthly_billing"] or b["avg_order"] or amount
            who = customer["name"]
        else:
            p = self.predict_new(**new_profile)
            cls, score, typical, bad = p["class"], p["score"], p["typical"], p["bad"]
            owed, overdue, monthly = 0.0, 0.0, new_profile["order"]
            who = f"New {new_profile['ctype']} customer"
        rule = DEAL_RULES[cls]
        if customer:
            limit = rule["factor"] * monthly * max(1.0, (terms + max(0, typical)) / 30)
        else:  # no track record yet: first-deal limit is one typical order, scaled by risk
            limit = rule["factor"] * monthly
        due = self.today + timedelta(days=terms)
        sig = customer["b"] if customer else None
        plan = action_plan(cls, amount, terms, typical, limit, owed, overdue, self.today, sig=sig, is_new=not customer)
        return dict(who=who, cls=cls, score=score, due=due,
                    expected=due + timedelta(days=round(max(0, typical))),
                    bad_case=due + timedelta(days=round(max(0, bad))),
                    owed_now=owed, overdue=overdue, limit=limit, plan=plan, **{k: plan[k] for k in ("exposure", "advance")})

    def backtest(self):
        """Leave-one-out: hide each well-known customer's own history, predict them only from
        similar customers, compare with what their history actually shows."""
        rows = []
        for c in self.reference:
            if c["b"]["n"] < 8:
                continue
            sim = self.similar(self.profile(c), exclude=c["id"])
            rows.append((c, risk_class(c["b"]["own_score"]), risk_class(sim["score"]),
                         abs(sim["typical"] - c["b"]["typical"])))
        order = {c: i for i, c in enumerate(CLASSES)}
        exact = sum(a == p for _, a, p, _ in rows)
        near = sum(abs(order[a] - order[p]) <= 1 for _, a, p, _ in rows)
        mae = sum(e for *_, e in rows) / len(rows)
        base = max(CLASSES, key=lambda k: sum(a == k for _, a, _, _ in rows))
        base_hits = sum(a == base for _, a, _, _ in rows)
        return dict(rows=rows, n=len(rows), exact=exact, near=near, mae=mae, baseline=base, baseline_hits=base_hits)


# ----------------------------------------------------------------------------- reporting
def inr(x):
    n = int(round(x)); s = str(abs(n))
    if len(s) > 3:
        head, tail, parts = s[:-3], s[-3:], []
        while len(head) > 2:
            parts.insert(0, head[-2:]); head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("-" if n < 0 else "") + "Rs " + s


def table(head, rows):
    w = [max(len(str(r[i])) for r in rows + [head]) for i in range(len(head))]
    line = lambda r: "  ".join(str(c).ljust(w[i]) for i, c in enumerate(r))
    print(line(head)); print("  ".join("-" * x for x in w))
    for r in rows:
        print(line(r))


def show_all(m, include_past):
    cs = [c for c in m.custs.values() if include_past or c["source"] == "current"]
    cs.sort(key=lambda c: -c["b"]["score"])
    rows = []
    for c in cs:
        b = c["b"]
        rows.append([c["name"], c["type"], b["class"], f"{b['score']:.0f}",
                     f"{b['typical_pred']:.0f}d" if b["typical_pred"] is not None else "-",
                     f"{b['bad_pred']:.0f}d" if b["bad_pred"] is not None else "-",
                     b["n"], b["confidence"], inr(b["owed"])])
    table(["Customer", "Type", "Decision", "Score", "Usually late", "Bad case", "Paid inv.", "Confidence", "Owes you"], rows)
    for c in cs:
        b = c["b"]
        d = m.deal(b["avg_order"] or 100000, c["terms"], customer=c)
        print(f"\n{c['name']} — {b['class']} (score {b['score']:.0f})")
        print("  Why:  " + "; ".join(b["reasons"]))
        print(f"  Next order (~{inr(b['avg_order'] or 100000)}, asks {c['terms']} days):")
        for x in d["plan"]["actions"]:
            print("   - " + x)


def save_csv(m):
    out = HERE / "outputs"; out.mkdir(exist_ok=True)
    with open(out / "customer_risk.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "type", "years", "source", "class", "score", "typical_delay", "bad_case_delay",
                    "paid_invoices", "confidence", "owed", "overdue", "reasons"])
        for c in sorted(m.custs.values(), key=lambda c: -c["b"]["score"]):
            b = c["b"]
            w.writerow([c["id"], c["name"], c["type"], c["years"], c["source"], b["class"], round(b["score"], 1),
                        round(b["typical_pred"], 1) if b["typical_pred"] is not None else "",
                        round(b["bad_pred"], 1) if b["bad_pred"] is not None else "",
                        b["n"], b["confidence"], round(b["owed"]), round(b["overdue_amount"]), "; ".join(b["reasons"])])


def show_new(m, a):
    p = m.predict_new(a.type, a.years, a.order, a.terms)
    print(f"New customer: {a.type}, {a.years} yrs in business, typical order {inr(a.order)}, asks {a.terms} days credit\n")
    print(f"Predicted class: {p['class']}  (score {p['score']:.0f}/100, confidence {p['confidence']})")
    print(f"Likely to pay about {p['typical']:.0f} days late; bad case {p['bad']:.0f} days late\n")
    print(f"Based on the {len(p['neighbours'])} most similar past customers:")
    table(["Similar customer", "Type", "Similarity", "Their score", "Their class"],
          [[n, t, f"{100 / (1 + d):.0f}%", f"{s:.0f}", risk_class(s)] for n, t, d, s in p["neighbours"]])
    print(f"\n{sum(c != FULL for c in p['classes'])} of {len(p['classes'])} similar customers needed limited credit or advance.")
    d = m.deal(a.order, a.terms, new_profile=dict(ctype=a.type, years=a.years, order=a.order, terms=a.terms))
    print(f"\nWhat to do for a first order of {inr(a.order)}:")
    for x in d["plan"]["actions"]:
        print("  - " + x)


def show_deal(m, a):
    if a.deal.upper() == "NEW":
        d = m.deal(a.amount, a.terms, new_profile=dict(ctype=a.type, years=a.years, order=a.order or a.amount, terms=a.terms))
    else:
        d = m.deal(a.amount, a.terms, customer=m.find(a.deal))
    print(f"Deal: {d['who']} | {inr(a.amount)} on {a.terms} days credit | today {m.today}\n")
    p = d["plan"]
    print(f"DECISION: {d['cls'].upper()}  (risk score {d['score']:.0f}/100)\n")
    print(f"Already owes you:  {inr(d['owed_now'])}" + (f"  ({inr(d['overdue'])} overdue)" if d["overdue"] else ""))
    print(f"Total after deal:  {inr(d['exposure'])}   (credit limit: {inr(d['limit'])})")
    print(f"If you agree to {a.terms} days: money most likely {d['expected']} (bad case {d['bad_case']})\n")
    print("What to do:")
    for i, x in enumerate(p["actions"], 1):
        print(f"  {i}. {x}")
    print("\nWith these terms:")
    if p["advance"]:
        print(f"  {inr(p['advance'])} comes in before dispatch")
    if p["on_credit"]:
        print(f"  {inr(p['on_credit'])} on {p['terms']} days credit, most likely in by {p['arrival_planned']}"
              + (f" (instead of {p['arrival_asked']})" if p["arrival_planned"] != p["arrival_asked"] else ""))


def show_backtest(m):
    r = m.backtest()
    print("Backtest: for each customer with 8+ paid invoices, hide their own history and predict them")
    print("only from similar customers, then compare with what their history actually shows.\n")
    table(["Customer", "Type", "Actual class", "Predicted", "Delay error"],
          [[c["name"], c["type"], a, p, f"{e:.0f} days"] for c, a, p, e in r["rows"]])
    print(f"\nExact class right: {r['exact']}/{r['n']} ({r['exact'] / r['n'] * 100:.0f}%)   "
          f"Within one class: {r['near']}/{r['n']} ({r['near'] / r['n'] * 100:.0f}%)   "
          f"Average delay error: {r['mae']:.1f} days")
    print(f"For comparison, always guessing the most common class ('{r['baseline']}') gets "
          f"{r['baseline_hits']}/{r['n']} ({r['baseline_hits'] / r['n'] * 100:.0f}%).")


def main():
    ap = argparse.ArgumentParser(description="Customer risk model")
    ap.add_argument("--data", default=str(HERE / "data"))
    ap.add_argument("--all", action="store_true", help="also list the past customers")
    ap.add_argument("--list", action="store_true", help="list customer names")
    ap.add_argument("--new", action="store_true", help="predict a new customer from its profile")
    ap.add_argument("--deal", help="customer name, or NEW with --type/--years/--order")
    ap.add_argument("--type", choices=TYPES)
    ap.add_argument("--years", type=float, default=3)
    ap.add_argument("--order", type=float, help="typical order value (Rs)")
    ap.add_argument("--terms", type=int, default=30, help="credit days")
    ap.add_argument("--amount", type=float, help="deal amount (Rs)")
    ap.add_argument("--backtest", action="store_true")
    a = ap.parse_args()
    m = RiskModel(a.data)

    if a.list:
        for c in sorted(m.custs.values(), key=lambda c: c["name"]):
            print(f"{c['name']}  ({c['type']}, {c['source']})")
    elif a.new:
        if not a.type or not a.order:
            raise SystemExit("--new needs --type and --order (and optionally --years, --terms)")
        show_new(m, a)
    elif a.deal:
        if not a.amount:
            raise SystemExit("--deal needs --amount")
        if a.deal.upper() == "NEW" and not a.type:
            raise SystemExit("--deal NEW needs --type")
        show_deal(m, a)
    elif a.backtest:
        show_backtest(m)
    else:
        print(f"Customer risk on {m.today}  (score 0-100: 0-30 Full credit, 31-55 Limited credit, 56+ Advance only)\n")
        show_all(m, a.all)
        save_csv(m)
        print("\nFull list incl. past customers saved to outputs/customer_risk.csv")
    print("\nEstimates from past payment behaviour on the data provided; not financial advice.")


if __name__ == "__main__":
    main()
