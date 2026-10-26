<script>
/* ---------- Invoice scanning + data import ----------
   Scan:   /api/invoice (Claude vision, if the server has an API key)  ->  otherwise Tesseract OCR in the browser
           (bundled in vendor/tesseract, CDN as backup)  ->  parseInvoiceText()  ->  review form  ->  forecast.
   Import: CSV / Excel  ->  cash flow entries (forecast)  or  customer payment history (Customer credit check). */
(function () {
  const $ = id => document.getElementById(id);
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => {
    y = +y; m = +m; d = +d; if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
    const dt = new Date(y, m - 1, d); if (dt.getMonth() !== m - 1) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  };
  const niceDate = s => { if (!s) return ''; const d = new Date(s + 'T00:00:00'); return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getFullYear(); };

  /* ------------------------------------------------------------------ dates (Indian day-first) */
  function parseDate(raw) {
    if (raw == null || raw === '') return null;
    if (raw instanceof Date && !isNaN(raw)) return iso(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
    const s = String(raw).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return iso(m[1], m[2], m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) {
      const a = +m[1], b = +m[2];
      return a > 12 || b <= 12 ? iso(m[3], b, a) : iso(m[3], a, b);           // day-first unless impossible
    }
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-.\/]+([A-Za-z]{3,9})[\s\-.,\/]+(\d{2,4})$/))) { const mo = MON[m[2].toLowerCase().slice(0, 4)] || MON[m[2].toLowerCase().slice(0, 3)]; return mo ? iso(m[3], mo, m[1]) : null; }
    if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-.]+(\d{2,4})$/))) { const mo = MON[m[1].toLowerCase().slice(0, 4)] || MON[m[1].toLowerCase().slice(0, 3)]; return mo ? iso(m[3], mo, m[2]) : null; }
    if (/^\d{5}$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }  // Excel serial
    return null;
  }
  const DATE_RE = /(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s\-.\/]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-.,\/]+\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-.]+\d{1,2}(?:st|nd|rd|th)?,?[\s\-.]+\d{2,4})/ig;
  const datesIn = line => (line.match(DATE_RE) || []).map(parseDate).filter(Boolean);

  /* ------------------------------------------------------------------ invoice text -> fields */
  function parseAmountToken(t) { const n = parseFloat(String(t).replace(/[,\s]/g, '')); return isFinite(n) ? n : null; }
  const MONEY_RE = /(?:₹|rs\.?|inr)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)/ig;
  function amountsIn(line) {
    const out = []; let m; MONEY_RE.lastIndex = 0;
    const cleaned = line.replace(DATE_RE, ' ').replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g, ' ');
    while ((m = MONEY_RE.exec(cleaned))) { const v = parseAmountToken(m[1]); if (v != null && v >= 1) out.push({ v, money: /[,.]/.test(m[1]) || /₹|rs|inr/i.test(m[0]) }); }
    return out;
  }

  function parseInvoiceText(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const f = { customer: null, invoice_no: null, invoice_date: null, due_date: null, amount: null, gstin: null, terms_days: null }, conf = {};

    // amount: the best-labelled total line; the largest figure on it
    const LABELS = [[/grand\s*total|total\s*payable|amount\s*payable|net\s*payable|balance\s*due|total\s*due|amount\s*due/i, 5],
      [/total\s*amount|invoice\s*total|net\s*amount|total\s*value|total\s*\(?inr|total\s*\(?rs|total\s*₹/i, 4], [/\btotal\b/i, 2]];
    const SKIP = /sub\s*-?\s*total|taxable|cgst|sgst|igst|\bgst\b|\btax\b|discount|qty|quantity|rate|hsn|round/i;
    let best = null;
    lines.forEach((ln, i) => {
      const lab = LABELS.find(([re]) => re.test(ln)); if (!lab) return;
      if (SKIP.test(ln) && lab[1] < 5) return;
      let nums = amountsIn(ln.replace(lab[0], ' '));
      if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]);
      if (!nums.length) return;
      const v = Math.max(...nums.map(n => n.v));
      if (!best || lab[1] > best.p || (lab[1] === best.p && v > best.v)) best = { v, p: lab[1] };
    });
    if (best) { f.amount = best.v; conf.amount = best.p >= 4 ? 'high' : 'medium'; }
    else {
      const all = lines.flatMap(amountsIn).filter(n => n.money);
      if (all.length) { f.amount = Math.max(...all.map(n => n.v)); conf.amount = 'low'; }
    }

    // invoice number
    for (const ln of lines) {
      const m = ln.match(/(?:invoice|inv|bill|tax\s*invoice)\s*(?:no\.?|number|num|#|id)\s*[:\-.#]?\s*([A-Z0-9][A-Z0-9\/\-_.]{1,30})/i);
      if (m && !/^date/i.test(m[1])) { f.invoice_no = m[1].replace(/[.,;:]+$/, ''); break; }
    }

    // dates: due date by label, invoice date by label, else first date found
    lines.forEach((ln, i) => {
      if (!f.due_date && /due\s*date|payment\s*due|due\s*on|due\s*by|pay\s*by|last\s*date/i.test(ln)) {
        const d = datesIn(ln)[0] || (lines[i + 1] ? datesIn(lines[i + 1])[0] : null); if (d) { f.due_date = d; conf.due_date = 'high'; }
      }
      if (!f.invoice_date && /invoice\s*date|bill\s*date|date\s*of\s*(issue|invoice)|\bdated\b|^date\b|\binv\.?\s*date/i.test(ln) && !/due/i.test(ln)) {
        const d = datesIn(ln)[0] || (lines[i + 1] ? datesIn(lines[i + 1])[0] : null); if (d) f.invoice_date = d;
      }
    });
    if (!f.invoice_date) { const d = lines.flatMap(datesIn).find(x => x !== f.due_date); if (d) f.invoice_date = d; }

    // payment terms
    for (const ln of lines) {
      const m = ln.match(/(?:net|within|terms?\s*[:\-]?)\s*(\d{1,3})\s*days?/i) || ln.match(/(\d{1,3})\s*days?\s*(?:credit|net|from|of)/i);
      if (m) { f.terms_days = +m[1]; break; }
    }
    if (!f.due_date && f.invoice_date && f.terms_days != null) { f.due_date = crAddDaysISO(f.invoice_date, f.terms_days); conf.due_date = 'medium'; }

    // GSTIN (prefer the one after the buyer heading)
    const buyerIdx = lines.findIndex(ln => /bill(?:ed)?\s*to|buyer|customer\s*(?:name|details)?\s*[:\-]|sold\s*to|ship(?:ped)?\s*to|consignee|client|\bm\/s\b/i.test(ln));
    const gst = [], GST_RE = /\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g;
    // OCR often swaps look-alike characters; fix them by position (2 digits, 5 letters, 4 digits, letter, code, Z, check)
    const TO_D = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', E: '6', T: '7', A: '4' }, TO_L = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 4: 'A', 7: 'T' };
    const fixGst = t => t.split('').map((ch, k) => (k < 2 || (k >= 7 && k <= 10)) ? (TO_D[ch] || ch) : ((k >= 2 && k <= 6) || k === 11) ? (TO_L[ch] || ch) : k === 13 && ch === '2' ? 'Z' : ch).join('');
    lines.forEach((ln, i) => {
      const up = ln.toUpperCase().replace(/\s/g, ''); let found = up.match(GST_RE) || [];
      if (!found.length && /GST/.test(up)) { const m = up.replace(/.*GST(?:IN|NO|NUMBER)?[:.\-#]*/, '').match(/^[0-9A-Z]{15}/); if (m && GST_RE.test(fixGst(m[0]))) found = [fixGst(m[0])]; GST_RE.lastIndex = 0; }
      found.forEach(g => gst.push({ g, i }));
    });
    if (gst.length) f.gstin = ((buyerIdx >= 0 && gst.find(x => x.i >= buyerIdx)) || gst[gst.length - 1]).g;

    // customer: text after the buyer heading (same line after ":" or the next real line)
    if (buyerIdx >= 0) {
      const LABEL_RE = /^(?:bill(?:ed)?\s*to|buyer(?:'s)?(?:\s*details)?|customer(?:\s*name|\s*details)?|sold\s*to|ship(?:ped)?\s*to|consignee|client(?:\s*name)?)\s*[:\-]?\s*/i;
      const looksLikeName = s => /[A-Za-z]{3,}/.test(s) && !/gstin|gst\s*no|phone|mobile|tel|email|@|pin\s*code|state\s*code|invoice|date|\b\d{6}\b/i.test(s) && s.length <= 70;
      let cand = lines[buyerIdx].replace(/.*?(?:bill(?:ed)?\s*to|buyer(?:'s)?(?:\s*details)?|customer(?:\s*name|\s*details)?|sold\s*to|ship(?:ped)?\s*to|consignee|client(?:\s*name)?)\s*[:\-]?\s*/i, '').trim();
      if (!looksLikeName(cand)) {
        cand = null;
        for (let j = buyerIdx + 1; j < Math.min(lines.length, buyerIdx + 4); j++) { const c = lines[j].replace(LABEL_RE, ''); if (looksLikeName(c)) { cand = c; break; } }
      }
      if (cand) { f.customer = cand.replace(/^m\/s\.?\s*/i, '').replace(/[,;:]+$/, '').trim(); conf.customer = 'medium'; }
    }
    return { fields: f, confidence: conf };
  }
  window.ClearRunInvoiceParser = { parseInvoiceText, parseDate };

  /* ------------------------------------------------------------------ script loading (bundled first, CDN backup) */
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    return (loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); }));
  }
  let tessPaths = null;
  async function ensureTesseract() {
    if (window.Tesseract && tessPaths) return tessPaths;
    try {
      await loadScript('vendor/tesseract/tesseract.min.js');
      const base = new URL('vendor/tesseract/', location.href).href;
      tessPaths = { workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang' };
    } catch {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      tessPaths = {};                                     // library defaults (CDN)
    }
    return tessPaths;
  }
  async function ensureXLSX() {
    if (window.XLSX) return;
    try { await loadScript('vendor/xlsx.full.min.js'); } catch { await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); }
  }

  /* ------------------------------------------------------------------ image helpers */
  function fileToImage(file) {
    return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => res({ img, url }); img.onerror = () => rej(new Error('That file is not an image ClearRun can read. Use JPG, PNG or WEBP.')); img.src = url; });
  }
  function toCanvas(img, maxSide, grey) {
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    if (grey) {                                            // greyscale + contrast stretch helps OCR on phone photos
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
      for (let i = 0; i < p.length; i += 4) { let v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; v = Math.max(0, Math.min(255, (v - 128) * 1.35 + 128)); p[i] = p[i + 1] = p[i + 2] = v; }
      g.putImageData(d, 0, 0);
    }
    return c;
  }

  /* ------------------------------------------------------------------ scanning */
  let ocrWorker = null, scanning = false;
  const status = (t, cls) => { $('scanStatus').textContent = t; $('scanStatus').className = 'scanstatus' + (cls ? ' ' + cls : ''); };
  const progress = v => { $('scanBar').hidden = v == null; if (v != null) $('scanBarFill').style.width = Math.round(v * 100) + '%'; };

  async function readWithServer(img) {
    if (location.protocol === 'file:') return null;
    const c = toCanvas(img, 1568, false), b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
    try {
      const r = await fetch('api/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: b64, media_type: 'image/jpeg' }) });
      const json = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
      if (r.ok && json && json.fields) return json;
      if (json && r.status !== 501 && r.status !== 404) status('Server reader unavailable (' + (json.error || r.status) + '). Reading in the browser…');
    } catch { /* offline / no endpoint */ }
    return null;
  }
  async function readWithOCR(img) {
    const paths = await ensureTesseract();
    if (!ocrWorker) {
      status('Loading the text reader (first time only)…'); progress(0.05);
      ocrWorker = await Tesseract.createWorker('eng', 1, Object.assign({ logger: m => { if (m.status === 'recognizing text') progress(0.1 + 0.9 * m.progress); } }, paths));
    }
    status('Reading the invoice…'); progress(0.1);
    const { data } = await ocrWorker.recognize(toCanvas(img, 2200, true));
    const parsed = parseInvoiceText(data.text);
    return { source: 'ocr', fields: parsed.fields, confidence: parsed.confidence, raw_text: data.text };
  }

  async function scanFile(file) {
    if (scanning || !file) return;
    if (!/^image\//.test(file.type)) { status('Please choose an image (JPG, PNG or WEBP). For a PDF, take a screenshot of the invoice first.', 'err'); return; }
    if (file.size > 15 * 1024 * 1024) { status('That image is over 15 MB. Use a smaller photo.', 'err'); return; }
    scanning = true; $('scanForm').hidden = true; $('scanMsg').textContent = '';
    try {
      const { img, url } = await fileToImage(file);
      $('scanPreview').src = url; $('scanPreview').hidden = false;
      status('Reading the invoice…'); progress(0.05);
      const result = (await readWithServer(img)) || (await readWithOCR(img));
      fillForm(result);
      const got = ['customer', 'amount', 'due_date'].filter(k => result.fields[k]).length;
      status(got === 3 ? 'Done. Please check the details before adding.' : 'Done, but some details were unclear. Please fill in or correct the highlighted fields.', got === 3 ? 'ok' : 'warn');
    } catch (e) {
      status((e && e.message) || 'Could not read that image.', 'err');
    } finally { progress(null); scanning = false; }
  }

  function fillForm(r) {
    const f = r.fields || {}, c = r.confidence || {};
    $('scCustomer').value = f.customer || ''; $('scNumber').value = f.invoice_no || '';
    $('scAmount').value = f.amount != null ? f.amount : '';
    $('scInvDate').value = f.invoice_date || ''; $('scDueDate').value = f.due_date || '';
    $('scTerms').value = f.terms_days != null ? f.terms_days : ''; $('scGstin').value = f.gstin || '';
    const mark = (id, key, val) => { const el = $(id + 'Conf'); const lvl = val ? (c[key] || 'medium') : 'missing'; el.textContent = val ? (lvl === 'high' ? '✓ read clearly' : lvl === 'low' ? 'please check' : 'check this') : 'not found, please enter'; el.className = 'conf ' + lvl; };
    mark('scCustomer', 'customer', f.customer); mark('scAmount', 'amount', f.amount); mark('scDue', 'due_date', f.due_date);
    $('scanSource').textContent = r.source === 'claude' ? 'Read by AI (server)' : 'Read in your browser';
    $('scanRaw').textContent = r.raw_text || '(read by the server)';
    $('scanForm').hidden = false;
    (f.customer ? (f.amount ? $('scDueDate') : $('scAmount')) : $('scCustomer')).focus();
  }

  $('scanFile').addEventListener('change', e => { scanFile(e.target.files[0]); e.target.value = ''; });
  ['dragover', 'dragenter'].forEach(ev => $('scanDrop').addEventListener(ev, e => { e.preventDefault(); $('scanDrop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => $('scanDrop').addEventListener(ev, e => { e.preventDefault(); $('scanDrop').classList.remove('over'); }));
  $('scanDrop').addEventListener('drop', e => scanFile(e.dataTransfer.files[0]));
  $('scanAgain').addEventListener('click', () => { $('scanForm').hidden = true; $('scanPreview').hidden = true; status(''); $('scanFile').click(); });
  $('scanClose').addEventListener('click', () => { $('scanPanel').hidden = true; });
  $('scanToggle').addEventListener('click', () => { const p = $('scanPanel'); p.hidden = !p.hidden; if (!p.hidden) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  $('scanForm').addEventListener('submit', e => {
    e.preventDefault();
    const msg = $('scanMsg'), customer = $('scCustomer').value.trim(), amount = Number($('scAmount').value);
    if (!customer) { msg.textContent = 'Enter the customer name.'; msg.className = 'setmsg err'; $('scCustomer').focus(); return; }
    if (!(amount > 0)) { msg.textContent = 'Enter the invoice amount.'; msg.className = 'setmsg err'; $('scAmount').focus(); return; }
    const invDate = $('scInvDate').value || null, terms = $('scTerms').value === '' ? 30 : Math.max(0, +$('scTerms').value);
    const due = $('scDueDate').value || crAddDaysISO(invDate || crTodayISO(), terms);
    const no = $('scNumber').value.trim();
    if (no && flowItems.some(i => i.invoiceNo && i.invoiceNo.toLowerCase() === no.toLowerCase() && String(i.customer || '').toLowerCase() === customer.toLowerCase())
      && !confirm(`Invoice ${no} from ${customer} is already in your list. Add it again?`)) return;
    window.crAddItem({ name: customer + (no ? ' · ' + no : ''), customer, type: 'in', amount, category: 'receivable', recurring: 'none', kind: 'invoice',
      invoiceNo: no || undefined, gstin: $('scGstin').value.trim().toUpperCase() || undefined, invoiceDate: invDate || undefined, dueDate: due, source: 'scan' });
    const w = crWeek({ dueDate: due }), late = crDaysFromToday(due) < 0;
    msg.className = 'setmsg';
    msg.textContent = `Added: ${inr(amount)} from ${customer}, due ${niceDate(due)}` + (late ? ' (already overdue, counted this week).' : w > 12 ? ' (after the 13-week window, so not in the chart yet).' : '.');
    $('scanForm').hidden = true; $('scanPreview').hidden = true; status('');
  });

  /* ------------------------------------------------------------------ CSV / Excel import */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }
  async function readTable(file) {
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      await ensureXLSX();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).filter(r => r.some(c => String(c).trim() !== ''));
    }
    return parseCSV(await file.text());
  }

  const SYN = {
    name: /^(name|description|desc|item|particulars|details|narration|title|what)$/,
    customer: /^(customer|customer_name|buyer|client|party|party_name|debtor|account|bill_to|billed_to)$/,
    type: /^(type|direction|in_out|flow|kind|transaction_type|dr_cr)$/,
    amount: /^(amount|value|total|amt|invoice_amount|net_amount|grand_total|rs|inr|₹)$/,
    due_date: /^(due_date|due|due_on|duedate|payment_due|date_due|expected_date|date)$/,
    due_in_weeks: /^(due_in_weeks|weeks|week|due_in)$/,
    invoice_date: /^(invoice_date|bill_date|inv_date|issue_date|invoice_dt)$/,
    paid_date: /^(paid_date|paid_on|payment_date|date_paid|received_date|received_on|settled_date|cleared_on)$/,
    invoice_no: /^(invoice_no|invoice_number|inv_no|bill_no|invoice|ref|reference)$/,
    category: /^(category|head|ledger|group)$/,
    status: /^(status|payment_status|state)$/,
    recurring: /^(recurring|repeat|frequency|recurrence)$/,
    customer_type: /^(customer_type|segment|business_type|type_of_customer)$/,
    years: /^(years|years_in_business|age|vintage)$/,
    terms: /^(terms|credit_days|credit_terms|payment_terms|terms_days)$/,
    promises_kept: /^(promises_kept|kept)$/, promises_broken: /^(promises_broken|broken)$/
  };
  function mapHeaders(header) {
    const map = {};
    header.forEach((h, i) => {
      const k = String(h).toLowerCase().trim().replace(/[()₹.]/g, '').replace(/[\s\-\/]+/g, '_').replace(/_+$/, '');
      for (const [field, re] of Object.entries(SYN)) if (!(field in map) && re.test(k)) { map[field] = i; break; }
    });
    return map;
  }
  const num = v => { if (typeof v === 'number') return v; const s = String(v || '').replace(/[₹,\s]|rs\.?|inr/gi, ''); const neg = /^\(.*\)$/.test(s); const n = parseFloat(s.replace(/[()]/g, '')); return isFinite(n) ? (neg ? -n : n) : NaN; };
  const typeOf = (v, amount) => {
    const s = String(v || '').toLowerCase();
    if (/^(in|income|receipt|receivable|credit|cr|money_?in|money in|inflow|sale|sales|incoming)$/.test(s)) return 'in';
    if (/^(out|expense|payment|payable|debit|dr|money_?out|money out|outflow|purchase|bill|outgoing)$/.test(s)) return 'out';
    return amount < 0 ? 'out' : null;
  };
  const recOf = v => { const s = String(v || '').toLowerCase(); return /week/.test(s) && /bi|2|fort/.test(s) ? 'biweekly' : /week/.test(s) ? 'weekly' : /month/.test(s) ? 'monthly' : 'none'; };
  const catOf = (v, type, name) => {
    const s = String(v || '').toLowerCase(), list = CR_CATS[type];
    const hit = list.find(([k, t]) => s && (s === k || t.toLowerCase().startsWith(s.slice(0, 4))));
    return hit ? hit[0] : crCategory({ type, name });
  };

  let staged = null;
  function stage(rows, fileName) {
    if (rows.length < 2) throw new Error('The file has no data rows under the header.');
    const header = rows[0], map = mapHeaders(header), body = rows.slice(1);
    const looksHist = 'paid_date' in map || ('customer' in map && 'due_date' in map && !('type' in map));
    staged = { fileName, header, map, body, kind: looksHist ? 'hist' : 'tx' };
    document.querySelector(`input[name="impKind"][value="${staged.kind}"]`).checked = true;
    renderStage();
  }
  function build(kind) {
    const { map, body } = staged, get = (r, k) => (k in map ? r[map[k]] : ''), errors = [], out = [];
    body.forEach((r, idx) => {
      const n = idx + 2;                                      // spreadsheet row number
      if (kind === 'tx') {
        let amount = num(get(r, 'amount'));
        const name = String(get(r, 'name') || get(r, 'customer') || '').trim();
        if (!name) return errors.push(`Row ${n}: missing description/name`);
        if (!isFinite(amount) || amount === 0) return errors.push(`Row ${n}: amount missing or not a number`);
        const type = typeOf(get(r, 'type'), amount); amount = Math.abs(amount);
        if (!type) return errors.push(`Row ${n}: type should be "in" or "out" (or use a negative amount for money out)`);
        let due = parseDate(get(r, 'due_date'));
        if (!due && 'due_in_weeks' in map && String(get(r, 'due_in_weeks')).trim() !== '') { const w = num(get(r, 'due_in_weeks')); if (isFinite(w) && w >= 0) due = crAddDaysISO(crTodayISO(), Math.round(w) * 7); }
        if (!due) return errors.push(`Row ${n}: due date missing or unreadable (use YYYY-MM-DD or DD/MM/YYYY)`);
        const received = /^(received|paid|done|settled|cleared|yes|actual)/i.test(String(get(r, 'status') || ''));
        out.push({ name: name.slice(0, 60), type, amount, dueDate: due, category: catOf(get(r, 'category'), type, name), recurring: received ? 'none' : recOf(get(r, 'recurring')), received, receivedOn: received ? crTodayISO() : undefined, source: 'import' });
      } else {
        const customer = String(get(r, 'customer') || get(r, 'name') || '').trim();
        const amount = num(get(r, 'amount'));
        if (!customer) return errors.push(`Row ${n}: missing customer`);
        if (!(amount > 0)) return errors.push(`Row ${n}: amount missing or not a positive number`);
        const due = parseDate(get(r, 'due_date'));
        if (!due) return errors.push(`Row ${n}: due date missing or unreadable`);
        const paidRaw = get(r, 'paid_date'), paid = parseDate(paidRaw);
        if (String(paidRaw).trim() && !paid) return errors.push(`Row ${n}: paid date unreadable`);
        out.push({ customer: customer.slice(0, 60), amount, due_date: due, invoice_date: parseDate(get(r, 'invoice_date')) || undefined, paid_date: paid || undefined,
          invoice_no: String(get(r, 'invoice_no') || '').trim() || undefined,
          _profile: { type: String(get(r, 'customer_type') || '').trim(), years: get(r, 'years'), terms: get(r, 'terms'), promises_kept: get(r, 'promises_kept'), promises_broken: get(r, 'promises_broken') } });
      }
    });
    return { rows: out, errors };
  }
  function renderStage() {
    const kind = document.querySelector('input[name="impKind"]:checked').value, { rows, errors } = build(kind);
    $('impPreview').hidden = false; $('impMsg').textContent = '';
    $('impReplaceWrap').hidden = kind !== 'tx'; $('impUnpaidWrap').hidden = kind !== 'hist';
    const head = kind === 'tx' ? ['Name', 'Type', 'Amount', 'Due', 'Category', 'Repeats'] : ['Customer', 'Amount', 'Invoice date', 'Due', 'Paid'];
    const cells = r => kind === 'tx' ? [escapeHtml(r.name), r.type === 'in' ? 'Money in' : 'Money out', inr(r.amount), niceDate(r.dueDate) + (r.received ? ' (done)' : ''), escapeHtml(crCatLabel(r)), CR_REC[r.recurring]]
      : [escapeHtml(r.customer), inr(r.amount), niceDate(r.invoice_date), niceDate(r.due_date), r.paid_date ? niceDate(r.paid_date) : '<span class="tag pending">Unpaid</span>'];
    $('impTable').innerHTML = '<thead><tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      (rows.slice(0, 8).map(r => '<tr>' + cells(r).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') || `<tr class="emptyrow"><td colspan="${head.length}">No usable rows</td></tr>`) + '</tbody>';
    const customers = kind === 'hist' ? new Set(rows.map(r => r.customer.toLowerCase())).size : 0;
    $('impSummary').innerHTML = `<b>${escapeHtml(staged.fileName)}</b> · ${rows.length} usable row${rows.length === 1 ? '' : 's'}` + (kind === 'hist' ? ` · ${customers} customer${customers === 1 ? '' : 's'} · ${rows.filter(r => !r.paid_date).length} unpaid` : '') + (rows.length > 8 ? ' · showing the first 8' : '');
    $('impErrors').innerHTML = errors.length ? `<b>${errors.length} row${errors.length === 1 ? '' : 's'} will be skipped:</b><ul>` + errors.slice(0, 8).map(e => `<li>${escapeHtml(e)}</li>`).join('') + (errors.length > 8 ? `<li>…and ${errors.length - 8} more</li>` : '') + '</ul>' : '';
    $('impGo').disabled = !rows.length; $('impGo').textContent = rows.length ? `Import ${rows.length} row${rows.length === 1 ? '' : 's'}` : 'Nothing to import';
  }
  async function handleImportFile(file) {
    if (!file) return;
    $('impMsg').className = 'setmsg'; $('impMsg').textContent = 'Reading ' + file.name + '…'; $('impPreview').hidden = true;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB. Split it into smaller files.');
      if (!/\.(csv|xlsx|xls|txt)$/i.test(file.name)) throw new Error('Use a .csv or Excel (.xlsx) file.');
      stage(await readTable(file), file.name);
    } catch (e) { $('impMsg').className = 'setmsg err'; $('impMsg').textContent = e.message || 'Could not read that file.'; }
  }
  function doImport() {
    const kind = document.querySelector('input[name="impKind"]:checked').value, { rows } = build(kind);
    if (!rows.length) return;
    const mkId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    if (kind === 'tx') {
      if ($('impReplace').checked && flowItems.length && !confirm(`Replace your ${flowItems.length} existing entries with ${rows.length} imported ones?`)) return;
      if ($('impReplace').checked) flowItems = [];
      rows.forEach(r => flowItems.push(Object.assign({ id: mkId() }, r)));
      window.crCommit();
      $('impMsg').textContent = `Imported ${rows.length} cash flow entr${rows.length === 1 ? 'y' : 'ies'} into your forecast.`;
    } else {
      if (rows.length > 5000) { $('impMsg').className = 'setmsg err'; $('impMsg').textContent = `That's ${rows.length} invoices. Import up to 5,000 at a time (for example, the last 12 months).`; return; }
      const profiles = {}, invoices = rows.map(r => { const p = r._profile, k = r.customer.toLowerCase();
        if (!profiles[k]) profiles[k] = { name: r.customer };
        for (const [key, v] of Object.entries(p)) if (String(v).trim() !== '' && profiles[k][key] == null) profiles[k][key] = key === 'type' ? v : num(v);
        const { _profile, ...inv } = r; return inv; });
      window.crCustomerData = { invoices, customers: Object.values(profiles).filter(p => Object.keys(p).length > 1), fileName: staged.fileName, importedAt: crTodayISO() };
      let added = 0;
      if ($('impUnpaid').checked) {
        invoices.filter(i => !i.paid_date).forEach(i => { flowItems.push({ id: mkId(), name: i.customer + (i.invoice_no ? ' · ' + i.invoice_no : ''), customer: i.customer, type: 'in', amount: i.amount, category: 'receivable', recurring: 'none', kind: 'invoice', invoiceNo: i.invoice_no, dueDate: i.due_date, source: 'import' }); added++; });
      }
      window.crCommit();                                   // also saves customerData
      if (window.crReloadCustomers) window.crReloadCustomers();
      $('impMsg').textContent = `Imported payment history for ${new Set(invoices.map(i => i.customer.toLowerCase())).size} customers` + (added ? `, and added ${added} unpaid invoice${added === 1 ? '' : 's'} to your forecast.` : '.') + ' Open Customer credit to see their scores.';
    }
    $('impPreview').hidden = true; staged = null; renderCurrent();
  }
  function renderCurrent() {
    const d = window.crCustomerData;
    $('impCurrent').innerHTML = d ? `<div class="impbadge">Customer credit is using <b>your data</b>: ${new Set(d.invoices.map(i => i.customer.toLowerCase())).size} customers, ${d.invoices.length} invoices (${escapeHtml(d.fileName || 'imported file')}). <button class="reset" type="button" id="impClearHist">Remove and use sample data</button></div>` : '';
    $('impClearHist') && $('impClearHist').addEventListener('click', () => {
      if (!confirm('Remove your imported customer payment history? The credit check goes back to sample data.')) return;
      window.crCustomerData = null; window.crCommit(); if (window.crReloadCustomers) window.crReloadCustomers(); renderCurrent();
    });
  }
  window.crRenderImportState = renderCurrent;

  function template(kind) {
    const t = crTodayISO(), d = n => crAddDaysISO(t, n);
    const csv = kind === 'tx'
      ? ['name,type,amount,due_date,category,status,recurring', `Customer invoice - Laxmi Engineering,in,120000,${d(10)},receivable,expected,none`, `Salaries,out,440000,${d(7)},payroll,expected,monthly`,
        `Factory rent,out,55000,${d(8)},rent,expected,monthly`, `Steel supplier,out,200000,${d(18)},supplier,expected,none`, `Counter sale,in,15000,${t},sales,received,none`].join('\n')
      : ['customer,invoice_no,amount,invoice_date,due_date,paid_date,customer_type,years,promises_kept,promises_broken',
        `Apex Auto Systems,INV-101,600000,${d(-120)},${d(-90)},${d(-70)},Large company,15,4,1`, `Apex Auto Systems,INV-118,550000,${d(-90)},${d(-60)},${d(-38)},,,,`,
        `Apex Auto Systems,INV-131,620000,${d(-60)},${d(-30)},,,,,`, `Sri Durga Fabricators,INV-205,180000,${d(-75)},${d(-45)},${d(-20)},Trader/Retailer,4,2,5`,
        `Sri Durga Fabricators,INV-219,160000,${d(-40)},${d(-10)},,,,,`, `Laxmi Engineering,INV-310,120000,${d(-50)},${d(-20)},${d(-17)},SME manufacturer,9,6,0`].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = kind === 'tx' ? 'clearrun-cashflow-template.csv' : 'clearrun-payment-history-template.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('impFile').addEventListener('change', e => { handleImportFile(e.target.files[0]); e.target.value = ''; });
  ['dragover', 'dragenter'].forEach(ev => $('impDrop').addEventListener(ev, e => { e.preventDefault(); $('impDrop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => $('impDrop').addEventListener(ev, e => { e.preventDefault(); $('impDrop').classList.remove('over'); }));
  $('impDrop').addEventListener('drop', e => handleImportFile(e.dataTransfer.files[0]));
  document.querySelectorAll('input[name="impKind"]').forEach(r => r.addEventListener('change', () => staged && renderStage()));
  $('impGo').addEventListener('click', doImport);
  $('impCancel').addEventListener('click', () => { $('impPreview').hidden = true; staged = null; $('impMsg').textContent = ''; });
  $('tplTx').addEventListener('click', () => template('tx'));
  $('tplHist').addEventListener('click', () => template('hist'));
  document.querySelectorAll('[data-goto-import]').forEach(b => b.addEventListener('click', () => { showView('settings'); setTimeout(() => $('importPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }));
  renderCurrent();
})();
</script>
