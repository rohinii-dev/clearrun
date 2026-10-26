"""
Generates the SYNTHETIC past-customer history used by customer_risk.py.
Run once: python tools/make_customer_history.py   (fixed seed, same output every time)

Writes:
  data/customer_profiles.csv  - type and years in business for ALL customers (existing 1-5 + past 101+)
  data/past_customers.csv     - same columns as customers.csv, for past customers
  data/past_invoices.csv      - same columns as invoices.csv, for past customers

Patterns built in (so similar customers behave similarly, with noise):
  Govt/PSU very late and erratic; Large company steadily late; SME manufacturer mostly on time;
  Distributor in between; Trader/Retailer late and erratic. Young businesses pay later and less
  predictably. A few customers slow down recently; a few have long-overdue unpaid invoices.
"""
import csv, random
from datetime import date, timedelta
from pathlib import Path

random.seed(7)
DATA = Path(__file__).resolve().parent.parent / "data"
TODAY = date(2026, 10, 24)

TYPES = {  # median delay, spread, order value, typical terms
    "Large company":    (18, 6, 300000, [45, 60]),
    "Govt/PSU":         (42, 16, 400000, [60]),
    "SME manufacturer": (8, 6, 150000, [30]),
    "Distributor":      (15, 9, 200000, [30, 45]),
    "Trader/Retailer":  (22, 13, 80000, [15, 30]),
}
EXISTING = {1: ("Large company", 15), 2: ("SME manufacturer", 9), 3: ("Trader/Retailer", 4),
            4: ("Trader/Retailer", 3), 5: ("Trader/Retailer", 1)}
NAMES = ["Sai Krishna Traders", "Ganesh Distributors", "Karnataka Power Corp Unit", "Shiva Textiles", "Mysore Polymers",
         "Hubli Steel Works", "Annapurna Retail", "Balaji Agencies", "Vijay Auto Parts", "Kaveri Agro Products",
         "Southern Railway Workshop", "Lakshmi Garments", "Navya Distributors", "Prakash Hardware", "Raghavendra Stores",
         "Tumkur Castings", "Bharat Electricals", "Sri Venkateshwara Mills", "Metro Fashions", "Deccan Pharma Supplies",
         "Ashok Industries", "City Mart", "Coastal Fisheries Co-op", "Gokul Dairy Equipment", "Om Sai Enterprises",
         "Kalyan Textiles", "Indus Packaging", "Pioneer Engineering", "Royal Traders", "State Transport Depot",
         "Vasavi Distributors", "Excel Components", "New Age Retail", "Sunrise Plastics", "Mahalakshmi Silks"]
TYPE_CYCLE = (["Trader/Retailer"] * 10 + ["SME manufacturer"] * 8 + ["Distributor"] * 7 +
              ["Large company"] * 6 + ["Govt/PSU"] * 4)
random.shuffle(TYPE_CYCLE)
# names that obviously imply a type
FIX = {"Karnataka Power Corp Unit": "Govt/PSU", "Southern Railway Workshop": "Govt/PSU",
       "State Transport Depot": "Govt/PSU", "Coastal Fisheries Co-op": "Govt/PSU"}

profiles, customers, invoices = [], [], []
for cid, (t, yrs) in EXISTING.items():
    profiles.append([cid, t, yrs])

pool = [t for t in TYPE_CYCLE]
for name in FIX:
    pool.remove(FIX[name])
for i, name in enumerate(NAMES):
    cid = 101 + i
    t = FIX.get(name) or pool.pop()
    med, spr, order, terms_opts = TYPES[t]
    yrs = random.choice([1, 2, 3, 5, 7, 10, 15, 25])
    terms = random.choice(terms_opts)
    young = yrs <= 3
    cust_med = med + random.gauss(0, 5) + (8 if young else -3 if yrs >= 10 else 0)
    cust_spr = max(3, spr + random.gauss(0, 3) + (4 if young else 0))
    n = random.choice([3, 4, 6, 8, 10, 12, 14, 16, 18]) if i % 6 else random.choice([2, 3])
    slowing = random.random() < 0.12
    defaulter = random.random() < (0.25 if (t in ("Trader/Retailer", "Govt/PSU") or young) else 0.06)
    cust_order = order * random.uniform(0.5, 1.8)
    start = TODAY - timedelta(days=30 * n + random.randint(40, 120))
    late_count = 0
    for k in range(n):
        inv_date = start + timedelta(days=30 * k + random.randint(-5, 5))
        due = inv_date + timedelta(days=terms)
        d = random.gauss(cust_med, cust_spr)
        if slowing and k >= n - 4:
            d += 15
        d = int(round(max(-5, d)))
        paid = due + timedelta(days=d)
        unpaid = defaulter and k >= n - random.choice([1, 2]) and (TODAY - due).days > 20
        if paid > TODAY:  # would be paid in the future -> still open
            unpaid = True
        late_count += d > 15
        amt = int(round(random.lognormvariate(0, 0.35) * cust_order / 1000)) * 1000
        invoices.append([f"P{cid}-{k + 1:02d}", cid, amt, inv_date.isoformat(), due.isoformat(),
                         "" if unpaid else paid.isoformat()])
    prom = random.randint(0, 8)
    broken = min(prom, int(round(prom * min(0.9, max(0.0, (cust_med - 5) / 50 + random.gauss(0, 0.1))))))
    customers.append([cid, name, terms, prom - broken, broken])
    profiles.append([cid, t, yrs])

def write(fn, head, rows):
    with open(DATA / fn, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(head); w.writerows(rows)

write("customer_profiles.csv", ["id", "customer_type", "years_in_business"], profiles)
write("past_customers.csv", ["id", "name", "credit_terms_days", "promises_kept", "promises_broken"], customers)
write("past_invoices.csv", ["invoice_no", "customer_id", "amount", "invoice_date", "due_date", "paid_date"], invoices)
print(f"{len(customers)} past customers, {len(invoices)} invoices written to {DATA}")
