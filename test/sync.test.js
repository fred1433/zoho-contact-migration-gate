// All simulated. Nothing here touches Google, Zapier or Zoho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncSim, matchKeyFor, POLL_LIMIT, CUTOVER, fingerprintOf } from '../sync/sim.js';

const person = (i, extra = {}) => ({ First_Name: 'Sim', Last_Name: `Contact ${i}`, Email: `sim.${i}@example.com`, ...extra });

test('simulated: a replayed event creates nothing and writes nothing back', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  const [event] = s.poll();
  assert.equal(s.applyEvent(event), 'applied');
  const before = { ...s.writes };
  assert.equal(s.applyEvent(event), 'ignored-echo');
  assert.deepEqual(s.writes, before);
  assert.equal(s.zoho.size, 1);
});

test('simulated: round trip Google to Zoho to Google adds no extra write', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  const zid = s.map.get('demo|g1');
  assert.equal(s.writeBackFromZoho(zid), 'ignored-echo');
  assert.equal(s.writes.google_written, 0);
  assert.equal(s.writes.zoho_updated, 0);
});

test('simulated: a real Zoho edit goes back once, then its echo stops', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  const zid = s.map.get('demo|g1');
  s.zohoEdit(zid, { Phone: '(415) 555-0142' });
  assert.equal(s.writeBackFromZoho(zid), 'written');
  assert.equal(s.writes.google_written, 1);
  const [echo] = s.poll();
  assert.equal(s.applyEvent(echo), 'ignored-echo');
  assert.equal(s.writeBackFromZoho(zid), 'ignored-echo');
  assert.equal(s.writes.google_written, 1);
});

test('simulated: both sides edit the same field, both values are kept and a person decides', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1, { Phone: '(415) 555-0101' }));
  s.poll().forEach((e) => s.applyEvent(e));
  const zid = s.map.get('demo|g1');
  s.zohoEdit(zid, { Phone: '(415) 555-0102' });
  s.googleSave('g1', person(1, { Phone: '(415) 555-0103' }));
  s.poll().forEach((e) => s.applyEvent(e));
  const rec = s.zoho.get(zid);
  assert.equal(rec.Phone, '(415) 555-0102');
  assert.deepEqual(rec.Conflict_Values.Phone, { google: '(415) 555-0103', zoho: '(415) 555-0102' });
  assert.equal(s.review.filter((r) => r.type === 'conflict').length, 1);
});

test('simulated: fields Zoho owns do not move the fingerprint and never reach Google', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  const zid = s.map.get('demo|g1');
  const before = fingerprintOf(s.zoho.get(zid));
  s.zohoEdit(zid, { Owner: 'Someone', Description: 'A Zoho note' });
  assert.equal(fingerprintOf(s.zoho.get(zid)), before);
  assert.equal(s.writeBackFromZoho(zid), 'ignored-echo');
  assert.equal(s.google.get('g1').Owner, undefined);
});

test('simulated: 51 contacts between two reads, the poll misses one and reconciliation finds it', () => {
  const s = new SyncSim();
  for (let i = 1; i <= 51; i++) s.googleSave(`g${i}`, person(i));
  const seen = s.poll();
  assert.equal(seen.length, POLL_LIMIT);
  seen.forEach((e) => s.applyEvent(e));
  assert.equal(s.zoho.size, 50);
  assert.equal(s.map.has('demo|g1'), false);
  assert.equal(s.reconcile().created, 1);
  assert.equal(s.zoho.size, 51);
  assert.equal(s.map.has('demo|g1'), true);
});

test('simulated: a Google deletion produces a review line, not a Zoho deletion', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  s.googleDelete('g1');
  assert.deepEqual(s.poll(), []);
  assert.equal(s.reconcile().sent_to_review, 1);
  assert.equal(s.zoho.size, 1);
  assert.equal(s.reconcile().sent_to_review, 0, 'one review line, not one per run');
});

test('simulated: flows off during the import, nothing is applied', () => {
  const s = new SyncSim();
  s.halted = true;
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => assert.equal(s.applyEvent(e), 'halted'));
  assert.equal(s.zoho.size, 0);
  assert.match(CUTOVER[1], /native Google sync/);
  assert.match(CUTOVER[4], /changed since the snapshot/);
});

test('match key: External ID on Enterprise and Ultimate, otherwise a text field that is not presented as equal', () => {
  assert.equal(matchKeyFor('Ultimate').field, 'External_ID');
  assert.equal(matchKeyFor('Enterprise').native_external_id, true);
  const k = matchKeyFor('Professional');
  assert.equal(k.field, 'Google_Contact_ID');
  assert.equal(k.native_external_id, false);
  assert.match(k.note, /Not equivalent/);
});

test('the durable map keeps account and source ID together', () => {
  const s = new SyncSim('account-b');
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  assert.ok(s.map.has('account-b|g1'));
});

test('simulated: 51 changes to linked contacts between two reads, reconciliation leaves none stale', () => {
  const s = new SyncSim();
  for (let i = 1; i <= 51; i++) s.googleSave(`g${i}`, person(i));
  s.poll().forEach((e) => s.applyEvent(e));
  s.reconcile();
  for (let i = 1; i <= 51; i++) s.googleSave(`g${i}`, person(i, { Email: `new.${i}@example.com` }));
  const seen = s.poll();
  assert.equal(seen.length, 50);
  seen.forEach((e) => s.applyEvent(e));
  const found = s.reconcile();
  assert.deepEqual(found, { created: 0, updated: 1, sent_to_review: 0 });
  assert.equal([...s.zoho.values()].filter((z) => !z.Email.startsWith('new.')).length, 0);
  assert.deepEqual(s.reconcile(), { created: 0, updated: 0, sent_to_review: 0 });
});

for (const [order, first] of [['the Google event first', 'google'], ['the Zoho event first', 'zoho']]) {
  test(`simulated: same field edited on both sides, ${order}: both values kept, nothing goes back`, () => {
    const s = new SyncSim();
    s.googleSave('g1', person(1, { Phone: '(415) 555-0101' }));
    s.poll().forEach((e) => s.applyEvent(e));
    const zid = s.map.get('demo|g1');
    s.zohoEdit(zid, { Phone: '(415) 555-0102' });
    s.googleSave('g1', person(1, { Phone: '(415) 555-0103' }));
    if (first === 'google') s.poll().forEach((e) => s.applyEvent(e));
    assert.equal(s.writeBackFromZoho(zid), 'blocked-conflict');
    if (first === 'zoho') s.poll().forEach((e) => s.applyEvent(e));
    assert.equal(s.google.get('g1').Phone, '(415) 555-0103');
    assert.equal(s.zoho.get(zid).Phone, '(415) 555-0102');
    assert.deepEqual(s.zoho.get(zid).Conflict_Values.Phone, { google: '(415) 555-0103', zoho: '(415) 555-0102' });
    assert.equal(s.review.filter((r) => r.type === 'conflict').length, 1);
    assert.equal(s.writes.google_written, 0);
    assert.equal(s.writeBackFromZoho(zid), 'blocked-conflict');
    s.resolveConflict('demo|g1', 'Phone', '(415) 555-0103');
    assert.equal(s.review.length, 0);
    assert.equal(s.zoho.get(zid).Phone, '(415) 555-0103');
    assert.equal(s.writeBackFromZoho(zid), 'ignored-echo');
  });
}

test('simulated: Google adds Mobile, a city and a second email: applied, never read as an echo', () => {
  const s = new SyncSim();
  s.googleSave('g1', person(1));
  s.poll().forEach((e) => s.applyEvent(e));
  s.googleSave('g1', person(1, { Mobile: '(415) 555-0110', Mailing_City: 'Salem', Secondary_Email: 'b@example.com' }));
  assert.deepEqual(s.poll().map((e) => s.applyEvent(e)), ['applied']);
  const z = s.zoho.get(s.map.get('demo|g1'));
  assert.equal(z.Mobile, '(415) 555-0110');
  assert.equal(z.Mailing_City, 'Salem');
  assert.equal(z.Secondary_Email, 'b@example.com');
});
