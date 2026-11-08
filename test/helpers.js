import { readFileSync } from 'node:fs';
import { renderArchive, referenceFromPlan, formatPhone, phoneTruth } from '../src/generate.js';
import { rehearse, fingerprint, openCasesFrom } from '../src/pipeline.js';
import { runChecks } from '../src/verify.js';

export const archive = () => ({ csv: readFileSync('archive/google-contacts.csv', 'utf8'), ids: readFileSync('archive/google-contact-ids.json', 'utf8'), zoho: readFileSync('archive/zoho-snapshot.json', 'utf8') });
export const referenceFile = () => JSON.parse(readFileSync('reference/reference.json', 'utf8'));

let cached;
// One full rehearsal, shared by the tests that do not change it.
export function intact() {
  if (cached) return cached;
  const a = archive(), reference = referenceFile(), run = rehearse(a);
  cached = { a, reference, run, state: { reference, readback: run.readback, decisionLog: run.decisionLog, openCases: openCasesFrom(run.pending), archive: { recorded: run.decisionLog.archive_fingerprint, actual: fingerprint(a) } } };
  return cached;
}

export const contact = (given, family, extra = {}) => ({ given, family, middle: '', prefix: '', suffix: '', org: '', title: '', notes: '', labels: [], emails: [], phones: [], addresses: [], ...extra });
export const mail = (value, label = 'Work') => ({ label, value });
export const phone = (area, line, { style = 0, ext = '', label = 'Mobile' } = {}) => ({ label, value: formatPhone(area, line, style, ext), truth: phoneTruth(area, line, ext) });

// A small hand-written address book, run through the same code as the full one.
export function small(entries, zoho = []) {
  const plan = entries.map((e, i) => ({ kind: 'person', reason: '', source_id: `c${9000 + i}`, ...e, person: e.kind && e.kind !== 'person' ? null : e.person ?? `P-${i}` }));
  const a = renderArchive({ plan, zoho });
  const reference = referenceFromPlan({ plan, zoho });
  return { a: { csv: a.csv, ids: a.ids, zoho: a.zoho }, reference };
}

export function runSmall(entries, zoho = [], opts = {}) {
  const { a, reference } = small(entries, zoho);
  const run = rehearse(a, opts);
  const result = runChecks({ reference, readback: run.readback, decisionLog: run.decisionLog, openCases: openCasesFrom(run.pending), archive: { recorded: run.decisionLog.archive_fingerprint, actual: fingerprint(a) } });
  return { a, reference, run, result, failed: result.checks.filter((c) => !c.pass).map((c) => c.id) };
}
