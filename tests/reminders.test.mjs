import assert from 'node:assert/strict';
import { STAGES, nextStage, buildEmail, ladderPreview, legalNoticeHtml } from '../lib/reminders.mjs';
const inv = { id: 'a1', number: 'INV-7', customer: 'Apex Auto', email: 'a@b.co', amount: 236000, issueDate: '2026-09-01', dueDate: '2026-09-20', reminders: { enabled: true } };
const settings = { businessName: 'Sri Tools', contactEmail: 'me@sri.in', udyam: 'UDYAM-KA-01-0000001', bankRate: '6.5' };
let n = 0; const t = (name, fn) => { fn(); n++; };
t('tiers in order', () => assert.deepEqual(STAGES.map(s => s.tier), ['gentle', 'gentle', 'formal', 'formal', 'legal']));
t('legal not sent without opt-in', () => assert.equal(nextStage(inv, '2026-10-25', []).key, 'over_15'));
t('legal sent with opt-in', () => assert.equal(nextStage({ ...inv, reminders: { enabled: true, legal: true } }, '2026-10-25', []).key, 'over_30'));
t('no going backwards', () => assert.equal(nextStage(inv, '2026-10-25', ['over_15']), null));
t('old logs still recognised', () => assert.equal(nextStage(inv, '2026-09-28', ['before_7', 'due_0']).key, 'over_7'));
t('gentle tone', () => { const e = buildEmail({ stage: STAGES[0], invoice: inv, settings, today: '2026-09-13' }); assert.match(e.subject, /Friendly reminder/); assert.match(e.text, /friendly reminder/); assert.doesNotMatch(e.text, /MSMED|legal/i); });
t('formal with interest', () => { const e = buildEmail({ stage: STAGES[3], invoice: inv, settings, today: '2026-10-05' }); assert.match(e.text, /Section 16/); assert.match(e.text, /formal notice of demand/); });
t('legal notice', () => { const e = buildEmail({ stage: STAGES[4], invoice: inv, settings, today: '2026-10-20', sentLog: [{ stage: 'over_7', status: 'sent', sent_at: '2026-09-27T04:00:00Z' }] });
  assert.match(e.subject, /Legal notice/); assert.match(e.text, /Section 18/); assert.match(e.text, /27 September 2026/); assert.match(e.text, /within 15 days/); assert.match(e.text, /without prejudice/); });
t('legal without Udyam uses general wording', () => { const e = buildEmail({ stage: STAGES[4], invoice: inv, settings: { businessName: 'X' }, today: '2026-10-20' }); assert.match(e.text, /legal proceedings/); assert.doesNotMatch(e.text, /MSMED/); });
t('preview shows 5 emails and approval', () => { const p = ladderPreview({ invoice: inv, settings, today: '2026-09-10' }); assert.equal(p.length, 5); assert.equal(p[4].status, 'needs approval'); assert.equal(p[0].sendOn, '2026-09-13'); assert.match(p[3].text, /15 days overdue/); });
t('notice html escapes input', () => { const h = legalNoticeHtml({ invoice: { ...inv, customer: '<script>x</script>' }, settings, today: '2026-10-20' }); assert.ok(!h.includes('<script>x')); assert.match(h, /NOTICE OF DEMAND/); });
t('statuses follow the daily job', () => {
  const p = ladderPreview({ invoice: { ...inv, reminders: { enabled: true } }, settings, today: '2026-10-28' }); // 38 days overdue
  assert.deepEqual(p.map(e => e.status), ['skipped', 'skipped', 'skipped', 'sends next', 'needs approval']);
  const sent = ladderPreview({ invoice: { ...inv, reminders: { enabled: true, legal: true } }, settings, today: '2026-10-28', sentLog: [{ invoice_id: 'a1', stage: 'over_15', status: 'sent', sent_at: '2026-10-05' }] });
  assert.deepEqual(sent.map(e => e.status), ['skipped', 'skipped', 'skipped', 'sent', 'sends next']);
  const off = ladderPreview({ invoice: { ...inv, reminders: { enabled: false } }, settings, today: '2026-09-01' });
  assert.ok(off.slice(0, 4).every(e => e.status === 'planned'));
});
console.log(`reminder tests: ${n} passed`);
