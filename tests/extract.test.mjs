import assert from 'node:assert/strict';
import { parseAmount, parseAmountInWords, parseInvoiceDate, parseTermsDays, validGstin, evaluateReading, extractInvoice } from '../lib/invoice-extract.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; };
t('amounts', () => {
  assert.equal(parseAmount('₹ 1,23,456.50'), 123456.5);
  assert.equal(parseAmount('Rs. 45,000/-'), 45000);
  assert.equal(parseAmount('INR 2,36,000.00'), 236000);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('abc'), null);
});
t('amount in words', () => {
  assert.equal(parseAmountInWords('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'), 123456);
  assert.equal(parseAmountInWords('INR Two Lakh Thirty Six Thousand Only'), 236000);
  assert.equal(parseAmountInWords('Rupees Five Thousand and Fifty Paise Only'), 5000.5);
  assert.equal(parseAmountInWords('Indian Rupee One Crore Five Lakh Only'), 10500000);
  assert.equal(parseAmountInWords('Rupees Nine Hundred Ninety Nine Only'), 999);
  assert.equal(parseAmountInWords('Rupees Forty-Five Thousand Only'), 45000);
  assert.equal(parseAmountInWords('gibberish words here'), null);
});
t('dates', () => {
  assert.deepEqual(parseInvoiceDate('05/10/2026'), { date: '2026-10-05', ambiguous: true });
  assert.deepEqual(parseInvoiceDate('25/10/2026'), { date: '2026-10-25', ambiguous: false });
  assert.deepEqual(parseInvoiceDate('10/25/2026'), { date: '2026-10-25', ambiguous: false });
  assert.equal(parseInvoiceDate('12-Mar-26').date, '2026-03-12');
  assert.equal(parseInvoiceDate('3rd September 2026').date, '2026-09-03');
  assert.equal(parseInvoiceDate('Sept 3, 2026').date, '2026-09-03');
  assert.equal(parseInvoiceDate('2026-11-01').date, '2026-11-01');
  assert.equal(parseInvoiceDate('31/02/2026').date, '');
  assert.equal(parseInvoiceDate('12.03.2026').date, '2026-03-12');
});
t('terms', () => { assert.equal(parseTermsDays('Net 30'), 30); assert.equal(parseTermsDays('Payment within 45 days'), 45); assert.equal(parseTermsDays('Due on receipt'), 0); });
t('gstin checksum', () => { assert.equal(validGstin('27AAPFU0939F1ZV'), true); assert.equal(validGstin('27AAPFU0939F1ZX'), false); assert.equal(validGstin('29AAGCB7383J1Z4'), true); });
const good = { invoiceNumber: 'INV-1024', customerName: 'Apex Auto Pvt Ltd', customerEmail: 'Accounts@Apex.in', buyerGstin: '29AAGCB7383J1Z4', sellerName: 'Sri Tools', sellerGstin: '27AAPFU0939F1ZV',
  invoiceDateText: '05/10/2026', dueDateText: null, paymentTermsText: 'Net 30', totalAmountText: '₹2,36,000.00', amountInWords: 'Rupees Two Lakh Thirty Six Thousand Only', subtotalText: '2,00,000.00', taxTotalText: '36,000.00',
  confidence: { invoiceNumber: 'high', customerName: 'high', totalAmount: 'high', invoiceDate: 'high', dueDate: 'low' } };
t('clean invoice evaluates fully', () => {
  const r = evaluateReading(good, '2026-10-25');
  assert.deepEqual(r.fields, { number: 'INV-1024', customer: 'Apex Auto Pvt Ltd', email: 'accounts@apex.in', gstin: '29AAGCB7383J1Z4', issueDate: '2026-10-05', dueDate: '2026-11-04', amount: 236000 });
  assert.equal(r.issues.length, 0); assert.equal(r.confidence.totalAmount, 'high');
});
t('taxable value mistaken for total is caught', () => {
  const r = evaluateReading({ ...good, totalAmountText: '2,00,000.00' }, '2026-10-25');
  assert.ok(r.issues.some(i => /taxable|words/.test(i))); assert.equal(r.confidence.totalAmount, 'low');
});
t('buyer/seller swap caught', () => {
  const r = evaluateReading({ ...good, customerName: 'Sri Tools', buyerGstin: '27AAPFU0939F1ZV' }, '2026-10-25');
  assert.equal(r.fields.gstin, ''); assert.ok(r.issues.length >= 2);
});
// second pass: first reading wrong (taxable value), second right -> second wins
let calls = 0;
const fake = async (file, mime, extra) => { calls++; return calls === 1 ? { ...good, totalAmountText: '2,00,000' } : good; };
const out = await extractInvoice('x', 'image/jpeg', { call: fake, today: '2026-10-25' });
assert.equal(calls, 2); assert.equal(out.fields.amount, 236000); assert.equal(out.passes, 2); n++;
// clean first reading -> only one call
calls = 0; const out2 = await extractInvoice('x', 'image/jpeg', { call: async () => { calls++; return good; }, today: '2026-10-25' });
assert.equal(calls, 1); assert.equal(out2.passes, 1); assert.equal(out2.confidence.amount, 'high'); n++;
// second reading fails (network) -> first still returned
calls = 0; const out3 = await extractInvoice('x', 'image/jpeg', { call: async () => { if (++calls === 2) throw new Error('down'); return { ...good, totalAmountText: null, amountInWords: null }; }, today: '2026-10-25' });
assert.equal(out3.fields.amount, null); assert.ok(out3.warnings.some(w => /total amount/.test(w))); n++;
console.log(`extract tests: ${n} passed`);
