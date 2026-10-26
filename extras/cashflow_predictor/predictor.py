"""
Cash-flow scenario predictor (standalone, numpy only).

Answers: "Given what I am owed, what I must pay, and how my customers
really behave, what is the chance my cash drops below my safety buffer,
when, and how does that change under a scenario?"

Run:   python predictor.py                    (all scenarios)
       python predictor.py --rank-invoices    (which invoice matters most)
       python predictor.py --scenario "Sales drop 25%"
"""
import argparse
import csv
import json
import math
from calendar import monthrange
from datetime import datetime, timedelta
from pathlib import Path
from statistics import NormalDist

import numpy as np

HERE = Path(__file__).resolve().parent
ND = NormalDist()


# --------------------------------------------------------------------------- loading
def _date(s):
    return datetime.strptime(s, "%Y-%m-%d").date() if s else None


def _rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_data(data_dir):
    p = Path(data_dir)
    cfg = json.loads((p / "business.json").read_text(encoding="utf-8"))
    cfg["today"] = _date(cfg["today"])
    customers = [dict(id=int(r["id"]), name=r["name"], terms=int(r["credit_terms_days"]),
                      kept=int(r["promises_kept"]), broken=int(r["promises_broken"]))
                 for r in _rows(p / "customers.csv")]
    invoices = [dict(no=r["invoice_no"], cid=int(r["customer_id"]), amount=float(r["amount"]),
                     inv_date=_date(r["invoice_date"]), due=_date(r["due_date"]),
                     paid=_date(r["paid_date"])) for r in _rows(p / "invoices.csv")]
    payables = [dict(supplier=r["supplier"], amount=float(r["amount"]), bill=_date(r["bill_date"]),
                     due=_date(r["due_date"]), paid=_date(r["paid_date"]),
                     msme=int(r["supplier_is_msme"]) == 1)
                for r in _rows(p / "payables.csv")]
    recurring = [dict(label=r["label"], amount=float(r["amount"]), dom=int(r["day_of_month"]))
                 for r in _rows(p / "recurring.csv")]
    promises = {r["invoice_no"]: _date(r["promised_date"]) for r in _rows(p / "promises.csv")}
    return cfg, customers, invoices, payables, recurring, promises


# --------------------------------------------------------------------------- math 1: behaviour
def _wstats(xs, ws):
    """Weighted mean, variance and effective sample size."""
    W = sum(ws)
    m = sum(w * x for x, w in zip(xs, ws)) / W
    v = sum(w * (x - m) ** 2 for x, w in zip(xs, ws)) / W
    n_eff = W * W / sum(w * w for w in ws)
    return m, v, n_eff


def fit_behaviour(customers, invoices, cfg):
    """Per-customer payment-delay distribution (days after due date).
    - recent invoices count more (exponential decay, half-life cfg)
    - few observations -> shrink toward the all-customer average
    - few observations -> widen the spread (we are less sure)"""
    today, half, k = cfg["today"], cfg["half_life_days"], cfg["shrinkage_k"]
    obs = {}
    for i in invoices:
        if i["paid"]:
            delay = (i["paid"] - i["due"]).days
            w = 0.5 ** ((today - i["paid"]).days / half)
            obs.setdefault(i["cid"], []).append((delay, w))
    allx = [x for l in obs.values() for x, _ in l]
    allw = [w for l in obs.values() for _, w in l]
    gm, gv, _ = _wstats(allx, allw) if allx else (15.0, 100.0, 0)
    out = {}
    for c in customers:
        if c["id"] in obs:
            xs, ws = zip(*obs[c["id"]])
            m, v, n = _wstats(xs, ws)
        else:
            m, v, n = gm, gv, 0.0
        mu = (n * m + k * gm) / (n + k)
        var = (n * v + k * gv) / (n + k) * (1 + k / (n + k))
        out[c["id"]] = dict(mu=mu, sigma=max(cfg["min_std_days"], math.sqrt(var)), n_eff=n)
    return out


def promise_reliability(kept, broken):
    """Beta(1,1) prior -> posterior mean probability a promise is kept."""
    return (kept + 1) / (kept + broken + 2)


def msmed_interest(amount, late_days, bank_rate, multiplier):
    """Compound interest, monthly rests, at multiplier x bank rate (annual)."""
    if late_days <= 0:
        return 0.0
    m = multiplier * bank_rate / 12.0
    months, rem = divmod(late_days, 30)
    return amount * (1 + m) ** months * (1 + m * rem / 30.0) - amount


def draw_delay(mu, sigma, Z, U, min_delay):
    """Delay ~ Normal(mu, sigma) truncated below at min_delay (inverse-CDF method)."""
    if min_delay is None or min_delay <= mu - 4 * sigma:
        return mu + sigma * Z
    lo = min(ND.cdf((min_delay - mu) / sigma), 1 - 1e-6)
    p = np.clip(lo + U * (1 - lo), 1e-9, 1 - 1e-9)
    return mu + sigma * np.array([ND.inv_cdf(x) for x in p])


# --------------------------------------------------------------------------- model
class Model:
    def __init__(self, data_dir=HERE / "data", runs=None, seed=None):
        (self.cfg, self.customers, self.invoices, self.payables,
         self.recurring, self.promises) = load_data(data_dir)
        cfg = self.cfg
        self.today = cfg["today"]
        self.H = int(cfg["horizon_days"])
        self.R = int(runs or cfg["runs"])
        self.cname = {c["id"]: c["name"] for c in self.customers}
        self.cust = {c["id"]: c for c in self.customers}
        self.behave = fit_behaviour(self.customers, self.invoices, cfg)
        self.open_inv = sorted([i for i in self.invoices if not i["paid"]], key=lambda i: i["no"])
        self._fit_sales()
        # math 5: Common random numbers. All random draws are made ONCE here, so every
        # scenario sees the same "luck" and differences are caused by the scenario only.
        rng = np.random.default_rng(seed if seed is not None else cfg["seed"])
        R = self.R
        self.draws_open = [dict(Z=rng.standard_normal(R), U=rng.random(R),
                                Up=rng.random(R), Zp=rng.standard_normal(R))
                           for _ in self.open_inv]
        self.draws_future = {}
        for cid, s in self.sales.items():
            self.draws_future[cid] = dict(E=rng.exponential(1.0, (s["slots"], R)),
                                          Za=rng.standard_normal((s["slots"], R)),
                                          Zd=rng.standard_normal((s["slots"], R)))

    # math 2: future sales (invoices not yet issued)
    def _fit_sales(self):
        look = self.cfg["future_sales_lookback_days"]
        start = self.today - timedelta(days=look)
        self.sales = {}
        for c in self.customers:
            amts = [i["amount"] for i in self.invoices
                    if i["cid"] == c["id"] and i["inv_date"] >= start]
            if not amts:
                continue
            rate = len(amts) / (look / 30.0)                 # invoices per 30 days
            logs = np.log(amts)
            self.sales[c["id"]] = dict(
                rate=rate, mu_log=float(logs.mean()),
                sigma_log=max(0.1, float(logs.std())),
                slots=int(math.ceil(rate * self.H / 30.0 * 2)) + 3)

    # ------------------------------------------------------------------ one scenario
    def run(self, scen=None):
        scen = scen or {}
        H, R, today, cfg = self.H, self.R, self.today, self.cfg
        rows = np.arange(R)
        inflow = np.zeros((R, H + 1))
        out = np.zeros(H + 1)

        def add_inflow(days, amt):
            days = np.maximum(np.rint(days).astype(int), 1)
            amt = np.broadcast_to(amt, (R,))
            ok = days <= H
            np.add.at(inflow, (rows[ok], days[ok]), amt[ok])

        shifts = scen.get("delay_shift_days", {})
        shift_of = lambda cid: shifts.get("ALL", 0) + shifts.get(self.cname[cid], 0)
        force = scen.get("force_paid", {})

        # math 3: money already invoiced (open + overdue invoices)
        for inv, dr in zip(self.open_inv, self.draws_open):
            if inv["no"] in force:
                add_inflow(np.full(R, force[inv["no"]]), inv["amount"])
                continue
            b = self.behave[inv["cid"]]
            shift = shift_of(inv["cid"])
            due_day = (inv["due"] - today).days
            min_delay = max(-3, 1 - due_day)                   # cannot be received in the past
            mu = b["mu"] + shift
            promised = self.promises.get(inv["no"])
            if promised is None:
                delay = draw_delay(mu, b["sigma"], dr["Z"], dr["U"], min_delay)
                add_inflow(due_day + delay, inv["amount"])
            else:
                pday = (promised - today).days + shift
                r = promise_reliability(self.cust[inv["cid"]]["kept"], self.cust[inv["cid"]]["broken"])
                kept = dr["Up"] < r
                day_kept = pday + 2.0 * dr["Zp"]               # kept: lands near promised date
                broken_min = max(min_delay, pday + 1 - due_day)
                delay_b = draw_delay(mu, b["sigma"], dr["Z"], dr["U"], broken_min)
                add_inflow(np.where(kept, day_kept, due_day + delay_b), inv["amount"])

        # math 2 (cont.): invoices that will be issued in the horizon
        drop = float(scen.get("sales_drop", 0.0))
        for cid, s in self.sales.items():
            d = self.draws_future[cid]
            gap = 30.0 / s["rate"] / max(1e-6, 1 - drop)
            arrive = np.cumsum(d["E"], axis=0) * gap           # days from today, shape (slots, R)
            amounts = np.exp(s["mu_log"] + s["sigma_log"] * d["Za"])
            b = self.behave[cid]
            delay = b["mu"] + shift_of(cid) + b["sigma"] * d["Zd"]
            receive = arrive + self.cust[cid]["terms"] + delay
            for k in range(s["slots"]):
                add_inflow(receive[k], amounts[k])

        # fixed / known outflows
        cost_interest = 0.0
        ext = scen.get("supplier_extension_days", {})
        for p in self.payables:
            if p["paid"]:
                continue
            e = ext.get(p["supplier"], 0)
            day = max(1, (p["due"] - today).days + e)
            if day <= H:
                out[day] += p["amount"]
            if p["msme"] and e:                                 # math 4: cost of paying an MSME late
                appointed = min(p["due"], p["bill"] + timedelta(days=cfg["msmed_max_days"]))
                late = (p["due"] + timedelta(days=e) - appointed).days
                base = (p["due"] - appointed).days
                cost_interest += (msmed_interest(p["amount"], late, cfg["msmed_bank_rate"], cfg["msmed_multiplier"])
                                  - msmed_interest(p["amount"], base, cfg["msmed_bank_rate"], cfg["msmed_multiplier"]))
        for day in range(1, H + 1):
            dt = today + timedelta(days=day)
            for r in self.recurring:
                if dt.day == min(r["dom"], monthrange(dt.year, dt.month)[1]):
                    out[day] += r["amount"]
        for x in scen.get("one_time_expenses", []):
            if 1 <= x["day"] <= H:
                out[x["day"]] += x["amount"]
        for x in scen.get("extra_inflows", []):
            add_inflow(np.full(R, x["day"]), float(x["amount"]))

        # math 6: balances and risk numbers
        bal = cfg["opening_cash"] + np.cumsum(inflow - out[None, :], axis=1)
        bal[:, 0] = cfg["opening_cash"]
        buf = cfg["min_buffer"]
        below = bal[:, 1:] < buf
        breached = below.any(axis=1)
        first = np.argmax(below, axis=1) + 1
        min30 = bal[:, 1:31].min(axis=1)
        q = lambda p: np.percentile(bal, p, axis=0)
        return dict(
            p10=q(10), p50=q(50), p90=q(90),
            prob_below_buffer=float(breached.mean()),
            prob_negative=float((bal[:, 1:] < 0).any(axis=1).mean()),
            median_first_breach_day=int(np.median(first[breached])) if breached.any() else None,
            expected_min_balance=float(bal[:, 1:].min(axis=1).mean()),
            safe_to_spend_today=float(max(0.0, np.percentile(min30, 10) - buf)),
            extra_msmed_interest=float(cost_interest),
        )


# --------------------------------------------------------------------------- reporting
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


def summarise(model, name, res):
    day = res["median_first_breach_day"]
    when = (model.today + timedelta(days=day)).isoformat() if day else "-"
    return [name, f"{res['prob_below_buffer']*100:5.1f}%", f"{res['prob_negative']*100:5.1f}%",
            when, inr(res["expected_min_balance"]), inr(res["safe_to_spend_today"]),
            inr(res["extra_msmed_interest"])]


def print_table(rows):
    head = ["Scenario", "P(<buffer)", "P(<0)", "Typical 1st breach", "Avg lowest cash",
            "Safe to spend now", "Extra MSME interest"]
    w = [max(len(str(r[i])) for r in rows + [head]) for i in range(len(head))]
    line = lambda r: "  ".join(str(c).ljust(w[i]) for i, c in enumerate(r))
    print(line(head)); print("  ".join("-" * x for x in w))
    for r in rows:
        print(line(r))


def rank_invoices(model, top=6):
    """Cash critical path: how much would collecting each open invoice in 3 days
    cut the chance of breaching the buffer?  (same random numbers -> fair comparison)"""
    base = model.run()["prob_below_buffer"]
    scores = []
    for inv in model.open_inv:
        r = model.run({"force_paid": {inv["no"]: 3}})["prob_below_buffer"]
        scores.append((base - r, inv))
    scores.sort(key=lambda t: -t[0])
    print(f"\nBaseline P(below buffer) = {base*100:.1f}%.  If collected within 3 days:")
    for gain, inv in scores[:top]:
        print(f"  {inv['no']}  {model.cname[inv['cid']]:<22} {inr(inv['amount']):>13}  "
              f"due {inv['due']}  -> risk drops {gain*100:4.1f} points")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data"))
    ap.add_argument("--scenario", help="run only the scenario with this name")
    ap.add_argument("--runs", type=int, help="number of simulations (default from business.json)")
    ap.add_argument("--rank-invoices", action="store_true")
    ap.add_argument("--chart", action="store_true", help="save PNG charts (needs matplotlib)")
    a = ap.parse_args()

    m = Model(a.data, runs=a.runs)
    scens = json.loads((Path(a.data) / "scenarios.json").read_text(encoding="utf-8"))
    if a.scenario:
        scens = [s for s in scens if s["name"] == a.scenario]
        if not scens:
            raise SystemExit("No scenario with that name in scenarios.json")

    print(f"Today {m.today} | opening cash {inr(m.cfg['opening_cash'])} | buffer {inr(m.cfg['min_buffer'])} "
          f"| {m.R} simulations | {m.H} days\n")
    print("Learned payment behaviour (days after due date):")
    for cid, b in m.behave.items():
        print(f"  {m.cname[cid]:<22} avg {b['mu']:5.1f}  spread {b['sigma']:4.1f}  (evidence {b['n_eff']:4.1f} invoices)")
    print()

    out_dir = HERE / "outputs"; out_dir.mkdir(exist_ok=True)
    table, results = [], {}
    for s in scens:
        res = m.run(s)
        results[s["name"]] = res
        table.append(summarise(m, s["name"], res))
        with open(out_dir / ("forecast_" + "".join(ch if ch.isalnum() else "_" for ch in s["name"]) + ".csv"),
                  "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f); wr.writerow(["date", "p10", "p50", "p90"])
            for d in range(m.H + 1):
                wr.writerow([(m.today + timedelta(days=d)).isoformat(),
                             round(res["p10"][d]), round(res["p50"][d]), round(res["p90"][d])])
    print_table(table)
    print("\nEstimates from a simulation on the data provided; not financial or legal advice.")
    if a.rank_invoices:
        rank_invoices(m)
    if a.chart:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            print("matplotlib not installed: pip install matplotlib"); return
        for name, res in results.items():
            fig, ax = plt.subplots(figsize=(9, 4))
            x = range(m.H + 1)
            ax.fill_between(x, res["p10"], res["p90"], alpha=0.25, label="10th-90th percentile")
            ax.plot(x, res["p50"], label="median")
            ax.axhline(m.cfg["min_buffer"], color="red", ls="--", label="min buffer")
            ax.set_title(name); ax.set_xlabel("days from today"); ax.set_ylabel("cash (Rs)"); ax.legend()
            fig.tight_layout()
            fig.savefig(out_dir / ("chart_" + "".join(ch if ch.isalnum() else "_" for ch in name) + ".png"))
            plt.close(fig)
        print("Charts saved in outputs/")


if __name__ == "__main__":
    main()
