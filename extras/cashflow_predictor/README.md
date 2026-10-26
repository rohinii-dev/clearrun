# Cash-Flow Scenario Predictor (standalone)

Answers one question: *given what I am owed, what I must pay, and how my customers
actually behave, what is the chance my cash drops below my safety buffer, when,
and how does that change under a scenario?*

Only needs Python 3.8+ and numpy. No database, no web server, no internet.

## Run (Windows / Mac / Linux)
```
pip install numpy
python predictor.py                        # all scenarios in data/scenarios.json
python predictor.py --rank-invoices        # which invoice to chase first
python predictor.py --scenario "Sales drop 25%"
python predictor.py --runs 500             # faster
python -m unittest discover -s tests -v    # 10 tests
```
Results are also written to `outputs/forecast_<scenario>.csv` (date, p10, p50, p90).
Optional charts: `pip install matplotlib` then `python predictor.py --chart`.

## Dataset (data/)
| File | What it holds | Used for |
|---|---|---|
| business.json | today, opening cash, minimum buffer, horizon, simulation runs, seed, model settings, MSMED rate (placeholder) | everything |
| customers.csv | id, name, credit terms, promises kept / broken | behaviour, promise reliability |
| invoices.csv | invoice no, customer, amount, invoice date, due date, paid date (blank = unpaid) | learning delays, open receivables, future sales rate |
| payables.csv | supplier, amount, bill date, due date, paid date, is MSME, flexibility | outflows, MSMED cost |
| recurring.csv | payroll, rent, EMI, GST/TDS/PF (placeholders) with day of month | outflows |
| promises.csv | invoice no, promised date | promise blending |
| scenarios.json | named what-ifs | scenario comparison |

All values are synthetic. GST/TDS/PF amounts, dates and the MSMED bank rate are
PLACEHOLDERS: verify against official sources before using the numbers.

## The math
**1. Customer payment behaviour.** For each customer, delay = paid date - due date.
Each observation gets weight `w = 0.5^(age_days / 90)` so recent behaviour counts more
(this catches a customer who has recently started paying late). Weighted mean `m`, variance `v`
and effective sample size `n = (sum w)^2 / sum w^2`.
Shrinkage toward the all-customer mean `g` with strength `k = 3`:
`mu = (n*m + k*g) / (n + k)`, `var = (n*v + k*gv) / (n + k) * (1 + k/(n + k))`.
Few observations means the estimate is pulled toward the average and the spread widens
(a brand-new customer gets the portfolio average with wide uncertainty).
Delay ~ Normal(mu, sigma), sigma at least 2 days.

**2. Money already invoiced.** Receipt day = due day + delay. If the invoice is already
overdue, the delay is *truncated* so the receipt cannot be in the past:
`p = F(min) + U * (1 - F(min))`, `delay = mu + sigma * inverse_normal(p)` (inverse-CDF sampling).

**3. Promises.** Reliability `r = (kept + 1) / (kept + broken + 2)` (Beta(1,1) posterior mean).
With probability `r` the payment lands near the promised date (+/- 2 days); otherwise the
baseline delay applies, truncated to fall after the promised date.

**4. Invoices not yet issued.** Rate per customer = invoices per 30 days over the last 180 days.
Arrivals are a Poisson process (exponential gaps, mean 30/rate). Amounts are log-normal fitted to
recent invoices. Each future invoice is received after credit terms + that customer's delay.
A sales drop `d` stretches the gaps by `1/(1-d)`.

**5. Outflows.** Unpaid supplier bills on their due day (plus any extension), recurring items on
their day of month (clipped to month end), one-time expenses and extra inflows as given.

**6. Cost of paying an MSME supplier late (MSMED).** Appointed day = min(due date, bill date + 45).
Interest = `amount * ((1+m)^months * (1 + m*rem/30) - 1)` with `m = 3 * bank_rate / 12`
(compound, monthly rests, three times the bank rate). Only the *extra* interest caused by the
extension is reported. Rules and rate must be verified from the Act / RBI.

**7. Monte Carlo and common random numbers.** 2,000 simulated futures. All random numbers are
drawn once and reused in every scenario, so differences between scenarios come from the scenario,
not luck. Daily balance = opening cash + cumulative (inflow - outflow).

**8. Outputs.**
- `P(<buffer)`: share of runs where balance falls below buffer on any day.
- `P(<0)`: share of runs where cash goes negative.
- 10th / 50th / 90th percentile balance for each day.
- `Safe to spend now = max(0, 10th percentile of each run's lowest balance in the next 30 days - buffer)`:
  an amount you could pay out today and still stay above the buffer in 90% of simulated futures.
- Cash critical path (`--rank-invoices`): re-run with one invoice collected in 3 days; the drop in
  `P(<buffer)` is that invoice's value.

## Limitations (say these out loud)
- Normal delays are a simplification; real delays are skewed. Customers with few invoices are uncertain.
- A customer who abruptly stops paying will be under-predicted until new data arrives.
- Future supplier bills must be listed in payables.csv; they are not forecast.
- Sales drop does not reduce purchases; no seasonality; no bad-debt write-offs; no taxes on income.
- Short horizons are dominated by what is already invoiced, so a sales drop shows a small effect within 90 days.
- Estimates only; not financial or legal advice.

---

# Customer Risk Model (`customer_risk.py`)

Scores how risky each customer is, predicts how a **new** customer will pay by comparing it with
similar past customers, and gives a credit decision when you are about to make a **deal**.
Standard library only (no numpy needed).

## Run
```
python customer_risk.py                      # score current customers (outputs/customer_risk.csv has all 40)
python customer_risk.py --all                # include the 35 past customers in the table
python customer_risk.py --new --type "Trader/Retailer" --years 2 --order 120000 --terms 30
python customer_risk.py --deal "Delta Traders" --amount 300000 --terms 30
python customer_risk.py --deal NEW --type "Govt/PSU" --years 20 --amount 500000 --terms 60
python customer_risk.py --backtest           # accuracy of new-customer predictions
python -m unittest discover -s tests -v      # 32 tests (10 predictor + 22 risk model)
```
Customer types: `Large company`, `Govt/PSU`, `SME manufacturer`, `Distributor`, `Trader/Retailer`.

## Extra data (data/) — SYNTHETIC
| File | Holds |
|---|---|
| customer_profiles.csv | type and years in business for every customer (current 1-5 and past 101+) |
| past_customers.csv | 35 past customers (same columns as customers.csv) |
| past_invoices.csv | their 282 invoices (same columns as invoices.csv) |

Regenerate with `python tools/make_customer_history.py` (fixed seed). The cash predictor does not read these files.

## How a score is built (0-100)
| Signal | Points |
|---|---|
| Lateness: typical (median) days late | 0 days = 0 ... 45+ days = 25 |
| Unpredictability: bad case (80th percentile) minus typical | 0 = 0 ... 30+ days = 15 |
| Very late: share of invoices paid or still unpaid 45+ days after due | up to 20 |
| Broken promises: share of payment promises broken (neutral 30% if fewer than 2) | up to 15 |
| Overdue now: oldest unpaid invoice | 0 days = 0 ... 60+ days = 15 |
| Slowing down: last 4 payments 7+ days later than usual (typical then uses the recent level) | 10 |

**0-30 Full credit · 31-55 Limited credit · 56-100 Advance only** (classes are named by what to do).

## New customer = compare with similar past customers
Profile: type, years in business, typical order size, credit days asked. Distance to every past customer
with 5+ paid invoices: type differs = 3.0; years = 1.5 x log-difference; order size = 1.0 x log-difference;
credit days = 1.0 x difference / 60. The 5 closest are weighted by 1/(distance + 0.1) and their scores and
delays averaged. The output names those 5 customers so the prediction can be explained.
A current customer with fewer than 8 paid invoices is mixed the same way: own history weight n/(n+5).

## Deal decision and what to do
Expected payment = today + credit days + predicted typical delay (bad case uses the 80th percentile).
Credit limit = factor x monthly billing x (credit days + typical delay)/30, factor 1.5 / 1.0 / 0.5 by class
(new customers: factor x one order).

Actions are chosen from the customer's own weak spots, with amounts and dates filled in:
| Situation | Suggested action |
|---|---|
| Full credit | Give requested terms; if usually 15+ days late, offer 1.5% off for payment within 7 days |
| Full credit but total credit over limit | Dispatch the part that fits now, the rest after the next invoice is paid |
| Limited credit | Shorter credit days so money arrives near the day you planned (15 days minimum); reminder 5 days before due + call on due date |
| ... and breaks promises (40%+) | Post-dated cheque for the credit part |
| ... and unpredictable (bad case 15+ days after typical) | Split into 2 deliveries; second only after first is paid |
| ... otherwise | 25% advance before dispatch |
| ... and already over their limit | Take this order fully in advance, or wait for open invoices |
| Advance only | 50% advance + post-dated cheque for the rest; 100% if often 45+ days late or 60+ days overdue now; back to credit after 3 on-time invoices |
| Overdue more than 7 days (limited/advance) | Collect it before dispatching |
| Slowing down | Call to check how their business is doing before raising credit |
| New customer | Start at this deal size; review after the first 3 invoices |

## Evidence
Backtest (leave-one-out on 21 customers with 8+ paid invoices, each predicted only from similar customers):
**17/21 classes exactly right (81%), 21/21 within one class**, average delay error about 8.5 days.
Always guessing the most common class scores 62%.

## Limitations
- Past-customer data is synthetic; the backtest shows the method works on data with these patterns, not real-world accuracy.
- Points, bands, limits, advance percentages and the 15-day minimum are rules of thumb; tune them to the business.
- Similar-customer predictions pull toward the middle, so a truly high-risk new customer can come out as Limited credit.
- Not financial advice.
