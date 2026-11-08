// Hand-written cases, run through the same code as the full address book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contact, mail, phone, runSmall, small } from './helpers.js';
import { rehearse, writeBatches, readBack, READ_FIELDS, fingerprint, openCasesFrom, sourceKeysInTarget } from '../src/pipeline.js';
import { ZohoStandIn } from '../src/zoho-standin.js';
import { runChecks, openCaseCheck, sourceIdsOf, flatten, phoneKey, plainWords, ARCHIVE_FILES } from '../src/verify.js';
import { readExport, migrate, comparablePhone, columnReport } from '../src/migrate.js';
import { ruleFor, COLUMN_RULES } from '../src/field-map.js';
import { replacePersonWithDuplicate } from '../src/faults.js';
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
  const good = [1, 2, 3].map((i) => ({ payload: { First_Name: 'Ok', Last_Name: `Person ${i}` } }));
  const bad = { payload: { First_Name: 'Solo' } };
  const direct = api.request('POST', '/Contacts', { data: [good[0].payload, bad.payload] });
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

const judge = (a, reference, run, archive) => runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: openCasesFrom(run.pending), archive: archive ?? { recorded: fingerprint(a), actual: fingerprint(a) } });
const failedIds = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);
const stateOf = () => { const { state } = intact(); return { ...state, readback: structuredClone(state.readback) }; };

test('every non-empty column of the published export has a destination or a written reason', () => {
  const { a } = intact();
  const { filled, unmapped } = columnReport(a.csv);
  assert.ok(filled.length > 30);
  assert.deepEqual(unmapped, []);
  for (const c of filled) { const r = ruleFor(c); assert.ok(r.to || r.reason, c); }
});

test('a non-empty column nobody planned for holds the merge and is named', () => {
  const csv = 'First Name,Last Name,Website 1 - Value\nAna,Ortiz,https://example.com\n';
  const { decisionLog } = migrate({ csv, ids: ['c1'], zoho: [] });
  assert.deepEqual(decisionLog.unmapped_columns, ['Website 1 - Value']);
  const reference = { account: 'demo', sources: { c1: { kind: 'person', person: 'P' } }, people: { P: { name: 'Ana Ortiz', sources: ['c1'], values: ['name:Ana Ortiz'] } } };
  const rec = { id: '1', First_Name: 'Ana', Last_Name: 'Ortiz', Google_Source_IDs: 'demo|c1' };
  const files = Object.fromEntries(ARCHIVE_FILES.map((f) => [f, 'x']));
  const r = runChecks({ reference, readback: [rec], decisionLog: { ...decisionLog, archive_fingerprint: files }, openCases: [], archive: { recorded: files, actual: files } });
  assert.deepEqual(failedIds(r), ['values']);
  assert.match(r.checks[1].detail, /Website 1 - Value/);
});

test('a value in every mapped column reaches the target', () => {
  const header = ['First Name', 'Middle Name', 'Last Name', 'Phonetic First Name', 'Phonetic Middle Name', 'Phonetic Last Name', 'Name Prefix', 'Name Suffix', 'Nickname', 'File As', 'Organization Name', 'Organization Title', 'Organization Department', 'Birthday', 'Notes', 'Labels', 'E-mail 1 - Value', 'Phone 1 - Value', 'Address 1 - Street', 'Address 1 - City', 'Address 1 - PO Box', 'Address 1 - Region', 'Address 1 - Postal Code', 'Address 1 - Country', 'Address 1 - Extended Address'];
  const values = header.map((h, i) => (h === 'E-mail 1 - Value' ? 'v-email@example.com' : h === 'Phone 1 - Value' ? '(415) 555-0100' : `v${i}`));
  const csv = `${header.join(',')}\n${values.join(',')}\n`;
  const { targets } = migrate({ csv, ids: ['c1'], zoho: [] });
  const text = JSON.stringify(targets[0].record);
  values.forEach((v, i) => assert.ok(text.includes(v), `${header[i]} (${v}) did not reach the record`));
  for (const h of header) assert.ok(ruleFor(h)?.to, h);
});

test('middle name and prefix read back on the published data', () => {
  const { reference, run } = intact();
  const prefixed = Object.values(reference.people).filter((p) => p.values.includes('prefix:Dr.'));
  const middle = Object.values(reference.people).filter((p) => p.values.some((v) => v.startsWith('middle:')));
  assert.ok(prefixed.length > 100); assert.ok(middle.length > 100);
  assert.equal(run.readback.filter((r) => r.Salutation === 'Dr.').length, prefixed.length);
  assert.equal(run.readback.filter((r) => r.Google_Middle_Name).length, middle.length);
});

test('a planted change to a middle name fails, even after rehearsing again', () => {
  const { a, reference } = intact();
  const csv = a.csv.replace(/,Marie,/, ',TAMPERED,');
  assert.notEqual(csv, a.csv);
  const changed = { ...a, csv };
  const r = judge(changed, reference, rehearse(changed));
  assert.deepEqual(failedIds(r), ['values']);
  assert.match(r.checks[1].detail, /TAMPERED|Marie/);
});

for (const [label, row] of [
  ['nickname', { Nickname: 'Bobby' }], ['middle name', { 'Middle Name': 'Lee' }], ['birthday', { Birthday: '1980-02-03' }], ['title', { 'Organization Title': 'Director' }],
]) {
  test(`a contact holding only a ${label} is not called empty`, () => {
    const cols = ['First Name', 'Last Name', 'Middle Name', 'Nickname', 'Birthday', 'Organization Title'];
    const csv = `${cols.join(',')}\n${cols.map((c) => row[c] ?? '').join(',')}\n`;
    const { decisionLog } = migrate({ csv, ids: ['c1'], zoho: [] });
    assert.equal(decisionLog.rows[0].decision, 'pending');
  });
}

test('an address with a city and no street keeps its city', () => {
  const csv = 'First Name,Last Name,Address 1 - Street,Address 1 - City,Address 1 - Region\nAna,Ortiz,,Salem,OR\n';
  const { targets } = migrate({ csv, ids: ['c1'], zoho: [] });
  assert.equal(targets[0].record.Mailing_City, 'Salem');
  assert.equal(targets[0].record.Mailing_State, 'OR');
});

test('merged members with two companies keep both', () => {
  const csv = 'First Name,Last Name,Organization Name,Organization Title,E-mail 1 - Value\nAna,Ortiz,North Fork,Owner,a@example.com\nAna,Ortiz,South Fork,Director,a@example.com\n';
  const { targets } = migrate({ csv, ids: ['c1', 'c2'], zoho: [] });
  assert.match(targets[0].record.Google_Extra_Values, /org:South Fork/);
  assert.match(targets[0].record.Google_Extra_Values, /title:Director/);
});

test('values Zoho already holds survive the import on the published data', () => {
  const { a, run } = intact();
  const zoho = JSON.parse(a.zoho);
  assert.ok(zoho.some((z) => z.Description) && zoho.some((z) => z.Mobile) && zoho.some((z) => z.Title));
  for (const z of zoho) {
    const back = run.readback.find((r) => r.id === z.id);
    for (const f of ['Description', 'Mobile', 'Title', 'Email']) if (z[f]) assert.equal(back[f].toLowerCase(), z[f].toLowerCase(), `${z.id} ${f}`);
    if (z.Account_Name) assert.deepEqual(back.Account_Name, z.Account_Name);
  }
});

for (const [field, zohoValue, contactExtra] of [
  ['Description', 'Written by sales.', { notes: 'From Google.' }],
  ['Mobile', '(202) 555-0100', { phones: [phone(415, '0101', { label: 'Mobile' })] }],
  ['Phone', '(202) 555-0101', { phones: [phone(415, '0102', { label: 'Work' })] }],
  ['Title', 'Partner', { title: 'Owner' }],
  ['Account_Name', { name: 'Zoho Side Inc', id: '42' }, { org: 'Harbor Street Clinic' }],
]) {
  test(`Zoho and Google disagree on ${field}: the record stays as it was and a case opens`, () => {
    const z = [{ id: '111', First_Name: 'Ana', Last_Name: 'Ortiz', Email: 'ana@example.com', [field]: zohoValue, Notes: [] }];
    const { reference, run, failed } = runSmall([{ contact: contact('Ana', 'Ortiz', { emails: [mail('ana@example.com')], ...contactExtra }), kind: 'pending', reason: 'conflict', zoho_id: '111' }], z);
    assert.deepEqual(failed, ['open']);
    assert.match(run.pending[0].reason, new RegExp(`disagree on ${field}`));
    assert.deepEqual(run.readback[0][field], zohoValue);
    assert.equal(run.callLog.filter((c) => c.method === 'PUT').length, 0);
    assert.ok(reference.zoho_untouched['111']);
  });
}

test('two Zoho accounts with one name: each contact keeps its own, and swapping them fails', () => {
  const z = [
    { id: '1', First_Name: 'Ana', Last_Name: 'Ortiz', Email: 'ana@example.com', Account_Name: { name: 'Bell and Hart', id: 'A' }, Notes: [] },
    { id: '2', First_Name: 'Ben', Last_Name: 'Ruiz', Email: 'ben@example.com', Account_Name: { name: 'Bell and Hart', id: 'B' }, Notes: [] },
  ];
  const entries = [
    { contact: contact('Ana', 'Ortiz', { emails: [mail('ana@example.com')], org: 'Bell and Hart' }), zoho_id: '1' },
    { contact: contact('Ben', 'Ruiz', { emails: [mail('ben@example.com')], org: 'Bell and Hart' }), zoho_id: '2' },
  ];
  const { a, reference, run, result } = runSmall(entries, z);
  assert.equal(result.verdict, 'GO');
  assert.equal(run.readback.find((r) => r.id === '1').Account_Name.id, 'A');
  assert.equal(run.readback.find((r) => r.id === '2').Account_Name.id, 'B');
  const swapped = structuredClone(run.readback);
  swapped[0].Account_Name.id = 'B'; swapped[1].Account_Name.id = 'A';
  const r = judge(a, reference, { ...run, readback: swapped });
  assert.deepEqual(failedIds(r), ['values']);
  assert.match(r.checks[1].detail, /account_id|A \(lost\)|B \(lost\)/);
});

test('a new contact naming an ambiguous company waits for a person, and a known company links by ID', () => {
  const z = [
    { id: '1', First_Name: 'Ana', Last_Name: 'Ortiz', Email: 'ana@example.com', Account_Name: { name: 'Bell and Hart', id: 'A' }, Notes: [] },
    { id: '2', First_Name: 'Ben', Last_Name: 'Ruiz', Email: 'ben@example.com', Account_Name: { name: 'Bell and Hart', id: 'B' }, Notes: [] },
    { id: '3', First_Name: 'Cy', Last_Name: 'Lund', Email: 'cy@example.com', Account_Name: { name: 'Larkspur', id: 'C' }, Notes: [] },
  ];
  const { run } = runSmall([
    { contact: contact('Ana', 'Ortiz', { emails: [mail('ana@example.com')], org: 'Bell and Hart' }), zoho_id: '1' },
    { contact: contact('Ben', 'Ruiz', { emails: [mail('ben@example.com')], org: 'Bell and Hart' }), zoho_id: '2' },
    { contact: contact('Cy', 'Lund', { emails: [mail('cy@example.com')], org: 'Larkspur' }), zoho_id: '3' },
    { contact: contact('New', 'Person', { emails: [mail('new@example.com')], org: 'Bell and Hart' }), kind: 'pending', reason: 'x' },
    { contact: contact('Old', 'Friend', { emails: [mail('old@example.com')], org: 'Larkspur' }) },
    { contact: contact('Fresh', 'Start', { emails: [mail('fresh@example.com')], org: 'Brand New Co' }) },
  ], z);
  assert.match(run.pending[0].reason, /Two Zoho accounts share the name Bell and Hart/);
  assert.equal(run.readback.find((r) => r.First_Name === 'Old').Account_Name.id, 'C');
  assert.ok(run.readback.find((r) => r.First_Name === 'Fresh').Account_Name.id);
  assert.equal(run.receipt.accounts_created, 1);
});

test('Zoho IDs swapped between two people fail, repeated IDs fail, and the match count comes from the read-back', () => {
  const s = stateOf();
  const zIds = new Set(Object.values(s.reference.people).filter((p) => p.zoho_id).map((p) => p.zoho_id));
  const pair = s.readback.filter((r) => zIds.has(r.id)).slice(0, 2);
  [pair[0].id, pair[1].id] = [pair[1].id, pair[0].id];
  const r = runChecks(s);
  assert.deepEqual(failedIds(r), ['identities']);
  assert.equal(r.wrong_record.length, 2);
  assert.equal(r.tally.already_in_zoho, 78);
  assert.match(plainWords(r).line, /on the wrong Zoho record/);
  const t = stateOf();
  t.readback[1].id = t.readback[0].id;
  assert.ok(failedIds(runChecks(t)).includes('identities'));
});

test('source keys under another Google account fail', () => {
  const s = stateOf();
  for (const r of s.readback) if (r.Google_Source_IDs) r.Google_Source_IDs = r.Google_Source_IDs.replaceAll('demo|', 'other|');
  const r = runChecks(s);
  assert.deepEqual(failedIds(r), ['identities']);
  assert.match(r.checks[0].detail, /Google account other than demo/);
});

test('names compare exactly, accents and case included', () => {
  const s = stateOf();
  const accented = s.readback.find((r) => /[^\x00-\x7f]/.test(r.Last_Name ?? ''));
  accented.Last_Name = accented.Last_Name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  assert.deepEqual(failedIds(runChecks(s)), ['values']);
  const u = stateOf();
  u.readback[0].First_Name = u.readback[0].First_Name.toUpperCase();
  assert.deepEqual(failedIds(runChecks(u)), ['values']);
});

test('a phone moved to the wrong field fails', () => {
  const s = stateOf();
  const r = s.readback.find((x) => x.Mobile && !x.Home_Phone);
  r.Home_Phone = r.Mobile; delete r.Mobile;
  assert.deepEqual(failedIds(runChecks(s)), ['values']);
});

test('at a merge, the mixed-case member gives the name', () => {
  const { run, reference } = intact();
  const shouting = run.readback.filter((r) => `${r.First_Name} ${r.Last_Name}` === `${r.First_Name} ${r.Last_Name}`.toUpperCase() && sourceIdsOf(r).length > 1);
  assert.equal(shouting.length, 0);
  assert.ok(Object.values(reference.people).every((p) => p.name !== p.name.toUpperCase()));
});

test('archive: changed then rehearsed fails against the frozen manifest, and a log from another archive fails', () => {
  const { a, reference } = intact();
  const frozen = fingerprint(a);
  const changed = { ...a, csv: `${a.csv}` .replace('Prefers email.', 'Prefers phone.') };
  const again = rehearse(changed);
  const r = judge(changed, reference, again, { recorded: frozen, actual: fingerprint(changed) });
  assert.ok(failedIds(r).includes('archive'));
  assert.match(r.checks[3].detail, /google-contacts\.csv no longer matches/);
  const s = stateOf();
  assert.deepEqual(failedIds(runChecks({ ...s, archive: { recorded: {}, actual: s.archive.actual } })), ['archive']);
  const partial = { ...s.archive.recorded }; delete partial['zoho-snapshot.json'];
  assert.deepEqual(failedIds(runChecks({ ...s, archive: { recorded: partial, actual: s.archive.actual } })), ['archive']);
  const log = { ...s.decisionLog, archive_fingerprint: { ...s.decisionLog.archive_fingerprint, 'google-contacts.csv': 'other' } };
  assert.deepEqual(failedIds(runChecks({ ...s, decisionLog: log })), ['archive']);
});

test('a case in the log and missing from the list still blocks', () => {
  const { a, reference, run } = runSmall([
    { contact: contact('Ok', 'Person', { emails: [mail('ok.person@example.com')] }) },
    { contact: contact('Solo', ''), kind: 'pending', reason: 'x' },
  ]);
  const r = runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: [], archive: { recorded: fingerprint(a), actual: fingerprint(a) } });
  assert.equal(r.verdict, 'HOLD');
  assert.deepEqual(failedIds(r), ['open']);
  assert.equal(r.tally.open, 1);
});

class RateLimited extends ZohoStandIn {
  constructor(seed, at, times) { super(seed); this.at = at; this.times = times; this.writes = 0; }
  request(method, path, o) {
    if ((method === 'POST' || method === 'PUT') && path === '/Contacts') {
      this.writes++;
      if (this.writes >= this.at && this.writes < this.at + this.times) return { status: 429, body: { code: 'TOO_MANY_REQUESTS' } };
    }
    return super.request(method, path, o);
  }
}

test('a 429 on a write is retried, with no gap and no duplicate', () => {
  const { a, reference } = intact();
  const run = rehearse(a, { api: new RateLimited(JSON.parse(a.zoho), 50, 2) });
  assert.equal(run.receipt.rate_retries, 2);
  assert.equal(run.readback.length, 10880);
  assert.equal(judge(a, reference, run).verdict, 'GO');
});

test('rate limited for good: the run stops, and a rerun finishes without duplicates', () => {
  const { a, reference } = intact();
  const api = new RateLimited(JSON.parse(a.zoho), 50, 1000);
  assert.throws(() => rehearse(a, { api }), /Rate limited/);
  const partial = api.records.size;
  assert.ok(partial > 80 && partial < 10880);
  api.at = -1; api.times = 0;
  const again = rehearse(a, { api });
  assert.equal(again.receipt.already_present, partial - 80);
  assert.equal(again.readback.length, 10880);
  assert.equal(judge(a, reference, again).verdict, 'GO');
});

test('a write that succeeded behind an error reply is found before any replay', () => {
  const { a, reference } = intact();
  class LostReply extends ZohoStandIn {
    request(method, path, o) {
      const res = super.request(method, path, o);
      if (method === 'POST' && path === '/Contacts' && !this.lost) { this.lost = true; return { status: 200, body: { data: res.body.data.map(() => ({ code: 'INTERNAL_ERROR', status: 'error', details: {} })) } }; }
      return res;
    }
  }
  const run = rehearse(a, { api: new LostReply(JSON.parse(a.zoho)) });
  assert.equal(run.receipt.found_before_replay, 100);
  assert.equal(run.receipt.replayed, 0);
  assert.equal(run.readback.length, 10880);
  assert.equal(judge(a, reference, run).verdict, 'GO');
});

test('read-back: an empty org ends cleanly, more_records with no token stops with a message', () => {
  assert.deepEqual(readBack(new ZohoStandIn()).records, []);
  class NoToken extends ZohoStandIn { list(p) { const r = super.list(p); if (r.body.info?.more_records) r.body.info.next_page_token = null; return r; } }
  const api = new NoToken(Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, Last_Name: 'x' })));
  assert.throws(() => readBack(api), /no page token/);
  assert.equal(sourceKeysInTarget(new ZohoStandIn()).size, 0);
});

test('phone keys: a plus sign keeps its country, and extension spellings do not melt into the number', () => {
  for (const f of [phoneKey, comparablePhone]) {
    assert.equal(f('+33 1 42 68 53 00'), '+33142685300');
    assert.equal(f('415-555-0101 #12'), '+14155550101x12');
    assert.equal(f('415-555-0101;12'), '+14155550101x12');
    assert.equal(f('415-555-0101 extension 12'), '+14155550101x12');
    assert.equal(f('1-415-555-0101'), '+14155550101');
  }
});

test('grammar with exactly one other group', () => {
  const s = stateOf();
  const r = runChecks(s);
  r.checks[0] = { ...r.checks[0], pass: false };
  r.wrong_groups = [{ kind: 'merged', names: ['A B', 'C D'] }, { kind: 'merged', names: ['E F', 'G H'] }];
  assert.match(plainWords(r).line, /A B and C D and 1 other group were merged by mistake/);
});

test('the field map covers each rule with a destination or a reason', () => {
  for (const [, rule] of COLUMN_RULES) assert.ok(rule.to || rule.reason);
});

test('the held copy still counts 80 matches, read from the records', () => {
  const { state, reference } = intact();
  const { readback } = replacePersonWithDuplicate(reference, state.readback, 'Maya Chen', 'Alex Reed');
  assert.equal(runChecks({ ...state, readback }).tally.already_in_zoho, 80);
  assert.ok(flatten(readback[0]).length > 0);
});

test('a conflict on a person the key expects on the record: only the open-case check stops it, and it names the person', () => {
  const entries = [{ contact: contact('Ana', 'Ortiz', { emails: [mail('ana@example.com')], title: 'Owner' }), zoho_id: '111' }, { contact: contact('Ben', 'Ruiz', { emails: [mail('ben@example.com')] }) }];
  const z = [{ id: '111', First_Name: 'Ana', Last_Name: 'Ortiz', Email: 'ana@example.com', Notes: [] }];
  const { a } = small(entries, z);
  const { reference } = small(entries, z);
  const zChanged = [{ ...z[0], Title: 'Partner' }];
  const changed = { ...a, zoho: JSON.stringify(zChanged) };
  const run = rehearse(changed);
  const r = runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: [], archive: { recorded: fingerprint(changed), actual: fingerprint(changed) } });
  assert.deepEqual(failedIds(r), ['open']);
  assert.equal(run.readback.find((x) => x.id === '111').Title, 'Partner');
  assert.match(plainWords(r).line, /The count matches\. Ana Ortiz is still an open case/);
  assert.match(r.checks[1].detail, /Not compared: Ana Ortiz/);
  assert.equal(r.tally.creations, 1);
});

test('marking everyone as an open case can never pass', () => {
  const s = stateOf();
  const log = { ...s.decisionLog, rows: s.decisionLog.rows.map((r) => ({ ...r, decision: 'pending', reason: r.reason || 'x' })), groups: 0 };
  assert.equal(runChecks({ ...s, readback: [], decisionLog: log }).verdict, 'HOLD');
});
