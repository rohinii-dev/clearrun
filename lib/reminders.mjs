// Payment reminder ladder: gentle -> formal -> legal notice.
// Pure functions only (no network) so they can be tested and used for previews.
//
// Stage keys are unchanged from earlier versions so existing reminder_log rows still match.

export const TIERS = {
  gentle: { label: 'Gentle reminder', tone: 'Friendly and short. Assumes it is an oversight.' },
  formal: { label: 'Formal reminder', tone: 'Firm and businesslike. States the overdue amount and asks for a payment date.' },
  legal: { label: 'Legal notice', tone: 'Formal demand notice with a 15 day deadline before recovery action.' }
};

export const STAGES = [
  { key: 'before_7', offset: -7, tier: 'gentle', label: '7 days before the due date' },
  { key: 'due_0', offset: 0, tier: 'gentle', label: 'on the due date' },
  { key: 'over_7', offset: 7, tier: 'formal', label: '7 days overdue' },
  { key: 'over_15', offset: 15, tier: 'formal', label: '15 days overdue' },
  { key: 'over_30', offset: 30, tier: 'legal', label: '30 days overdue' }
];

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(value) {
  if (!ISO.test(String(value || ''))) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) ? time : null;
}

export function todayIso(now = new Date()) {
  // Business day in India (UTC+05:30), so a 09:00 IST cron uses the right date.
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = parseDay(fromIso), b = parseDay(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY);
}

export function addDays(iso, days) {
  const time = parseDay(iso);
  return time === null ? null : new Date(time + days * DAY).toISOString().slice(0, 10);
}

// Days relative to the due date: negative = not due yet, positive = overdue.
export function daysFromDue(invoice, today) {
  return daysBetween(invoice.dueDate, today);
}

// The legal notice is only ever sent automatically when the user ticked it for this invoice.
export const legalAllowed = invoice => invoice?.reminders?.legal === true;

// Latest stage that has been reached and not yet sent. One email at most per run.
export function nextStage(invoice, today, sentKeys = [], { allowLegal = legalAllowed(invoice) } = {}) {
  const offset = daysFromDue(invoice, today);
  if (offset === null) return null;
  // Never go backwards: once a later stage was sent, earlier ones are skipped for good.
  const lastSent = Math.max(-Infinity, ...STAGES.filter(stage => sentKeys.includes(stage.key)).map(stage => stage.offset));
  const reached = STAGES.filter(stage => stage.offset <= offset && stage.offset > lastSent && (allowLegal || stage.tier !== 'legal'));
  return reached.length ? reached[reached.length - 1] : null;
}

// MSMED Act, section 16: interest is payable from the "appointed day" at three times the
// RBI Bank Rate, compounded with monthly rests. The appointed day cannot be later than
// 45 days after acceptance of goods (assumes a written agreement; 15 days without one).
export function legalDueDate(invoice) {
  const issue = invoice.issueDate, due = invoice.dueDate;
  if (!parseDay(due)) return null;
  const cap = parseDay(issue) ? addDays(issue, 45) : null;
  return cap && parseDay(due) > parseDay(cap) ? cap : due;
}

export function msmedInterest(invoice, bankRatePercent, today) {
  const rate = Number(bankRatePercent);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 30) return null;
  const legal = legalDueDate(invoice);
  const late = legal ? daysBetween(legal, today) : null;
  if (late === null || late <= 0) return { legalDue: legal, lateDays: Math.max(0, late || 0), interest: 0, annualRate: rate * 3 };
  const monthly = (rate * 3) / 100 / 12;
  const interest = Number(invoice.amount) * (Math.pow(1 + monthly, late / 30.4375) - 1);
  return { legalDue: legal, lateDays: late, interest: Math.round(interest), annualRate: Math.round(rate * 3 * 100) / 100 };
}

const inr = n => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = iso => { const t = parseDay(iso); return t === null ? String(iso || '') : new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const para = text => `<p style="margin:0 0 12px">${esc(text)}</p>`;

function context({ invoice, settings = {}, today }) {
  const business = String(settings.businessName || 'our business').slice(0, 80);
  const customer = String(invoice.customer || 'Sir/Madam').slice(0, 80);
  const ref = invoice.number ? `invoice no. ${String(invoice.number).slice(0, 40)}` : 'our invoice';
  const Ref = ref[0].toUpperCase() + ref.slice(1);
  const offset = daysFromDue(invoice, today);
  const late = Math.max(offset || 0, 0);
  const msme = settings.udyam ? msmedInterest(invoice, settings.bankRate, today) : null;
  return { business, customer, ref, Ref, offset, late, msme, amount: inr(invoice.amount), due: niceDate(invoice.dueDate), issued: niceDate(invoice.issueDate) };
}

// ---------- the three tiers ----------
function gentle(stage, c) {
  const before = stage.offset < 0;
  return {
    subject: before ? `Friendly reminder: ${c.ref} due on ${c.due}` : `${c.Ref} is due today`,
    body: [
      before
        ? `I hope you are well. This is a friendly reminder that ${c.ref} for ${c.amount} is due on ${c.due}.`
        : `I hope you are well. ${c.Ref} for ${c.amount} falls due today, ${c.due}.`,
      before ? 'If payment is already scheduled, please ignore this note. If you need a copy of the invoice, just reply to this email.'
        : 'If you have already arranged payment, thank you, and please ignore this note. Otherwise we would be grateful if you could process it today.'
    ]
  };
}

function formal(stage, c, settings) {
  const second = stage.offset >= 15;
  const body = [
    second
      ? `We wrote to you earlier about ${c.ref} for ${c.amount}, which was due on ${c.due}. It remains unpaid and is now ${c.late} days overdue.`
      : `Our records show that ${c.ref} for ${c.amount}, due on ${c.due}, is now ${c.late} days overdue.`,
    'Please arrange payment within 7 days, or reply with the date on which payment will be made. If there is any dispute about the invoice, please tell us now so it can be resolved.'
  ];
  if (second && c.msme && c.msme.interest > 0) {
    body.push(`As a registered micro or small enterprise (Udyam ${String(settings.udyam).slice(0, 40)}), we are entitled under Section 16 of the MSMED Act, 2006 to compound interest on delayed payments at three times the RBI Bank Rate from ${niceDate(c.msme.legalDue)}. As of today this is approximately ${inr(c.msme.interest)} and it increases until payment is received.`);
  }
  if (second) body.push('If payment is not received, we will have to send a formal notice of demand.');
  return { subject: second ? `Second reminder: ${c.ref} overdue by ${c.late} days` : `Overdue: ${c.ref} (${c.amount})`, body };
}

export function legalNoticeParts({ invoice, settings = {}, today, sentLog = [] }) {
  const c = context({ invoice, settings, today });
  const refNo = `CR/${String(invoice.number || invoice.id || 'INV').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20)}/${String(today).replace(/-/g, '')}`;
  const earlier = sentLog.filter(row => row && row.status === 'sent' && row.stage !== 'over_30').map(row => niceDate(String(row.sent_at || '').slice(0, 10))).filter(Boolean);
  const deadline = addDays(today, 15);
  const paras = [
    `This notice concerns ${c.ref} dated ${c.issued || 'as per our records'} for ${c.amount}, raised by ${c.business} on ${c.customer} for goods and/or services supplied. Payment fell due on ${c.due}.`,
    earlier.length
      ? `Despite our reminders dated ${earlier.join(', ')}, the amount remains unpaid and is now ${c.late} days overdue.`
      : `Despite our earlier reminders, the amount remains unpaid and is now ${c.late} days overdue.`,
    `You are hereby called upon to pay the outstanding amount of ${c.amount}${c.msme && c.msme.interest > 0 ? `, together with interest under Section 16 of the MSMED Act, 2006 (approximately ${inr(c.msme.interest)} as of the date of this notice)` : ''}, within 15 days of receiving this notice, that is on or before ${niceDate(deadline)}.`,
    c.msme
      ? `${c.business} is a micro or small enterprise registered under Udyam number ${String(settings.udyam).slice(0, 40)}. If payment is not received by that date, we intend to refer the matter to the Micro and Small Enterprises Facilitation Council under Section 18 of the MSMED Act, 2006, and to take any other recovery action available to us, including claims for interest and costs, without further notice.`
      : `If payment is not received by that date, we will be constrained to initiate appropriate legal proceedings for recovery of the amount, together with interest and costs, without further notice to you.`,
    'If you have already made this payment, or you dispute the amount, please contact us in writing immediately with the details.',
    'This notice is issued without prejudice to all our rights and remedies.'
  ];
  return { c, refNo, deadline, paras };
}

function legal(stage, c, settings, ctx) {
  const n = legalNoticeParts(ctx);
  return {
    subject: `Legal notice for payment: ${c.ref} – ${c.amount} outstanding`,
    body: [`Ref: ${n.refNo}`, `Date: ${niceDate(ctx.today)}`, `Subject: Notice of demand for payment of ${c.amount} against ${c.ref}`, ...n.paras]
  };
}

export function buildEmail({ stage, invoice, settings = {}, today, sentLog = [] }) {
  const c = context({ invoice, settings, today });
  const parts = stage.tier === 'gentle' ? gentle(stage, c)
    : stage.tier === 'formal' ? formal(stage, c, settings)
      : legal(stage, c, settings, { invoice, settings, today, sentLog });
  const contact = settings.contactEmail ? String(settings.contactEmail).slice(0, 120) : '';
  const signoff = stage.tier === 'legal' ? ['For and on behalf of', c.business, ...(contact ? [contact] : [])] : ['Regards,', c.business];
  const greeting = stage.tier === 'legal' ? `To ${c.customer},` : `Dear ${c.customer},`;
  const text = [greeting, '', ...parts.body.flatMap(line => [line, '']), ...signoff].join('\n');
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#1b2a21;max-width:600px">${para(greeting)}${parts.body.map(para).join('')}<p style="margin:16px 0 0">${signoff.map(esc).join('<br>')}</p></div>`;
  return { subject: parts.subject, text, html, tier: stage.tier, tierLabel: TIERS[stage.tier].label, stage: stage.key, label: stage.label };
}

// Every email in the ladder, with the date it would go out, for the preview screen.
export function ladderPreview({ invoice, settings = {}, today, sentLog = [] }) {
  const sent = sentLog.filter(row => row && row.invoice_id === invoice.id);
  const enabled = invoice?.reminders?.enabled === true;
  const sentKeys = sent.map(row => row.stage);
  const goesNext = nextStage(invoice, today, sentKeys); // what the next daily run sends
  const lastSentOffset = Math.max(-Infinity, ...STAGES.filter(s => sentKeys.includes(s.key)).map(s => s.offset));
  const offsetNow = daysFromDue(invoice, today);
  return STAGES.map(stage => {
    const sendOn = addDays(invoice.dueDate, stage.offset);
    // Show each email as it would read on its send date (overdue days, interest).
    const asOf = sendOn && parseDay(sendOn) > parseDay(today) ? sendOn : today;
    const email = buildEmail({ stage, invoice, settings, today: asOf, sentLog: sent });
    const row = sent.find(r => r.stage === stage.key);
    let status;
    if (row) status = row.status === 'sent' ? 'sent' : 'sending';
    else if (stage.tier === 'legal' && !legalAllowed(invoice)) status = 'needs approval';
    else if (!enabled) status = 'planned';
    else if (goesNext && goesNext.key === stage.key) status = 'sends next';
    else if (stage.offset <= offsetNow || stage.offset < lastSentOffset) status = 'skipped'; // a later step already applies
    else status = 'scheduled';
    return { ...email, sendOn, status };
  });
}

// Printable legal notice (open in a window, then Print -> Save as PDF, or send by registered post).
export function legalNoticeHtml({ invoice, settings = {}, today, sentLog = [] }) {
  const { c, refNo, paras } = legalNoticeParts({ invoice, settings, today, sentLog });
  const gstin = invoice.gstin ? `<br>GSTIN: ${esc(invoice.gstin)}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Legal notice ${esc(refNo)}</title><style>
body{font:15px/1.65 Georgia,'Times New Roman',serif;color:#111;max-width:720px;margin:40px auto;padding:0 28px}
h1{font-size:18px;text-align:center;letter-spacing:.06em;margin:28px 0 22px;text-decoration:underline}
.meta{display:flex;justify-content:space-between;font-size:14px}.sign{margin-top:40px}p{margin:0 0 14px;text-align:justify}
.note{margin-top:48px;font:12px/1.5 Arial,sans-serif;color:#666;border-top:1px solid #ccc;padding-top:10px}
@media print{.note{display:none}body{margin:0 auto}}</style></head><body>
<div><strong>${esc(c.business)}</strong>${settings.contactEmail ? `<br>${esc(settings.contactEmail)}` : ''}${settings.udyam ? `<br>Udyam: ${esc(settings.udyam)}` : ''}</div>
<div class="meta" style="margin-top:22px"><span>Ref: ${esc(refNo)}</span><span>Date: ${esc(niceDate(today))}</span></div>
<p style="margin-top:18px">To,<br><strong>${esc(c.customer)}</strong>${gstin}${invoice.email ? `<br>${esc(invoice.email)}` : ''}</p>
<h1>NOTICE OF DEMAND FOR PAYMENT</h1>
<p><strong>Subject: Demand for payment of ${esc(c.amount)} against ${esc(c.ref)}</strong></p>
<p>Dear Sir/Madam,</p>
${paras.map(p => `<p>${esc(p)}</p>`).join('')}
<div class="sign">For and on behalf of<br><strong>${esc(c.business)}</strong><br><br><br>Authorised signatory</div>
<div class="note">Generated by ClearRun from your invoice details. This is a template, not legal advice. Check every detail, and consider having an advocate review or issue the notice for disputes or large amounts.</div>
</body></html>`;
}

export function validInvoiceForReminder(invoice) {
  return !!invoice && invoice.status !== 'paid' && invoice.reminders?.enabled === true
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(invoice.email || ''))
    && Number(invoice.amount) > 0 && parseDay(invoice.dueDate) !== null;
}
