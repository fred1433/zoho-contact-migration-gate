// The check. The same file runs under Node (gate.js, tests) and in the browser (the published page).
// Pure and deterministic: no model, no network. Hosts pass in file fingerprints they computed themselves.

export function phoneKey(raw) {
  const ext = /(?:ext\.?|x)\s*(\d+)\s*$/i.exec(raw);
  let digits = (ext ? raw.slice(0, ext.index) : raw).replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return `+1${digits}${ext ? `x${ext[1]}` : ''}`;
}

const list = (s) => (s ? s.split('; ').filter(Boolean) : []);
const addressOf = (rec, p) => (rec[`${p}_Street`] ? `${rec[`${p}_Street`]}|${rec[`${p}_City`]}|${rec[`${p}_State`]}|${rec[`${p}_Zip`]}|${rec[`${p}_Country`]}` : null);

// Every value a read-back record holds, wherever the field map put it.
export function flatten(rec) {
  const out = [`name:${`${rec.First_Name ?? ''} ${rec.Last_Name ?? ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}`];
  for (const f of ['Email', 'Secondary_Email']) if (rec[f]) out.push(`email:${rec[f].toLowerCase()}`);
  for (const v of list(rec.Google_Extra_Emails)) out.push(`email:${v.toLowerCase()}`);
  for (const f of ['Phone', 'Mobile', 'Home_Phone', 'Other_Phone']) if (rec[f]) out.push(`phone:${phoneKey(rec[f])}`);
  for (const v of list(rec.Google_Extra_Phones)) out.push(`phone:${phoneKey(v)}`);
  for (const v of list(rec.Google_Labels)) out.push(`label:${v}`);
  if (rec.Account_Name?.name) out.push(`org:${rec.Account_Name.name}`);
  if (rec.Title) out.push(`title:${rec.Title}`);
  if (rec.Description) for (const v of rec.Description.split('\n---\n')) out.push(`note:${v}`);
  for (const p of ['Mailing', 'Other']) { const a = addressOf(rec, p); if (a) out.push(`address:${a}`); }
  for (const v of list(rec.Google_Extra_Addresses)) out.push(`address:${v}`);
  for (const n of rec.Notes ?? []) out.push(`zoho_note:${n}`);
  return out;
}

export const sourceIdsOf = (rec) => (rec.Google_Source_IDs ? rec.Google_Source_IDs.split(';').map((s) => s.split('|')[1]) : []);

// Rule: an open case blocks any operation that touches its record or shares one of its identifiers.
export function openCaseCheck(operation, openCases) {
  const ids = operation.sourceIds === 'all' ? null : new Set(operation.sourceIds);
  const identifiers = new Set(operation.identifiers ?? []);
  const blocking = openCases.filter((c) => !ids || ids.has(c.source_id) || (c.identifiers ?? []).some((i) => identifiers.has(i)));
  return { blocking, isolated: openCases.length - blocking.length };
}

export function runChecks({ reference, readback, decisionLog, openCases = [], archive, operation = { type: 'merge', name: 'merge and import', batch: 'rehearsal-01', sourceIds: 'all' } }) {
  // Where each source ID landed.
  const landed = new Map();
  for (const rec of readback) for (const id of sourceIdsOf(rec)) { if (!landed.has(id)) landed.set(id, []); landed.get(id).push(rec); }

  const missing = [], duplicated = [], wrongGroups = [], stray = [], badExclusions = [];
  const clean = [];
  const seenWrong = new Set();
  for (const [pid, person] of Object.entries(reference.people)) {
    const hits = person.sources.map((s) => landed.get(s) ?? []);
    if (hits.every((h) => h.length === 0)) { missing.push({ person: pid, name: person.name, source_ids: person.sources }); continue; }
    if (hits.some((h) => h.length === 0)) { missing.push({ person: pid, name: person.name, source_ids: person.sources.filter((_, i) => !hits[i].length) }); continue; }
    if (hits.some((h) => h.length > 1)) { duplicated.push({ person: pid, name: person.name, records: [...new Set(hits.flat().map((r) => r.id))] }); continue; }
    const records = new Set(hits.map((h) => h[0]));
    if (records.size > 1) { wrongGroups.push({ kind: 'split', names: [person.name], records: [...records].map((r) => r.id) }); continue; }
    const rec = hits[0][0];
    const expected = new Set(person.sources);
    const others = sourceIdsOf(rec).filter((s) => !expected.has(s));
    if (others.length) {
      if (!seenWrong.has(rec.id)) {
        seenWrong.add(rec.id);
        const names = [person.name, ...others.map((s) => reference.people[reference.sources[s]?.person]?.name ?? s)];
        wrongGroups.push({ kind: 'merged', names: [...new Set(names)], record: rec.id });
      }
      continue;
    }
    clean.push([person, rec]);
  }
  for (const rec of readback) if (!sourceIdsOf(rec).length) stray.push(`Record ${rec.id} (${rec.First_Name ?? ''} ${rec.Last_Name ?? ''}) is in the target with no source ID`);
  for (const id of landed.keys()) {
    const s = reference.sources[id];
    if (!s) stray.push(`${id} is in the target but not in the source`);
    else if (s.kind !== 'person') stray.push(`${id} should be ${s.kind} but is in the target`);
  }

  const logBySource = new Map();
  let logDuplicates = 0;
  for (const row of decisionLog.rows) { if (logBySource.has(row.source_id)) logDuplicates++; logBySource.set(row.source_id, row); }
  for (const [id, s] of Object.entries(reference.sources)) {
    const row = logBySource.get(id);
    if (!row) badExclusions.push(`${id} has no line in the merge decision log`);
    else if (s.kind === 'excluded' && (row.decision !== 'excluded' || !row.reason)) badExclusions.push(`${id} should be excluded with a written reason`);
    else if (s.kind === 'pending' && row.decision !== 'pending') badExclusions.push(`${id} should be waiting as an open case`);
  }

  // The tally comes from the decision log and the read-back, so the sheet cannot print a number the run did not produce.
  const count = (d) => decisionLog.rows.filter((r) => r.decision === d).length;
  const individual = count('individual'), merged = count('merged'), excluded = count('excluded'), pendingRows = count('pending');
  const groups = decisionLog.groups;
  const sources = Object.keys(reference.sources).length;
  const already = Object.values(reference.people).filter((p) => p.zoho_id).length;
  const tally = { sources, individual, merged, groups, excluded, open: Math.max(pendingRows, openCases.length), targets: readback.length, individual_targets: individual, already_in_zoho: already, creations: readback.length - already };
  const countMatches = sources === individual + merged + excluded + pendingRows && decisionLog.rows.length === sources && logDuplicates === 0 && readback.length === individual + groups;

  const identitiesPass = countMatches && !missing.length && !duplicated.length && !wrongGroups.length && !stray.length && !badExclusions.length;

  // Field values, one by one, only for people the identity check could place.
  const valueProblems = [];
  for (const [person, rec] of clean) {
    const expected = new Map();
    for (const v of person.values) expected.set(v, (expected.get(v) ?? 0) + 1);
    const got = new Map();
    for (const v of flatten(rec)) got.set(v, (got.get(v) ?? 0) + 1);
    for (const [v, n] of expected) if ((got.get(v) ?? 0) < n) valueProblems.push({ name: person.name, value: v, problem: 'lost' });
    for (const [v, n] of got) {
      if (!expected.has(v)) valueProblems.push({ name: person.name, value: v, problem: 'unexpected' });
      else if (n > expected.get(v)) valueProblems.push({ name: person.name, value: v, problem: 'doubled' });
    }
  }
  const valuesCompared = clean.reduce((n, [p]) => n + p.values.length, 0);
  const waiting = Object.keys(reference.people).length - clean.length;

  const open = openCaseCheck(operation, openCases);

  const archiveProblems = Object.keys(archive.recorded).filter((f) => archive.recorded[f] !== archive.actual[f]);

  const checks = [
    { id: 'identities', name: 'Source identities', pass: identitiesPass,
      detail: identitiesPass ? `All ${fmt(sources)} source IDs reach one record or one written reason.` : identityDetail({ countMatches, missing, duplicated, wrongGroups, stray, badExclusions }) },
    { id: 'values', name: 'Field values', pass: !valueProblems.length,
      detail: valueProblems.length ? `${valueProblems.length > 1 ? `${fmt(valueProblems.length)} value problems` : 'One value problem'}. First: ${describeValue(valueProblems[0])}.`
        : `${fmt(valuesCompared)} values read back, compared one by one.${waiting ? ` ${fmt(waiting)} ${waiting > 1 ? 'people wait' : 'person waits'} for a record first.` : ''}` },
    { id: 'open', name: 'Open cases', pass: !open.blocking.length,
      detail: open.blocking.length ? `${open.blocking.length} open case${open.blocking.length > 1 ? 's' : ''} touch${open.blocking.length > 1 ? '' : 'es'} this operation. First: ${open.blocking[0].name}: ${open.blocking[0].reason}` : `${openCases.length ? `${open.isolated} open, none touching this operation.` : 'No open case touches this operation.'}` },
    { id: 'archive', name: 'Archive unchanged', pass: !archiveProblems.length,
      detail: archiveProblems.length ? `${archiveProblems.join(', ')} no longer match${archiveProblems.length > 1 ? '' : 'es'} the fingerprint recorded before the merge decisions.`
        : 'Matches the fingerprint taken before the merge decisions. That shows the files have not changed, not that a restore works.' },
  ];
  return { verdict: checks.every((c) => c.pass) ? 'GO' : 'HOLD', operation: { type: operation.type, name: operation.name, batch: operation.batch }, count_matches: countMatches, tally, checks, missing, duplicated, wrong_groups: wrongGroups, value_problems: valueProblems, open_blocking: open.blocking };
}

const fmt = (n) => n.toLocaleString('en-US');
const describeValue = (p) => `${p.name}, ${p.value.replace(/^[a-z_]+:/, '')} (${p.problem})`;
const andJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const shortList = (names, limit = 3) => (names.length > limit ? `${names.slice(0, limit).join(', ')} and ${fmt(names.length - limit)} more` : andJoin(names));

function identityDetail({ countMatches, missing, duplicated, wrongGroups, stray, badExclusions }) {
  const parts = [];
  if (!countMatches) parts.push('The totals do not close.');
  if (missing.length) parts.push(`Missing: ${shortList(missing.map((m) => m.name))}.`);
  if (duplicated.length) parts.push(`Twice: ${shortList(duplicated.map((d) => d.name))}.`);
  const merged = wrongGroups.filter((w) => w.kind === 'merged');
  if (merged.length) parts.push(`Wrongly merged: ${andJoin(merged[0].names)}${merged.length > 1 ? ` and ${fmt(merged.length - 1)} more groups` : ''}.`);
  const split = wrongGroups.filter((w) => w.kind === 'split');
  if (split.length) parts.push(`Split across records: ${shortList(split.map((w) => w.names[0]))}.`);
  if (stray.length) parts.push(`${stray[0]}.`);
  if (badExclusions.length) parts.push(`${badExclusions[0]}.`);
  return parts.join(' ');
}

// The plain words at the top of the sheet. Every name and number comes from the result, never from free text.
export function plainWords(r) {
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
  const lead = r.count_matches ? 'The count matches.' : 'The count does not match.';
  if (!failed.length) {
    return { title: 'Go for the merge', line: `${lead} All ${fmt(r.tally.sources)} source IDs reach one record or one written reason.`, next: 'Run this batch, then read every record back and run this check again.', owner: 'None.' };
  }
  const first = (name) => name.split(' ')[0];
  let line, next;
  if (failed.includes('identities')) {
    const bits = [];
    if (r.missing.length) bits.push(`${shortList(r.missing.map((m) => m.name))} ${r.missing.length > 1 ? 'are' : 'is'} missing`);
    if (r.duplicated.length) bits.push(`${shortList(r.duplicated.map((d) => d.name))} ${r.duplicated.length > 1 ? 'appear' : 'appears'} twice`);
    const merged = r.wrong_groups.filter((w) => w.kind === 'merged');
    if (merged.length) bits.push(`${andJoin(merged[0].names)} ${merged.length > 1 ? `and ${fmt(merged.length - 1)} other groups were` : 'were'} merged by mistake`);
    line = bits.length ? `${lead} ${bits.join(', and ')}.` : `${lead} ${r.checks[0].detail}`;
    next = r.missing.length ? `Recover ${first(r.missing[0].name)}'s record from the snapshot and rerun the check.`
      : merged.length ? 'Undo the grouping rule, rebuild the batch and rerun the check.'
      : 'Remove the extra record and rerun the check.';
  } else if (failed.includes('values')) {
    line = `${lead} ${r.value_problems.length > 1 ? `${fmt(r.value_problems.length)} value problems. First: ` : 'One value did not read back: '}${describeValue(r.value_problems[0])}.`;
    next = 'Find where that value was dropped, fix the field map and rerun the check.';
  } else if (failed.includes('open')) {
    line = `${lead} ${r.open_blocking[0].name} is still an open case, and this merge touches it.`;
    next = 'Settle the open case or take it out of the batch, then rerun the check.';
  } else {
    line = `${lead} The archive has changed since the merge decisions were logged.`;
    next = 'Stop, find out what changed the archive, and redo the decisions against a fresh one.';
  }
  return { title: 'Hold the merge', line, next, owner: 'None.' };
}

// For the Evidence panel: where one named person landed.
export function tracePerson(reference, readback, name) {
  const person = Object.values(reference.people).find((p) => p.name === name);
  if (!person) return null;
  const ids = new Set(person.sources);
  const records = readback.filter((r) => sourceIdsOf(r).some((s) => ids.has(s)));
  return { name, source_ids: person.sources, records: records.map((r) => r.id), value_count: person.values.length };
}
