// The check. The same file runs under Node (gate.js, tests) and in the browser (the published page).
// Pure and deterministic: no model, no network. Hosts pass in file fingerprints they computed themselves.

export const ARCHIVE_FILES = ['google-contacts.csv', 'google-contact-ids.json', 'zoho-snapshot.json'];

// A number with no plus sign is read as North American.
export function phoneKey(raw) {
  const ext = /(?:extension|ext\.?|x|#|;)\s*(\d+)\s*$/i.exec(raw);
  const body = (ext ? raw.slice(0, ext.index) : raw).trim();
  let digits = body.replace(/\D/g, '');
  const tail = ext ? `x${ext[1]}` : '';
  if (body.startsWith('+')) return `+${digits}${tail}`;
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return `+1${digits}${tail}`;
}

const list = (s) => (s ? s.split('; ').filter(Boolean) : []);
const ADDRESS_PARTS = ['Street', 'City', 'State', 'Zip', 'Country'];
const addressOf = (rec, p) => (ADDRESS_PARTS.some((f) => rec[`${p}_${f}`]) ? `${ADDRESS_PARTS.map((f) => rec[`${p}_${f}`] ?? '').join('|')}||` : null);
const SINGLE = [['Salutation', 'prefix'], ['Google_Middle_Name', 'middle'], ['Google_Name_Suffix', 'suffix'], ['Google_Nickname', 'nickname'], ['Google_Phonetic_First', 'phonetic_first'], ['Google_Phonetic_Middle', 'phonetic_middle'], ['Google_Phonetic_Last', 'phonetic_last'], ['Google_File_As', 'file_as'], ['Title', 'title'], ['Department', 'department'], ['Date_of_Birth', 'birthday']];

// Every value a read-back record holds, wherever the field map put it. Names are compared exactly, accents and case included.
// Phones carry their field, so a number moved to the wrong field is a problem too.
export function flatten(rec) {
  const out = [`name:${rec.First_Name ?? ''} ${rec.Last_Name ?? ''}`.normalize('NFC')];
  for (const f of ['Email', 'Secondary_Email']) if (rec[f]) out.push(`email:${rec[f].toLowerCase()}`);
  for (const v of list(rec.Google_Extra_Emails)) out.push(`email:${v.toLowerCase()}`);
  for (const f of ['Phone', 'Mobile', 'Home_Phone', 'Other_Phone']) if (rec[f]) out.push(`phone@${f}:${phoneKey(rec[f])}`);
  for (const v of list(rec.Google_Extra_Phones)) out.push(`phone@Google_Extra_Phones:${phoneKey(v)}`);
  for (const v of list(rec.Google_Labels)) out.push(`label:${v}`);
  if (rec.Account_Name?.name) out.push(`org:${rec.Account_Name.name}`);
  for (const [f, k] of SINGLE) if (rec[f]) out.push(`${k}:${rec[f]}`);
  if (rec.Description) for (const v of rec.Description.split('\n---\n')) out.push(`note:${v}`);
  for (const p of ['Mailing', 'Other']) { const a = addressOf(rec, p); if (a) out.push(`address:${a}`); }
  for (const v of list(rec.Google_Extra_Addresses)) out.push(`address:${v}`);
  for (const v of list(rec.Google_Extra_Values)) out.push(v);
  for (const n of rec.Notes ?? []) out.push(`zoho_note:${n}`);
  return out;
}

const sourceRefs = (rec) => (rec.Google_Source_IDs ? rec.Google_Source_IDs.split(';').map((s) => s.split('|')) : []);
export const sourceIdsOf = (rec) => sourceRefs(rec).map(([, id]) => id);

// Rule: an open case blocks any operation that touches its record or shares one of its identifiers.
export function openCaseCheck(operation, openCases) {
  const ids = operation.sourceIds === 'all' ? null : new Set(operation.sourceIds);
  const identifiers = new Set(operation.identifiers ?? []);
  const blocking = openCases.filter((c) => !ids || ids.has(c.source_id) || (c.identifiers ?? []).some((i) => identifiers.has(i)));
  return { blocking, isolated: openCases.length - blocking.length };
}

const compareMultiset = (expectedList, gotList) => {
  const problems = [];
  const expected = new Map(), got = new Map();
  for (const v of expectedList) expected.set(v, (expected.get(v) ?? 0) + 1);
  for (const v of gotList) got.set(v, (got.get(v) ?? 0) + 1);
  for (const [v, n] of expected) if ((got.get(v) ?? 0) < n) problems.push({ value: v, problem: 'lost' });
  for (const [v, n] of got) {
    if (!expected.has(v)) problems.push({ value: v, problem: 'unexpected' });
    else if (n > expected.get(v)) problems.push({ value: v, problem: 'doubled' });
  }
  return problems;
};

export function runChecks({ reference, readback, decisionLog, openCases = [], archive, operation = { type: 'merge', name: 'merge and import', batch: 'rehearsal-01', sourceIds: 'all' } }) {
  // Where each source ID landed.
  const landed = new Map();
  for (const rec of readback) for (const id of sourceIdsOf(rec)) { if (!landed.has(id)) landed.set(id, []); landed.get(id).push(rec); }

  const missing = [], duplicated = [], wrongGroups = [], stray = [], badExclusions = [], wrongRecord = [], waiting = [];
  const pendingIds = new Set(decisionLog.rows.filter((r) => r.decision === 'pending').map((r) => r.source_id));
  const clean = [];
  const seenWrong = new Set();
  const peopleCount = Object.keys(reference.people).length;
  const untouched = reference.zoho_untouched ?? {};
  for (const [pid, person] of Object.entries(reference.people)) {
    // Held back on purpose as an open case: not missing, and the open-case check is what stops the merge.
    if (person.sources.every((s) => pendingIds.has(s) && !landed.has(s))) { waiting.push(person); continue; }
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
    // A person who already had a Zoho record must read back on that record, not on another one.
    if (person.zoho_id && rec.id !== person.zoho_id) { wrongRecord.push({ name: person.name, expected: person.zoho_id, read: rec.id }); continue; }
    clean.push([person, rec]);
  }
  const untouchedRead = readback.filter((r) => untouched[r.id]);
  const waitingRecords = new Set(waiting.map((p) => p.zoho_id).filter(Boolean));
  const leftAlone = readback.filter((r) => !sourceIdsOf(r).length && waitingRecords.has(r.id)).length;
  for (const rec of readback) if (!sourceIdsOf(rec).length && !untouched[rec.id] && !waitingRecords.has(rec.id)) stray.push(`Record ${rec.id} (${rec.First_Name ?? ''} ${rec.Last_Name ?? ''}) is in the target with no source ID`);
  for (const id of landed.keys()) {
    const s = reference.sources[id];
    if (!s) stray.push(`${id} is in the target but not in the source`);
    else if (s.kind !== 'person') stray.push(`${id} should be ${s.kind} but is in the target`);
  }
  if (reference.account) {
    const foreign = readback.filter((r) => sourceRefs(r).some(([acct]) => acct !== reference.account));
    if (foreign.length) stray.push(`${foreign.length} records carry a Google account other than ${reference.account}, first ${foreign[0].id}`);
  }
  const idCounts = new Map();
  for (const r of readback) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
  const repeatedIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);
  if (repeatedIds.length) stray.push(`Target ID ${repeatedIds[0]} is used by more than one record`);

  const logBySource = new Map();
  let logDuplicates = 0;
  for (const row of decisionLog.rows) { if (logBySource.has(row.source_id)) logDuplicates++; logBySource.set(row.source_id, row); }
  for (const [id, s] of Object.entries(reference.sources)) {
    const row = logBySource.get(id);
    if (!row) badExclusions.push(`${id} has no line in the merge decision log`);
    else if (s.kind === 'excluded' && (row.decision !== 'excluded' || !row.reason)) badExclusions.push(`${id} should be excluded with a written reason`);
    else if (s.kind === 'pending' && row.decision !== 'pending') badExclusions.push(`${id} should be waiting as an open case`);
  }

  // Source totals and the expected groups come from the decision log. Target totals and matches come from the read-back.
  // The key gives only the number of source contacts and who should be where.
  const count = (d) => decisionLog.rows.filter((r) => r.decision === d).length;
  const individual = count('individual'), merged = count('merged'), excluded = count('excluded'), pendingRows = count('pending');
  const groups = decisionLog.groups;
  const sources = Object.keys(reference.sources).length;
  const matched = clean.filter(([p, rec]) => p.zoho_id && p.zoho_id === rec.id).length;

  // A case in the log and missing from the list still blocks. A case in the list and not in the log is a hold on a placed record.
  const logged = decisionLog.rows.filter((r) => r.decision === 'pending').map((r) => ({ source_id: r.source_id, name: r.name ?? r.source_id, reason: r.reason }));
  const listed = new Set(openCases.map((c) => c.source_id));
  const allOpen = [...openCases, ...logged.filter((r) => !listed.has(r.source_id))];
  const loggedIds = new Set(logged.map((r) => r.source_id));
  const holds = openCases.filter((c) => !loggedIds.has(c.source_id)).length;

  const tally = { sources, individual, merged, groups, excluded, open: pendingRows, holds, targets: readback.length, individual_targets: individual, already_in_zoho: matched, creations: readback.length - matched - untouchedRead.length - leftAlone };
  const countMatches = sources === individual + merged + excluded + pendingRows && decisionLog.rows.length === sources && logDuplicates === 0 && readback.length === individual + groups + Object.keys(untouched).length + leftAlone;

  const identitiesPass = countMatches && !missing.length && !duplicated.length && !wrongGroups.length && !stray.length && !badExclusions.length && !wrongRecord.length;

  // Field values, one by one, only for people the identity check could place.
  const valueProblems = [];
  let peopleWithProblems = 0;
  for (const [person, rec] of clean) {
    const here = compareMultiset(person.values, flatten(rec)).map((p) => ({ name: person.name, ...p }));
    if (person.account_id && rec.Account_Name?.id !== person.account_id) here.push({ name: person.name, value: `account_id:${person.account_id}`, problem: 'lost' });
    if (!person.account_id && rec.Account_Name?.name && !rec.Account_Name.id) here.push({ name: person.name, value: `org:${rec.Account_Name.name}`, problem: 'not linked to an account' });
    if (here.length) peopleWithProblems++;
    valueProblems.push(...here);
  }
  for (const rec of untouchedRead) for (const p of compareMultiset(untouched[rec.id].values, flatten(rec))) valueProblems.push({ name: untouched[rec.id].name, ...p });
  for (const c of decisionLog.unmapped_columns ?? []) valueProblems.push({ name: `Column ${c}`, value: 'column:no destination or written reason', problem: 'unmapped' });
  const valuesCompared = clean.reduce((n, [p]) => n + p.values.length, 0);
  const notCompared = [...missing, ...duplicated, ...wrongRecord, ...waiting].map((m) => m.name).concat(wrongGroups.flatMap((w) => w.names));
  const fieldsMatched = clean.length - peopleWithProblems;

  const open = openCaseCheck(operation, allOpen);

  const archiveProblems = [];
  const incomplete = ARCHIVE_FILES.filter((f) => !archive.recorded?.[f] || !archive.actual?.[f]);
  if (incomplete.length) archiveProblems.push(`The fingerprint manifest is empty or incomplete: ${incomplete.join(', ')} cannot be compared.`);
  else {
    const changed = ARCHIVE_FILES.filter((f) => archive.recorded[f] !== archive.actual[f]);
    if (changed.length) archiveProblems.push(`${changed.join(', ')} no longer match${changed.length > 1 ? '' : 'es'} the fingerprint frozen when the archive was made.`);
    const logFp = decisionLog.archive_fingerprint ?? {};
    const stale = ARCHIVE_FILES.filter((f) => logFp[f] !== archive.recorded[f]);
    if (stale.length && !changed.length) archiveProblems.push(`The merge decisions were made from a different ${stale.join(', ')}.`);
  }

  const checks = [
    { id: 'identities', name: 'Source identities', pass: identitiesPass,
      detail: identitiesPass ? `All ${fmt(sources)} source IDs reach one record or one written reason.` : identityDetail({ countMatches, missing, duplicated, wrongGroups, stray, badExclusions, wrongRecord }) },
    { id: 'values', name: 'Field values', pass: !valueProblems.length, partial: clean.length < peopleCount,
      detail: valueProblems.length ? `${valueProblems.length > 1 ? `${fmt(valueProblems.length)} value problems` : 'One value problem'}. First: ${describeValue(valueProblems[0])}.`
        : `Field values matched for ${fmt(fieldsMatched)} of ${fmt(peopleCount)} people${notCompared.length ? `. Not compared: ${shortList(notCompared)}.` : `, ${fmt(valuesCompared)} values one by one.`}` },
    { id: 'open', name: 'Open cases', pass: !open.blocking.length,
      detail: open.blocking.length ? `${open.blocking.length} open case${open.blocking.length > 1 ? 's' : ''} touch${open.blocking.length > 1 ? '' : 'es'} this operation. First: ${open.blocking[0].name}: ${open.blocking[0].reason}` : `${allOpen.length ? `${open.isolated} open, none touching this operation.` : 'No open case touches this operation.'}` },
    { id: 'archive', name: 'Archive unchanged', pass: !archiveProblems.length,
      detail: archiveProblems.length ? archiveProblems.join(' ')
        : 'Matches the fingerprint frozen when the archive was made. That shows the files have not changed, not that a restore works.' },
  ];
  return { verdict: checks.every((c) => c.pass) ? 'GO' : 'HOLD', operation: { type: operation.type, name: operation.name, batch: operation.batch }, count_matches: countMatches, tally, checks, missing, duplicated, wrong_groups: wrongGroups, wrong_record: wrongRecord, value_problems: valueProblems, open_blocking: open.blocking };
}

const fmt = (n) => n.toLocaleString('en-US');
const describeValue = (p) => `${p.name}, ${p.value.replace(/^[a-z_]+(@\w+)?:/, '')} (${p.problem})`;
const andJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const shortList = (names, limit = 3) => (names.length > limit ? `${names.slice(0, limit).join(', ')} and ${fmt(names.length - limit)} more` : andJoin(names));
const others = (n, word = 'other') => `${fmt(n)} ${word} ${n === 1 ? 'group' : 'groups'}`;

function identityDetail({ countMatches, missing, duplicated, wrongGroups, stray, badExclusions, wrongRecord }) {
  const parts = [];
  if (!countMatches) parts.push('The totals do not close.');
  if (missing.length) parts.push(`Missing: ${shortList(missing.map((m) => m.name))}.`);
  if (duplicated.length) parts.push(`Twice: ${shortList(duplicated.map((d) => d.name))}.`);
  const merged = wrongGroups.filter((w) => w.kind === 'merged');
  if (merged.length) parts.push(`Wrongly merged: ${andJoin(merged[0].names)}${merged.length > 1 ? ` and ${others(merged.length - 1, 'more')}` : ''}.`);
  const split = wrongGroups.filter((w) => w.kind === 'split');
  if (split.length) parts.push(`Split across records: ${shortList(split.map((w) => w.names[0]))}.`);
  if (wrongRecord.length) parts.push(`On the wrong Zoho record: ${shortList(wrongRecord.map((w) => w.name))}.`);
  if (stray.length) parts.push(`${stray[0]}.`);
  if (badExclusions.length) parts.push(`${badExclusions[0]}.`);
  return parts.join(' ');
}

// The plain words at the top of the sheet. Every name and number comes from the result, never from free text.
export function plainWords(r) {
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
  const lead = r.count_matches ? 'The count matches.' : 'The count does not match.';
  if (!failed.length) {
    return { title: 'Rehearsal passed', line: `${lead} All ${fmt(r.tally.sources)} source IDs reach one record or one written reason.`, next: 'Repeat this check on every real batch, after reading its records back.', owner: 'None.' };
  }
  const first = (name) => name.split(' ')[0];
  let line, next;
  if (failed.includes('identities')) {
    const bits = [];
    if (r.missing.length) bits.push(`${shortList(r.missing.map((m) => m.name))} ${r.missing.length > 1 ? 'are' : 'is'} missing`);
    if (r.duplicated.length) bits.push(`${shortList(r.duplicated.map((d) => d.name))} ${r.duplicated.length > 1 ? 'appear' : 'appears'} twice`);
    const merged = r.wrong_groups.filter((w) => w.kind === 'merged');
    if (merged.length) bits.push(`${andJoin(merged[0].names)}${merged.length > 1 ? ` and ${others(merged.length - 1)}` : ''} were merged by mistake`);
    if (r.wrong_record?.length) bits.push(`${shortList(r.wrong_record.map((w) => w.name))} ${r.wrong_record.length > 1 ? 'are' : 'is'} on the wrong Zoho record`);
    line = bits.length ? `${lead} ${bits.join(', and ')}.` : `${lead} ${r.checks[0].detail}`;
    if (r.missing.length && r.duplicated.length) {
      const m = first(r.missing[0].name), d = first(r.duplicated[0].name);
      next = `Rebuild the overwritten row from ${m}'s archived Google contact. Rerun the check and confirm ${m} and ${d} each appear once.`;
    } else if (r.missing.length) next = `Rebuild ${first(r.missing[0].name)}'s row from the archived Google contact and rerun the check.`;
    else if (merged.length) next = 'Undo the grouping rule, rebuild the batch and rerun the check.';
    else if (r.wrong_record?.length) next = 'Put each person back on their own Zoho record and rerun the check.';
    else next = 'Remove the extra record and rerun the check.';
  } else if (failed.includes('values')) {
    line = `${lead} ${r.value_problems.length > 1 ? `${fmt(r.value_problems.length)} value problems. First: ` : 'One value problem: '}${describeValue(r.value_problems[0])}.`;
    next = 'Find where that value went wrong, fix the field map and rerun the check.';
  } else if (failed.includes('open')) {
    line = `${lead} ${r.open_blocking[0].name} is still an open case, and this merge touches it.`;
    next = 'Settle the open case or take it out of the batch, then rerun the check.';
  } else {
    line = `${lead} The archive has changed since its fingerprint was frozen, or the fingerprint cannot be read.`;
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
