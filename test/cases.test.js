// Hand-written cases, run through the same code as the full address book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contact, mail, phone, runSmall, small } from './helpers.js';
import { rehearse, writeBatches, readBack, READ_FIELDS, fingerprint, openCasesFrom } from '../src/pipeline.js';
import { ZohoStandIn } from '../src/zoho-standin.js';
import { runChecks, openCaseCheck, sourceIdsOf } from '../src/verify.js';
import { readExport, migrate, comparablePhone } from '../src/migrate.js';
import { restoreDrill, inventory, NOT_COVERED } from '../src/restore.js';
import { intact } from './helpers.js';

const family = 'family@example.com';
const zohoNair = [{ id: '111', First_Name: 'Priya', Last_Name: 'Nair', Email: family, Account_Name: { name: 'Harbor Street Clinic', id: '9' }, Notes: ['Spring invoice goes to the clinic.'] }];
const sharedEmailEntries = () => [
  { contact: contact('Priya', 'Nair', { emails: [mail(family)], org: 'Harbor Street Clinic' }), zoho_id: '111' },
  { contact: contact('Dev', 'Nair', { emails: [mail(family)] }) },
];

test('shared email with a Zoho note: two people, and the note stays on the right one', () => {
  const { result, run } = runSmall(sharedEmailEntries(), zohoNair);
  assert.equal(result.verdict, 'GO');
  assert.equal(run.readback.length, 2);
  const priya = run.readback.find((r) => r.First_Name === 'Priya'), dev = run.readback.find((r) => r.First_Name === 'Dev');
  assert.deepEqual(priya.Notes, ['Spring invoice goes to the clinic.']);
  assert.equal(priya.id, '111');
  assert.equal(dev.Notes, undefined);
});

test('the same two people through a plain upsert on Email: one is overwritten, and the check says so', () => {
  const { a, reference } = small(sharedEmailEntries(), zohoNair);
  const api = new ZohoStandIn(JSON.parse(a.zoho));
  const clean = migrate({ csv: a.csv, ids: JSON.parse(a.ids), zoho: JSON.parse(a.zoho), archiveFingerprint: fingerprint(a) });
  const res = api.request('POST', '/Contacts/upsert', { data: clean.targets.map((t) => t.record) });
  assert.ok(res.body.data.every((d) => d.action === 'update' && d.duplicate_field === 'Email'));
  const back = readBack(api, new Set(['111']));
  assert.equal(back.records.length, 1);
  const r = runChecks({ reference, readback: back.records, decisionLog: clean.decisionLog, openCases: [], archive: { recorded: clean.decisionLog.archive_fingerprint, actual: fingerprint(a) } });
  assert.equal(r.verdict, 'HOLD');
  assert.equal(r.count_matches, false);
  assert.ok(r.missing.some((m) => m.name === 'Priya Nair'));
});

test('a shared family landline under two names never merges on its own', () => {
  const landline = phone(415, '0150', { label: 'Home' });
  const { result, run } = runSmall([
    { contact: contact('Ana', 'Ortiz', { phones: [landline] }) },
    { contact: contact('Luis', 'Ortiz', { phones: [{ ...landline, value: '415.555.0150' }] }) },
  ]);
  assert.equal(result.verdict, 'GO');
  assert.equal(run.readback.length, 2);
  assert.equal(run.decisionLog.groups, 0);
  assert.equal(run.decisionLog.identifiers_shared_by_different_names, 1);
});

test('a batch with one incomplete record: HTTP 207, successes kept, only the failure replayed', () => {
  const api = new ZohoStandIn();
  const good = [1, 2, 3].map((i) => ({ record: { First_Name: 'Ok', Last_Name: `Person ${i}` } }));
  const bad = { record: { First_Name: 'Solo' } };
  const direct = api.request('POST', '/Contacts', { data: [good[0].record, bad.record] });
  assert.equal(direct.status, 207);
  assert.equal(direct.body.data[1].code, 'MANDATORY_NOT_FOUND');
  const api2 = new ZohoStandIn();
  const out = writeBatches(api2, 'POST', '/Contacts', [good[0], bad, good[1], good[2]]);
  assert.equal(out.done.length, 3);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].code, 'MANDATORY_NOT_FOUND');
  assert.equal(out.replayed, 1);
  assert.equal(api2.records.size, 3, 'a replay must not create the successes twice');
  assert.deepEqual(api2.calls.map((c) => c.records), [4, 1]);
});

for (const [label, c, match] of [
  ['first name only', contact('Solo', ''), /First name only/],
  ['company only', contact('', '', { org: 'Quarry Lane Books' }), /Company only/],
  ['email only', contact('', '', { emails: [mail('nobody.named@example.com')] }), /Email or phone only/],
]) {
  test(`no last name, ${label}: waits with a reason, nothing invented`, () => {
    const { result, run, failed } = runSmall([
      { contact: contact('Ok', 'Person', { emails: [mail('ok.person@example.com')] }) },
      { contact: c, kind: 'pending', reason: 'no last name' },
    ]);
    assert.deepEqual(failed, ['open']);
    assert.equal(run.readback.length, 1);
    assert.equal(run.pending.length, 1);
    assert.match(run.pending[0].reason, match);
    assert.equal(result.tally.open, 1);
    assert.ok(run.readback.every((r) => r.Last_Name === 'Person'));
    assert.ok(run.targets.every((t) => t.record.Last_Name), 'no record goes out with an invented or empty last name');
  });
}

test('open cases: block a merge that touches them, let an independent create batch through, stay untouched', () => {
  const open = [{ source_id: 'c9001', name: 'Solo', reason: 'First name only', identifiers: ['solo@example.com'] }];
  assert.equal(openCaseCheck({ type: 'merge', sourceIds: ['c9001', 'c9002'] }, open).blocking.length, 1);
  assert.equal(openCaseCheck({ type: 'merge', sourceIds: ['c9002'], identifiers: ['solo@example.com'] }, open).blocking.length, 1, 'a shared identifier also counts as touching');
  assert.equal(openCaseCheck({ type: 'create', sourceIds: ['c9002'], identifiers: ['other@example.com'] }, open).blocking.length, 0);
  const { run } = runSmall([
    { contact: contact('Ok', 'Person', { emails: [mail('ok.person@example.com')] }) },
    { contact: contact('Solo', '', { emails: [mail('solo@example.com')] }), kind: 'pending', reason: 'x' },
  ]);
  assert.equal(run.readback.length, 1);
  assert.ok(!run.readback.some((r) => r.Email === 'solo@example.com'));
  assert.equal(run.pending[0].contact.emails[0].value, 'solo@example.com');
});

test('more values than slots: each one survives, value by value, raw form kept', () => {
  const emails = [1, 2, 3, 4, 5].map((n) => mail(`many.${n}@example.com`));
  const phones = [phone(415, '0101', { label: 'Mobile' }), phone(415, '0102', { label: 'Work', ext: '204', style: 3 }), phone(415, '0103', { label: 'Home' }), phone(415, '0104', { label: 'Other' }), phone(415, '0105', { label: 'Work' }), phone(415, '0106', { label: 'Mobile' })];
  const { result, run } = runSmall([{ contact: contact('Many', 'Values', { emails, phones }) }]);
  assert.equal(result.verdict, 'GO');
  const rec = run.readback[0];
  assert.equal(rec.Email, 'many.1@example.com');
  assert.equal(rec.Secondary_Email, 'many.2@example.com');
  assert.equal(rec.Google_Extra_Emails, 'many.3@example.com; many.4@example.com; many.5@example.com');
  assert.equal(rec.Phone, '415.555.0102 ext. 204', 'the raw value travels, the comparable form does not');
  assert.ok(rec.Google_Extra_Phones.split('; ').length === 2);
  assert.equal(comparablePhone(rec.Phone), '+14155550102x204');
});

test('an extension lost on the way fails the value check and names it', () => {
  const { a, reference } = small([{ contact: contact('Ext', 'Ension', { phones: [phone(415, '0102', { label: 'Work', ext: '204' })] }) }]);
  const run = rehearse(a);
  run.readback[0].Phone = run.readback[0].Phone.replace(/ ext\. 204/, '');
  const r = runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: [], archive: { recorded: run.decisionLog.archive_fingerprint, actual: fingerprint(a) } });
  assert.match(r.checks.find((c) => c.id === 'values').detail, /\+14155550102x204 \(lost\)/);
});

test('cells with the Google separator: two emails in one cell count as two values', () => {
  const csv = 'First Name,Last Name,Labels,E-mail 1 - Label,E-mail 1 - Value\nTwo,Mails,Clients ::: * myContacts,Work ::: Home,a.two@example.com ::: b.two@example.com\n';
  const [c] = readExport(csv, ['c1']);
  assert.deepEqual(c.emails.map((e) => e.value), ['a.two@example.com', 'b.two@example.com']);
});

test('the system label * myContacts is dropped on purpose, and only that one', () => {
  const csv = 'First Name,Last Name,Labels\nOnly,Label,Clients ::: * myContacts ::: Vendors\n';
  assert.deepEqual(readExport(csv, ['c1'])[0].labels, ['Clients', 'Vendors']);
});

test('more labels than Zoho allows as tags: none lost', () => {
  const labels = Array.from({ length: 14 }, (_, i) => `Label ${i + 1}`);
  const { result, run } = runSmall([{ contact: contact('Many', 'Labels', { labels }) }]);
  assert.equal(result.verdict, 'GO');
  assert.equal(run.readback[0].Google_Labels.split('; ').length, 14);
});

test('API limits: 100 per write, 200 per read, page_token past 2,000', () => {
  const { run } = intact();
  assert.ok(run.callLog.filter((c) => c.method !== 'GET').every((c) => c.records <= 100));
  assert.equal(run.receipt.largest_write_batch, 100);
  const reads = run.callLog.filter((c) => c.path === '/Contacts' && c.method === 'GET');
  assert.ok(reads.some((c) => c.params.page_token), 'the read-back must cross into page_token');
  assert.equal(run.receipt.records_read_back, 10880);
  assert.equal(run.receipt.last_page.more_records, false);
  const api = new ZohoStandIn();
  assert.equal(api.request('POST', '/Contacts', { data: Array(101).fill({ Last_Name: 'x' }) }).status, 400);
  assert.equal(api.request('GET', '/Contacts', { params: { fields: READ_FIELDS, per_page: 201 } }).status, 400);
  assert.equal(api.request('GET', '/Contacts', { params: { fields: READ_FIELDS, page: 11, per_page: 200 } }).body.code, 'DISCRETE_PAGINATION_LIMIT_EXCEEDED');
});

test('merges are decided before import: no merge or delete call, and the log records the archive fingerprint', () => {
  const { run, a } = intact();
  assert.equal(run.receipt.merge_calls, 0);
  assert.equal(run.receipt.delete_calls, 0);
  assert.deepEqual(run.decisionLog.archive_fingerprint, fingerprint(a));
  const merged = run.decisionLog.rows.filter((r) => r.decision === 'merged');
  assert.equal(merged.length, 200);
  assert.ok(merged.every((r) => r.reason.startsWith('Same name and same')));
});

test('restore drill: one record with its note and relation comes back in an isolated copy', () => {
  const zoho = JSON.parse(intact().a.zoho);
  const d = restoreDrill(zoho);
  assert.equal(d.note_restored, true);
  assert.equal(d.relation_restored, true);
  assert.equal(d.fields_restored, true);
  assert.equal(d.id_changed, true, 'a restored record gets a new ID, so the source map has to be rewritten');
  const inv = inventory({ csvRows: 11000, zoho });
  assert.equal(inv.google.contacts, 11000);
  assert.equal(inv.zoho.contacts, 80);
  assert.deepEqual(inv.not_covered, NOT_COVERED);
});

test('no generated record carries a source ID twice', () => {
  const { run } = intact();
  const ids = run.readback.flatMap(sourceIdsOf);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(openCasesFrom(run.pending).length === 0);
});
