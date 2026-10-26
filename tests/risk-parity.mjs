// Builds one dataset, writes it as the Python model's CSVs and as the JS model's input,
// so `python customer_risk.py` and lib/customer-risk.mjs can be compared customer by customer.
import { writeFileSync, mkdirSync } from 'node:fs';
import { CUSTOMER_TYPES, validateRiskCustomers, riskOverview, assessRiskDeal } from '../lib/customer-risk.mjs';
const out = process.argv[2]; mkdirSync(out + '/data', { recursive: true });
let seed = 7; const rnd = () => (seed = (1103515245 * seed + 12345) % 2147483648) / 2147483648;
const today = '2026-10-25', T = Date.parse(today + 'T00:00:00Z'), day = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const custs = [], invs = [], profiles = [];
for (let id = 1; id <= 18; id++) {
  const type = CUSTOMER_TYPES[id % 5], years = 1 + Math.floor(rnd() * 25), terms = [15, 30, 45, 60][id % 4];
  const lateBase = Math.floor(rnd() * 40) - 3, spread = Math.floor(rnd() * 30), nInv = [0, 2, 4, 6, 9, 12][id % 6];
  const kept = Math.floor(rnd() * 6), broken = Math.floor(rnd() * 5);
  custs.push({ id, name: `Customer ${id}`, terms, kept, broken }); profiles.push({ id, type, years });
  for (let k = 0; k < nInv + 2; k++) {
    const invDate = T - (400 - k * 30 - id) * day, due = invDate + terms * day;
    const amount = 20000 + Math.round(rnd() * 400) * 1000;
    let delay = lateBase + Math.floor(rnd() * spread) + (id % 7 === 0 && k >= nInv - 3 ? 15 : 0);
    const paidT = due + delay * day;
    const isOpen = k >= nInv; // last two invoices stay open
    invs.push({ no: `I${id}-${k}`, customer_id: id, amount, invoice_date: iso(invDate), due_date: iso(isOpen ? T - (k === nInv ? (id * 3) % 70 : -10) * day : due), paid_date: isOpen ? '' : iso(Math.min(paidT, T - day)) });
  }
}
const csv = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n') + '\n';
writeFileSync(out + '/data/business.json', JSON.stringify({ today }));
writeFileSync(out + '/data/customer_profiles.csv', csv(profiles.map(p => ({ id: p.id, customer_type: p.type, years_in_business: p.years })), ['id', 'customer_type', 'years_in_business']));
writeFileSync(out + '/data/customers.csv', csv(custs.map(c => ({ id: c.id, name: c.name, credit_terms_days: c.terms, promises_kept: c.kept, promises_broken: c.broken })), ['id', 'name', 'credit_terms_days', 'promises_kept', 'promises_broken']));
writeFileSync(out + '/data/invoices.csv', csv(invs.map(i => ({ invoice_no: i.no, customer_id: i.customer_id, amount: i.amount, invoice_date: i.invoice_date, due_date: i.due_date, paid_date: i.paid_date })), ['invoice_no', 'customer_id', 'amount', 'invoice_date', 'due_date', 'paid_date']));
// Same data in the JS model's per-customer form (Python sorts by due date; delays in that order).
const js = custs.map(c => {
  const mine = invs.filter(i => i.customer_id === c.id).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const paid = mine.filter(i => i.paid_date), open = mine.filter(i => !i.paid_date);
  const recent = mine.filter(i => (T - Date.parse(i.invoice_date + 'T00:00:00Z')) / day <= 180);
  return { id: String(c.id), name: c.name, type: profiles[c.id - 1].type, years: profiles[c.id - 1].years, terms: c.terms,
    avgOrder: mine.reduce((s, i) => s + i.amount, 0) / mine.length, monthlyBilling: recent.reduce((s, i) => s + i.amount, 0) / 6,
    paidDelays: paid.map(i => Math.round((Date.parse(i.paid_date) - Date.parse(i.due_date)) / day)),
    overdueDays: open.filter(i => i.due_date < today).map(i => Math.round((T - Date.parse(i.due_date + 'T00:00:00Z')) / day)),
    promisesKept: c.kept, promisesBroken: c.broken, owed: open.reduce((s, i) => s + i.amount, 0), overdue: open.filter(i => i.due_date < today).reduce((s, i) => s + i.amount, 0) };
});
const ov = riskOverview(validateRiskCustomers(js), new Date(today));
writeFileSync(out + '/js.json', JSON.stringify(ov.customers.map(c => ({ name: c.name, score: c.score, decision: c.decision, typical: c.typical_delay }))));
// a deal for every customer and a new customer, to exercise action plans (incl. the old crash)
let deals = 0; for (const c of js) { assessRiskDeal(validateRiskCustomers(js), { customerId: c.id, amount: 150000, terms: 30 }, new Date(today)); deals++; }
for (const type of CUSTOMER_TYPES) for (const years of [0, 3, 20]) { assessRiskDeal(validateRiskCustomers(js), { new: { type, years, order: 120000 }, amount: 120000, terms: 30 }, new Date(today)); deals++; }
console.log('deals assessed without error:', deals);
