import { randomUUID } from 'node:crypto';

export const CUSTOMER_TYPES = ['Large company', 'Govt/PSU', 'SME manufacturer', 'Distributor', 'Trader/Retailer'];
const FULL = 'Full credit', LIMITED = 'Limited credit', ADVANCE = 'Advance only';
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = p * (sorted.length - 1), lo = Math.floor(at), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (at - lo) * (sorted[hi] - sorted[lo]);
};
const median = values => pct(values, .5);
const clamp = n => Math.max(0, Math.min(1, n));
const klass = score => score <= 30 ? FULL : score <= 55 ? LIMITED : ADVANCE;
const validNumber = (value, label, max = 1e12, min = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`Enter a valid ${label}.`), { status: 400 });
  return n;
};
const fmtDate = (date, days) => { const d = new Date(date); d.setUTCDate(d.getUTCDate() + Math.round(days)); return d.toISOString().slice(0, 10); };

export function validateRiskCustomers(items) {
  if (!Array.isArray(items) || items.length > 500) throw Object.assign(new Error('Customer list must contain at most 500 customers.'), { status: 400 });
  const ids = new Set();
  return items.map(raw => {
    const name = String(raw?.name || '').trim(), type = String(raw?.type || '');
    if (name.length < 2 || name.length > 100) throw Object.assign(new Error('Each customer needs a name.'), { status: 400 });
    if (!CUSTOMER_TYPES.includes(type)) throw Object.assign(new Error('Choose a valid customer type.'), { status: 400 });
    const id = String(raw.id || randomUUID()).slice(0, 80);
    if (ids.has(id)) throw Object.assign(new Error('Customer IDs must be unique.'), { status: 400 });
    ids.add(id);
    const list = (values, label, max, min = 0) => {
      if (!Array.isArray(values) || values.length > max) throw Object.assign(new Error(`${label} must be a list.`), { status: 400 });
      return values.map(value => {
        const n = validNumber(value, label, 730, min);
        if (!Number.isInteger(n)) throw Object.assign(new Error(`${label} values must be whole days.`), { status: 400 });
        return n;
      });
    };
    const owed = validNumber(raw.owed ?? 0, 'receivables'), overdue = validNumber(raw.overdue ?? 0, 'overdue receivables');
    const kept = validNumber(raw.promisesKept ?? 0, 'kept promise count', 100000);
    const broken = validNumber(raw.promisesBroken ?? 0, 'broken promise count', 100000);
    if (overdue > owed) throw Object.assign(new Error('Overdue receivables cannot exceed total receivables.'), { status: 400 });
    if (![kept, broken].every(Number.isInteger)) throw Object.assign(new Error('Promise counts must be whole numbers.'), { status: 400 });
    return {
      id, name, type, years: validNumber(raw.years ?? 0, 'years in business', 100),
      terms: validNumber(raw.terms ?? 30, 'credit terms', 365),
      avgOrder: validNumber(raw.avgOrder ?? 0, 'average order amount'),
      monthlyBilling: validNumber(raw.monthlyBilling ?? 0, 'monthly billing'),
      paidDelays: list(raw.paidDelays || [], 'Paid invoice delays', 1000, -90),
      overdueDays: list(raw.overdueDays || [], 'Overdue invoice ages', 500),
      promisesKept: kept, promisesBroken: broken, owed, overdue,
      ...(raw.fromInvoices ? { fromInvoices: Math.min(5000, Number(raw.fromInvoices) || 0) } : {}),
      ...(raw.profileMissing ? { profileMissing: true } : {})
    };
  });
}

function behaviour(c) {
  const delays = c.paidDelays, n = delays.length, odays = c.overdueDays;
  const typical = n ? median(delays) : null, bad = n ? pct(delays, .8) : null;
  const maxOverdue = odays.length ? Math.max(...odays) : 0;
  const overdueCount = odays.filter(day => day > 0).length;
  const veryLateRate = (delays.filter(day => day >= 45).length + odays.filter(day => day >= 45).length) / Math.max(1, n + overdueCount);
  const promises = c.promisesKept + c.promisesBroken;
  const brokenRate = promises >= 2 ? c.promisesBroken / promises : null;
  const recent = n >= 6 ? median(delays.slice(-4)) : null, slowing = recent != null && recent - typical >= 7;
  const effectiveTypical = slowing ? recent : typical;
  const effectiveBad = bad == null ? null : bad + (slowing ? recent - typical : 0);
  const points = {};
  if (n) {
    points.lateness = 25 * clamp(effectiveTypical / 45);
    points.unpredictability = 15 * clamp((effectiveBad - effectiveTypical) / 30);
  }
  points.veryLate = 20 * veryLateRate;
  points.brokenPromises = 15 * (brokenRate ?? .3);
  points.overdueNow = 15 * clamp(maxOverdue / 60);
  points.slowingDown = slowing ? 10 : 0;
  const ownScore = n ? Object.values(points).reduce((a, b) => a + b, 0) : null;
  const reasons = [];
  if (n) reasons.push(effectiveTypical > 2 ? `usually pays ${Math.round(effectiveTypical)} days late` : 'usually pays on time');
  if (n && effectiveBad - effectiveTypical >= 15) reasons.push(`payment timing varies; slower case is about ${Math.round(effectiveBad)} days late`);
  if (veryLateRate >= .2) reasons.push(`${Math.round(veryLateRate * 100)}% of entered invoices were 45+ days late`);
  if (brokenRate != null && brokenRate >= .4) reasons.push(`broke ${c.promisesBroken} of ${promises} payment promises`);
  if (maxOverdue > 15) reasons.push(`an invoice is ${maxOverdue} days overdue`);
  if (slowing) reasons.push(`recent payments are about ${Math.round(recent - typical)} days later than before`);
  return {
    n, typical: effectiveTypical, bad: effectiveBad, veryLateRate, brokenRate, maxOverdue,
    slowing, slowingBy: slowing ? recent - typical : 0,
    unpredictable: Boolean(n && effectiveBad - effectiveTypical >= 15),
    ownScore, points, reasons, owed: c.owed, overdue: c.overdue,
    avgOrder: c.avgOrder || null, monthlyBilling: c.monthlyBilling || null,
    confidence: n >= 8 ? 'high' : n >= 4 ? 'medium' : 'low'
  };
}

const profile = c => ({ type: c.type, years: c.years, order: c.avgOrder || 100000, terms: c.terms });
function distance(a, b) {
  return 3 * (a.type !== b.type)
    + 1.5 * Math.abs(Math.log1p(a.years) - Math.log1p(b.years)) / Math.log(31)
    + Math.abs(Math.log(Math.max(a.order, 1)) - Math.log(Math.max(b.order, 1))) / Math.log(100)
    + Math.abs(a.terms - b.terms) / 60;
}
const riskClass = score => score <= 30 ? FULL : score <= 55 ? LIMITED : ADVANCE;

function buildModel(customers) {
  const records = customers.map(c => ({ ...c, b: behaviour(c) }));
  const reference = records.filter(c => c.b.n >= 5 && c.b.ownScore != null);
  function similar(prof, excludeId) {
    const peers = reference.filter(c => c.id !== excludeId).map(c => ({ c, d: distance(prof, profile(c)) })).sort((a, b) => a.d - b.d).slice(0, 5);
    if (!peers.length) return null;
    const weights = peers.map(({ d }) => 1 / (d + .1)), total = weights.reduce((a, b) => a + b, 0);
    const avg = key => peers.reduce((sum, peer, i) => sum + weights[i] * peer.c.b[key], 0) / total;
    const classes = peers.map(peer => riskClass(peer.c.b.ownScore));
    const agreement = Math.max(...[...new Set(classes)].map(value => classes.filter(x => x === value).length)) / classes.length;
    return { score: avg('ownScore'), typical: avg('typical'), bad: avg('bad'), agreement,
      neighbours: peers.map(({ c, d }) => ({ name: c.name, type: c.type, similarity: Math.round(100 / (1 + d)), score: c.b.ownScore, decision: riskClass(c.b.ownScore) })) };
  }
  for (const c of records) {
    const b = c.b, n = b.n, w = n >= 8 ? 1 : n / (n + 5), peers = w < 1 ? similar(profile(c), c.id) : null;
    if (w < 1 && peers) {
      b.score = n ? w * b.ownScore + (1 - w) * peers.score : peers.score + b.points.overdueNow;
      b.typicalPred = n ? w * b.typical + (1 - w) * peers.typical : peers.typical;
      b.badPred = n ? w * b.bad + (1 - w) * peers.bad : peers.bad;
      b.similar = peers;
      b.reasons.push(`limited history (${n} paid invoices): blended with ${peers.neighbours.length} comparable customers`);
    } else if (n) { b.score = b.ownScore; b.typicalPred = b.typical; b.badPred = b.bad; b.similar = null; }
    else { b.score = null; b.typicalPred = null; b.badPred = null; b.similar = null; b.reasons.push('not enough payment history in this workspace to estimate a score'); }
    b.score = b.score == null ? null : Math.max(0, Math.min(100, b.score));
    b.decision = b.score == null ? 'Not enough history' : riskClass(b.score);
  }
  return { records, similar };
}

export function riskOverview(customers, today = new Date()) {
  const { records } = buildModel(customers);
  return { today: today.toISOString().slice(0, 10), types: CUSTOMER_TYPES, customers: records.map(c => ({
    id: c.id, name: c.name, type: c.type, years: c.years, terms: c.terms,
    decision: c.b.decision, score: c.b.score == null ? null : Math.round(c.b.score),
    typical_delay: c.b.typicalPred == null ? null : Math.round(c.b.typicalPred),
    bad_delay: c.b.badPred == null ? null : Math.round(c.b.badPred),
    paid_invoices: c.b.n, confidence: c.b.confidence, owed: c.b.owed, overdue: c.b.overdue,
    avg_order: c.b.avgOrder, reasons: c.b.reasons, from_invoices: c.fromInvoices || 0, profile_missing: !!c.profileMissing
  })) };
}

function actionPlan(cls, amount, terms, typical, limit, owed, overdue, today, b, isNew) {
  const typ = Math.max(0, Math.round(typical ?? 0)), exposure = owed + amount, room = Math.max(0, limit - owed);
  const actions = []; let newTerms = terms, advance = 0;
  const broken = (b?.brokenRate ?? 0) >= .4;
  if (overdue > 0 && cls !== FULL) actions.push((b?.maxOverdue ?? 0) > 7
    ? `Collect ${inr(overdue)} already overdue (oldest ${b?.maxOverdue ?? 0} days) before dispatching this order.`
    : `Remind them about ${inr(overdue)} that just became due when confirming.`);
  if (cls === FULL) {
    actions.push(`Give the requested ${terms} days credit.`);
    if (exposure > limit) actions.push(`Total credit would be ${inr(exposure)} against an estimated ${inr(limit)} limit. Consider splitting delivery or collecting an open invoice first.`);
    if (typ >= 15) actions.push(`They usually pay about ${typ} days late; consider an early payment discount if cash is needed sooner.`);
  } else if (cls === LIMITED && room <= 0) {
    advance = amount; newTerms = 0;
    actions.push('Current receivables are above the estimated credit limit; consider advance payment or collect open invoices before dispatch.');
    if (broken) actions.push(`Avoid relying only on verbal promises; ${Math.round(b.brokenRate * 100)}% of entered promises were broken.`);
  } else if (cls === LIMITED) {
    const options = [15, 30, 45, 60].filter(value => value <= terms - typ);
    newTerms = Math.min(Math.max(...(options.length ? options : [15])), terms);
    actions.push(newTerms < terms ? `Consider ${newTerms} days credit instead of ${terms}; expected collection moves from about day ${terms + typ} to day ${newTerms + typ}.` : `Keep ${terms} days credit and plan for collection around day ${terms + typ}.`);
    if (exposure > limit) {
      advance = Math.round((amount - room) / 1000) * 1000;
      actions.push(`Keep about ${inr(amount - advance)} on credit and take ${inr(advance)} in advance to stay near the estimated limit.`);
    }
    if (broken) actions.push('Consider a dated payment commitment for the credit portion because past promises were often broken.');
    else if (b?.unpredictable) actions.push('Consider splitting delivery and releasing the second part after the first invoice is paid; payment timing varies widely.');
    else if (!advance) { advance = Math.round(amount * .25 / 1000) * 1000; actions.push(`Consider a ${inr(advance)} advance (25%) before dispatch.`); }
    actions.push('Send a reminder before the due date and follow up on the due date.');
  } else if (cls === ADVANCE) {
    const all = (b?.veryLateRate ?? 0) >= .3 || (b?.maxOverdue ?? 0) >= 60;
    const share = all ? 1 : .5; advance = Math.round(amount * share / 1000) * 1000; newTerms = all ? 0 : Math.min(terms, 15);
    actions.push(`Consider taking ${inr(advance)} (${share * 100}%) before dispatch.`);
    if (!all) actions.push(`For the remaining ${inr(amount - advance)}, agree a dated payment at ${newTerms} days.`);
    actions.push('Review terms after three invoices are paid on time.');
  } else {
    advance = amount; newTerms = 0;
    actions.push('There is not enough comparable payment history in this workspace to estimate credit risk. Consider an advance for the first order, then review after payment history is available.');
  }
  if (b?.slowing) actions.push(`Recent payment delays increased by about ${Math.round(b.slowingBy)} days; check in before increasing credit.`);
  if (isNew && cls !== 'Not enough history') actions.push('This new-customer estimate uses the most similar customers with payment history in this workspace.');
  const askedDays = terms + Math.max(0, typical ?? 0), planDays = newTerms + (newTerms ? Math.max(0, typical ?? 0) : 0);
  return { actions, terms: newTerms, advance, on_credit: Math.max(0, amount - advance),
    arrival_asked: fmtDate(today, askedDays), arrival_planned: fmtDate(today, planDays), arrival_days: planDays };
}
const inr = n => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function assessRiskDeal(customers, body, today = new Date()) {
  const { records, similar: findSimilar } = buildModel(customers);
  const amount = validNumber(body?.amount, 'deal amount', 1e12, 1);
  const terms = validNumber(body?.terms ?? 30, 'credit terms', 365);
  if (!Number.isInteger(terms)) throw Object.assign(new Error('Credit terms must be whole days.'), { status: 400 });
  let customer, b, cls, score, typical, bad, owed, overdue, monthly, similar, agreement = 0, isNew = false;
  if (body?.customerId) {
    customer = records.find(c => c.id === String(body.customerId));
    if (!customer) throw Object.assign(new Error('Customer not found in this workspace. Refresh and try again.'), { status: 404 });
    b = customer.b; cls = b.decision; score = b.score; typical = b.typicalPred; bad = b.badPred;
    owed = b.owed; overdue = b.overdue; monthly = b.monthlyBilling || b.avgOrder || amount; similar = b.similar?.neighbours || null;
  } else if (body?.new) {
    const p = body.new, type = String(p.type || '');
    if (!CUSTOMER_TYPES.includes(type)) throw Object.assign(new Error('Choose a valid customer type.'), { status: 400 });
    const years = validNumber(p.years ?? 0, 'years in business', 100);
    const order = validNumber(p.order ?? amount, 'typical order amount', 1e12, 1);
    const profile = { type, years, order, terms };
    const estimate = findSimilar(profile);
    customer = { name: String(p.name || `New ${type} customer`), type };
    owed = 0; overdue = 0; monthly = order; isNew = true;
    if (estimate) { score = estimate.score; cls = riskClass(score); typical = estimate.typical; bad = estimate.bad; similar = estimate.neighbours; agreement = estimate.agreement; }
    else { score = null; cls = 'Not enough history'; typical = null; bad = null; similar = []; }
    b = null;
  } else throw Object.assign(new Error('Choose an existing customer or enter a new customer profile.'), { status: 400 });
  const factor = cls === FULL ? 1.5 : cls === LIMITED ? 1 : .5;
  const limit = isNew ? factor * monthly : factor * monthly * Math.max(1, (terms + Math.max(0, typical ?? 0)) / 30);
  const plan = actionPlan(cls, amount, terms, typical, limit, owed, overdue, today, b, isNew);
  return {
    who: customer.name, decision: cls, score: score == null ? null : Math.round(score),
    confidence: isNew ? (agreement >= .8 ? 'high' : agreement >= .6 ? 'medium' : 'low') : b.confidence,
    typical_delay: typical == null ? null : Math.round(typical), bad_delay: bad == null ? null : Math.round(bad),
    due: fmtDate(today, terms), expected: fmtDate(today, terms + Math.max(0, typical ?? 0)),
    bad_case: fmtDate(today, terms + Math.max(0, bad ?? typical ?? 0)),
    owed_now: owed, overdue, exposure: owed + amount, limit: Math.round(limit), actions: plan.actions,
    plan: { terms: plan.terms, advance: Math.round(plan.advance), on_credit: Math.round(plan.on_credit),
      arrival: plan.arrival_planned, arrival_if_asked: plan.arrival_asked, arrival_days: plan.arrival_days },
    similar
  };
}


// ---------------------------------------------------------------------------
// Payment history from ClearRun invoices.
// Invoices are matched to a customer by name (ignoring case and spacing). Paid invoices add
// "days late" (paid date minus due date); unpaid invoices past their due date add "days overdue"
// and count towards what the customer owes. History typed in by hand is kept and treated as
// older history, so the invoice history is the most recent part (it drives "slowing down").
const DAY_MS = 86_400_000;
const isoDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? Date.parse(value + 'T00:00:00Z') : NaN;
export const customerKey = name => String(name || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();

export function withInvoiceHistory(customers, invoices = [], today = new Date().toISOString().slice(0, 10)) {
  const now = isoDay(today);
  const byName = new Map();
  for (const inv of Array.isArray(invoices) ? invoices.slice(0, 2000) : []) {
    if (!inv || !(Number(inv.amount) > 0) || Number.isNaN(isoDay(inv.dueDate))) continue;
    const key = customerKey(inv.customer);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) || []), inv]);
  }
  const out = customers.map(c => ({ ...c, fromInvoices: 0 }));
  const known = new Set(out.map(c => customerKey(c.name)));
  // Customers that only exist as invoices are added with a default profile the user can edit.
  for (const [key, list] of byName) {
    if (known.has(key)) continue;
    out.push({ id: 'inv:' + key.slice(0, 70), name: String(list[0].customer).trim().slice(0, 100), type: 'SME manufacturer', years: 3, terms: 30,
      avgOrder: 0, monthlyBilling: 0, paidDelays: [], overdueDays: [], promisesKept: 0, promisesBroken: 0, owed: 0, overdue: 0,
      fromInvoices: 0, profileMissing: true });
  }
  for (const c of out) {
    const list = (byName.get(customerKey(c.name)) || []).sort((a, b) => isoDay(a.dueDate) - isoDay(b.dueDate));
    if (!list.length) continue;
    const paid = list.filter(inv => inv.status === 'paid' && !Number.isNaN(isoDay(inv.paidDate)));
    const open = list.filter(inv => inv.status !== 'paid');
    c.paidDelays = [...c.paidDelays, ...paid.map(inv => Math.max(-90, Math.min(730, Math.round((isoDay(inv.paidDate) - isoDay(inv.dueDate)) / DAY_MS))))];
    const late = open.filter(inv => isoDay(inv.dueDate) < now);
    c.overdueDays = [...c.overdueDays, ...late.map(inv => Math.min(730, Math.round((now - isoDay(inv.dueDate)) / DAY_MS)))];
    c.owed += open.reduce((sum, inv) => sum + Number(inv.amount), 0);
    c.overdue += late.reduce((sum, inv) => sum + Number(inv.amount), 0);
    if (!c.avgOrder) c.avgOrder = Math.round(list.reduce((sum, inv) => sum + Number(inv.amount), 0) / list.length);
    if (!c.monthlyBilling) {
      const recent = list.filter(inv => now - isoDay(inv.issueDate || inv.dueDate) <= 180 * DAY_MS);
      c.monthlyBilling = Math.round(recent.reduce((sum, inv) => sum + Number(inv.amount), 0) / 6);
    }
    c.fromInvoices = list.length;
  }
  return out;
}
