// The full 11,000-contact rehearsal and the faults planted in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generate } from '../src/generate.js';
import { rehearse, openCasesFrom, fingerprint } from '../src/pipeline.js';
import { runChecks, plainWords, sourceIdsOf } from '../src/verify.js';
import { replacePersonWithDuplicate, applyFault } from '../src/faults.js';
import { archive, referenceFile, intact } from './helpers.js';

const failedIds = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);

test('intact copy: the numbers close and the verdict is go', () => {
  const r = runChecks(intact().state);
  assert.equal(r.verdict, 'GO');
  assert.deepEqual(r.tally, { sources: 11000, individual: 10780, merged: 200, groups: 100, excluded: 20, open: 0, targets: 10880, individual_targets: 10780, already_in_zoho: 80, creations: 10800 });
});

test('held copy: the total is exact and the check still names both people', () => {
  const { state, reference } = intact();
  const { readback } = replacePersonWithDuplicate(reference, state.readback, 'Maya Chen', 'Alex Reed');
  assert.equal(readback.length, state.readback.length);
  const r = runChecks({ ...state, readback });
  assert.equal(r.verdict, 'HOLD');
  assert.equal(r.count_matches, true);
  assert.deepEqual(failedIds(r), ['identities']);
  assert.deepEqual(plainWords(r), {
    title: 'Hold the merge',
    line: 'The count matches. Maya Chen is missing, and Alex Reed appears twice.',
    next: "Recover Maya's record from the snapshot and rerun the check.",
    owner: 'None.',
  });
});

test('the page runs the same check file as the command line', () => {
  assert.equal(readFileSync('site/verify.js', 'utf8'), readFileSync('src/verify.js', 'utf8'));
});

test('every source ID leads to a record or to a written reason', () => {
  const { run, reference } = intact();
  const onRecord = new Set(run.readback.flatMap(sourceIdsOf));
  const rows = new Map(run.decisionLog.rows.map((r) => [r.source_id, r]));
  for (const id of Object.keys(reference.sources)) {
    assert.ok(onRecord.has(id) || rows.get(id)?.reason, `${id} goes nowhere`);
    assert.ok(!(onRecord.has(id) && rows.get(id).decision === 'excluded'), `${id} is both excluded and on a record`);
  }
});

test('the migration code never reads the answer key', () => {
  for (const f of ['src/migrate.js', 'src/pipeline.js', 'src/zoho-standin.js']) assert.ok(!/reference/i.test(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')), f);
});

test('a wrong grouping rule planted in the migration code fails the check', () => {
  const { a, reference } = intact();
  const run = rehearse(a, { matchRule: 'identifier-only' });
  const r = runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: [], archive: { recorded: run.decisionLog.archive_fingerprint, actual: fingerprint(a) } });
  assert.deepEqual(failedIds(r), ['identities']);
  assert.ok(r.wrong_groups.length > 0);
  // Common phone numbers in the 555-01XX range are what that rule falls for.
  assert.ok(run.decisionLog.groups > 100);
});

for (const [fault, only, message] of [
  ['lost-third-email', 'values', /lost/],
  ['lost-extension', 'values', /x\d+ \(lost\)/],
  ['lost-label', 'values', /lost/],
  ['lost-and-doubled', 'values', /lost/],
  ['open-case', 'open', /open case/],
  ['archive-altered', 'archive', /no longer matches/],
]) {
  test(`fault ${fault} fails its one check, with a clean message`, () => {
    const r = runChecks(applyFault(fault, intact().state));
    assert.deepEqual(failedIds(r), [only]);
    assert.match(r.checks.find((c) => c.id === only).detail, message);
    assert.equal(r.count_matches, true);
  });
}

test('a value lost and another doubled leaves every count alone and still fails', () => {
  const { state } = intact();
  const broken = applyFault('lost-and-doubled', state);
  const r = runChecks(broken);
  assert.equal(r.tally.targets, state.readback.length);
  assert.ok(r.value_problems.some((p) => p.problem === 'lost'));
  assert.ok(r.value_problems.some((p) => p.problem === 'doubled'));
});

test('regenerating gives the same IDs and the same files', () => {
  const a = generate(), b = archive();
  assert.equal(a.ids, b.ids);
  assert.equal(a.csv, b.csv);
  assert.equal(a.zoho, b.zoho);
  assert.deepEqual(a.reference, referenceFile());
});

test('fictional data only: example.com, 555-01XX, no 707', () => {
  const { csv } = archive();
  for (const m of csv.matchAll(/[\w.+-]+@[\w.-]+/g)) assert.equal(m[0].split('@')[1].toLowerCase(), 'example.com', m[0]);
  const phones = [...csv.matchAll(/(?:\+?1[ -])?\(?(\d{3})\)?[ .-]555[ .-](\d{4})/g)];
  assert.ok(phones.length > 1000);
  for (const [, area, line] of phones) {
    assert.notEqual(area, '707');
    assert.ok(Number(line) >= 100 && Number(line) <= 199, line);
  }
});

test('emails are unique except for the planted shared and duplicate cases', () => {
  const { reference } = intact();
  const owners = new Map();
  for (const p of Object.values(reference.people)) for (const v of p.values) if (v.startsWith('email:')) owners.set(v, (owners.get(v) ?? 0) + 1);
  const shared = [...owners].filter(([, n]) => n > 1);
  assert.equal(shared.length, 41, '40 planted pairs plus the Nair family');
  assert.ok(shared.every(([, n]) => n === 2));
});

test('the small phone range collides, and no collision becomes a merge', () => {
  const { reference, run } = intact();
  assert.equal(run.decisionLog.groups, 100);
  const owners = new Map();
  for (const p of Object.values(reference.people)) for (const v of p.values) if (v.startsWith('phone:')) { owners.set(v, (owners.get(v) ?? 0) + 1); }
  assert.ok([...owners.values()].some((c) => c > 1), 'expected at least one shared number');
});

test('command line: exit codes and argument errors', () => {
  const run = (...args) => spawnSync('node', ['gate.js', ...args], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(run('nonsense').status, 2);
  assert.equal(run('check').status, 2);
  assert.equal(run('check', '--copy').status, 2);
  assert.equal(run('check', '--copy', 'mystery').status, 2);
  assert.equal(run('check', '--copy', 'intact', '--fault').status, 2);
  assert.equal(run('check', '--copy', 'intact', '--fault', 'mystery').status, 2);
  assert.equal(run('generate', 'extra').status, 2);
});

test('page: opens on hold with the four lines and no fetch to Zoho', () => {
  const html = readFileSync('site/index.html', 'utf8');
  for (const s of ['Hold the merge', 'The count matches. Maya Chen is missing, and Alex Reed appears twice.', 'Recover Maya&#39;s', 'None.', '11,000 fictional source contacts · local rehearsal', 'no live Zoho test', 'common Google Contacts export edge cases', 'Frederic de Lavenne de Choulot', 'https://cal.theaipipe.com']) {
    assert.ok(html.includes(s) || html.includes(s.replace('&#39;', "'")), s);
  }
  for (const f of ['site/index.html', 'site/app.js', 'site/verify.js', 'site/render.js']) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/zohoapis|crm\.zoho|accounts\.zoho/.test(text), f);
    assert.ok(!new RegExp('revers' + 'ible', 'i').test(text), f);
  }
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
