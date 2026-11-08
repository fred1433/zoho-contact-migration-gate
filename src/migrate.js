// The migration code under test. It reads the archive only. It never opens the answer key.
import { parseCsv } from './csv.js';
import { ruleFor } from './field-map.js';

export const SEP = ' ::: ';
const SYSTEM_LABEL = '* myContacts'; // Every saved contact carries it, so it is not kept as a label. See docs/field-map.md.

export const normalizeName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Comparable form used only to compare. The raw value is what travels to Zoho, so an extension survives.
// A number with no plus sign is read as North American. See docs/field-map.md.
export function comparablePhone(raw) {
  const ext = /(?:extension|ext\.?|x|#|;)\s*(\d+)\s*$/i.exec(raw);
  const body = (ext ? raw.slice(0, ext.index) : raw).trim();
  let digits = body.replace(/\D/g, '');
  const tail = ext ? `x${ext[1]}` : '';
  if (body.startsWith('+')) return `+${digits}${tail}`;
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return `+1${digits}${tail}`;
}

export function readExport(csvText, ids) {
  const [header, ...rows] = parseCsv(csvText);
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (row, name) => (row[col.get(name)] ?? '').trim();
  const numbered = (row, kind) => {
    const out = [];
    for (let n = 1; col.has(`${kind} ${n} - Value`); n++) {
      const value = get(row, `${kind} ${n} - Value`);
      if (!value) continue;
      const label = get(row, `${kind} ${n} - Label`);
      for (const part of value.split(SEP)) out.push({ label, value: part.trim() });
    }
    return out;
  };
  return rows.map((row, i) => {
    const addresses = [];
    for (let n = 1; col.has(`Address ${n} - Formatted`) || col.has(`Address ${n} - Street`); n++) {
      const part = (p) => get(row, `Address ${n} - ${p}`);
      const a = { label: part('Label'), street: part('Street'), city: part('City'), region: part('Region'), postal: part('Postal Code'), country: part('Country'), pobox: part('PO Box'), extended: part('Extended Address') };
      const hasParts = a.street || a.city || a.region || a.postal || a.country || a.pobox || a.extended;
      if (!hasParts && part('Formatted')) a.street = part('Formatted');
      if (hasParts || a.street) addresses.push(a);
    }
    return {
      source_id: ids[i],
      given: get(row, 'First Name'), family: get(row, 'Last Name'), middle: get(row, 'Middle Name'), prefix: get(row, 'Name Prefix'), suffix: get(row, 'Name Suffix'), nickname: get(row, 'Nickname'),
      phoneticFirst: get(row, 'Phonetic First Name'), phoneticMiddle: get(row, 'Phonetic Middle Name'), phoneticLast: get(row, 'Phonetic Last Name'), fileAs: get(row, 'File As'),
      org: get(row, 'Organization Name'), title: get(row, 'Organization Title'), department: get(row, 'Organization Department'), birthday: get(row, 'Birthday'), notes: get(row, 'Notes'),
      labels: get(row, 'Labels').split(SEP).map((s) => s.trim()).filter((l) => l && l !== SYSTEM_LABEL),
      emails: numbered(row, 'E-mail'), phones: numbered(row, 'Phone'), addresses,
    };
  });
}

// Which non-empty columns have no rule. Anything listed here stops the check.
export function columnReport(csvText) {
  const [header, ...rows] = parseCsv(csvText);
  const filled = header.filter((_, i) => rows.some((r) => (r[i] ?? '').trim()));
  return { unmapped: filled.filter((c) => !ruleFor(c)), filled };
}

const SINGLE_VALUE_FIELDS = ['middle', 'prefix', 'suffix', 'nickname', 'phoneticFirst', 'phoneticMiddle', 'phoneticLast', 'fileAs', 'org', 'title', 'department', 'birthday', 'notes'];

function classify(c) {
  const anyone = c.given || c.family || c.emails.length || c.phones.length || c.addresses.length || SINGLE_VALUE_FIELDS.some((f) => c[f]);
  if (!anyone) return c.labels.length ? { decision: 'excluded', reason: 'Only labels: no name, email, phone, company or note to keep.' } : { decision: 'excluded', reason: 'Nothing to keep: no name, email, phone, company or note.' };
  if (!c.family) {
    if (c.given) return { decision: 'pending', reason: 'First name only: Last_Name is required by Zoho, and none will be invented.' };
    if (c.org) return { decision: 'pending', reason: 'Company only: Last_Name is required by Zoho, and none will be invented.' };
    if (c.emails.length || c.phones.length) return { decision: 'pending', reason: 'Email or phone only: Last_Name is required by Zoho, and none will be invented.' };
    return { decision: 'pending', reason: 'No name, but other values to keep: Last_Name is required by Zoho, and none will be invented.' };
  }
  return null;
}

const SAME_PERSON = (nameKey, identifier) => `${nameKey}|${identifier}`;
const IDENTIFIER_ONLY = (_nameKey, identifier) => identifier;
const mixedCase = (s) => s !== s.toUpperCase() && s !== s.toLowerCase();

// opts.matchRule exists so that the test suite can plant a wrong grouping rule and prove the check catches it.
export function migrate({ csv, ids, zoho, archiveFingerprint = {}, account = 'demo' }, opts = {}) {
  const contacts = readExport(csv, ids);
  const columns = columnReport(csv);
  const matchKey = opts.matchRule === 'identifier-only' ? IDENTIFIER_ONLY : SAME_PERSON;
  const rows = [], live = [], pending = [];
  const hold = (c, reason) => {
    const name = `${c.given} ${c.family}`.trim() || c.org || 'Unnamed contact';
    rows.push({ source_id: c.source_id, decision: 'pending', target: null, reason, name });
    pending.push({ source_id: c.source_id, reason, name, identifiers: identifiersOf(c), contact: c });
  };
  for (const c of contacts) {
    const verdict = classify(c);
    if (!verdict) { live.push(c); continue; }
    if (verdict.decision === 'pending') hold(c, verdict.reason);
    else rows.push({ source_id: c.source_id, decision: verdict.decision, target: null, reason: verdict.reason });
  }

  // Rule: the same person means the same name AND a shared email or phone.
  // A shared email or landline under two names never merges on its own.
  const parent = new Map(live.map((c) => [c, c]));
  const find = (c) => { while (parent.get(c) !== c) { parent.set(c, parent.get(parent.get(c))); c = parent.get(c); } return c; };
  const firstAt = new Map(), namesByIdentifier = new Map(), why = new Map();
  for (const c of live) {
    const nameKey = normalizeName(`${c.given} ${c.family}`);
    for (const id of identifiersOf(c)) {
      if (!namesByIdentifier.has(id)) namesByIdentifier.set(id, new Set());
      namesByIdentifier.get(id).add(nameKey);
      const key = matchKey(nameKey, id);
      if (firstAt.has(key)) {
        const a = find(firstAt.get(key)), b = find(c);
        if (a !== b) parent.set(b, a);
        why.set(c, `Same name and same ${id.startsWith('+') ? 'phone' : 'email'}: ${id}`);
        why.set(firstAt.get(key), why.get(c));
      } else firstAt.set(key, c);
    }
  }
  const groups = new Map();
  for (const c of live) { const root = find(c); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(c); }

  const accountsByName = new Map();
  for (const z of zoho) if (z.Account_Name?.id) { if (!accountsByName.has(z.Account_Name.name)) accountsByName.set(z.Account_Name.name, new Set()); accountsByName.get(z.Account_Name.name).add(z.Account_Name.id); }
  const existingByKey = new Map(zoho.map((z) => [`${normalizeName(`${z.First_Name} ${z.Last_Name}`)}|${z.Email.toLowerCase()}`, z]));

  const targets = [];
  let n = 0;
  for (const members of groups.values()) {
    const record = buildRecord(members, account);
    const nameKey = normalizeName(`${members[0].given} ${members[0].family}`);
    const emails = members.flatMap((m) => m.emails.map((e) => e.value.toLowerCase()));
    const existing = emails.map((e) => existingByKey.get(`${nameKey}|${e}`)).find(Boolean);
    let update = null, reasonToHold = null;
    if (existing) {
      const applied = applyExisting(record, existing);
      update = applied.update;
      if (applied.conflicts.length) {
        const c = applied.conflicts[0];
        reasonToHold = `Zoho and Google disagree on ${c.field}: Zoho holds ${c.zoho}, Google holds ${c.google}. A person decides.`;
      }
    }
    // A company name that two Zoho accounts share cannot be linked by name.
    const outgoing = update ?? record;
    if (!reasonToHold && outgoing.Account_Name && !outgoing.Account_Name.id) {
      const known = accountsByName.get(outgoing.Account_Name.name);
      if (known?.size > 1) reasonToHold = `Two Zoho accounts share the name ${outgoing.Account_Name.name}. A person chooses one.`;
      else if (known?.size === 1) outgoing.Account_Name = { name: outgoing.Account_Name.name, id: [...known][0] };
    }
    if (reasonToHold) { for (const m of members) hold(m, reasonToHold); continue; }
    const key = `T-${String(++n).padStart(5, '0')}`;
    targets.push({ key, record, update, existing_id: existing?.id ?? null, sources: members.map((m) => m.source_id) });
    for (const m of members) {
      rows.push({ source_id: m.source_id, decision: members.length > 1 ? 'merged' : 'individual', target: key,
        reason: members.length > 1 ? why.get(m) ?? 'Grouped with its partner' : '' });
    }
  }
  const sharedKeptApart = [...namesByIdentifier.values()].filter((s) => s.size > 1).length;
  rows.sort((a, b) => (a.source_id < b.source_id ? -1 : 1));
  return {
    decisionLog: { archive_fingerprint: archiveFingerprint, rows, groups: targets.filter((t) => t.sources.length > 1).length, identifiers_shared_by_different_names: sharedKeptApart, unmapped_columns: columns.unmapped },
    targets, pending,
  };
}

export function identifiersOf(c) {
  return [...c.emails.map((e) => e.value.toLowerCase()), ...c.phones.map((p) => comparablePhone(p.value))];
}

const SLOT_BY_LABEL = { work: 'Phone', mobile: 'Mobile', home: 'Home_Phone', other: 'Other_Phone' };
const PHONE_SLOTS = ['Phone', 'Mobile', 'Home_Phone', 'Other_Phone'];
const SINGLE_SLOTS = [['middle', 'Google_Middle_Name', 'middle'], ['prefix', 'Salutation', 'prefix'], ['suffix', 'Google_Name_Suffix', 'suffix'], ['nickname', 'Google_Nickname', 'nickname'],
  ['phoneticFirst', 'Google_Phonetic_First', 'phonetic_first'], ['phoneticMiddle', 'Google_Phonetic_Middle', 'phonetic_middle'], ['phoneticLast', 'Google_Phonetic_Last', 'phonetic_last'],
  ['fileAs', 'Google_File_As', 'file_as'], ['title', 'Title', 'title'], ['department', 'Department', 'department'], ['birthday', 'Date_of_Birth', 'birthday']];
const addressKey = (a) => [a.street, a.city, a.region, a.postal, a.country, a.pobox, a.extended].join('|');

export function buildRecord(members, account = 'demo') {
  const named = members.find((m) => mixedCase(`${m.given} ${m.family}`)) ?? members[0];
  const r = { First_Name: named.given, Last_Name: named.family };
  const emails = [], seenE = new Set();
  const phones = [], seenP = new Set();
  const labels = new Set(), notes = new Set(), addresses = new Map(), extras = new Set();
  const single = (field, kind, value) => { if (!value) return; if (!r[field]) r[field] = value; else if (r[field] !== value) extras.add(`${kind}:${value}`); };
  for (const m of members) {
    for (const e of m.emails) { const k = e.value.toLowerCase(); if (!seenE.has(k)) { seenE.add(k); emails.push(k); } }
    for (const p of m.phones) { const k = comparablePhone(p.value); if (!seenP.has(k)) { seenP.add(k); phones.push(p); } }
    m.labels.forEach((l) => labels.add(l));
    if (m.notes) notes.add(m.notes);
    for (const a of m.addresses) addresses.set(addressKey(a), a);
    if (m.org) { if (!r.Account_Name) r.Account_Name = { name: m.org }; else if (r.Account_Name.name !== m.org) extras.add(`org:${m.org}`); }
    for (const [from, field, kind] of SINGLE_SLOTS) single(field, kind, m[from]);
  }
  if (emails[0]) r.Email = emails[0];
  if (emails[1]) r.Secondary_Email = emails[1];
  if (emails.length > 2) r.Google_Extra_Emails = emails.slice(2).join('; ');
  const surplus = [];
  for (const p of phones) {
    const preferred = SLOT_BY_LABEL[p.label.toLowerCase()];
    const slot = preferred && !r[preferred] ? preferred : PHONE_SLOTS.find((s) => !r[s]);
    if (slot) r[slot] = p.value; else surplus.push(p.value);
  }
  if (surplus.length) r.Google_Extra_Phones = surplus.join('; ');
  if (labels.size) r.Google_Labels = [...labels].join('; ');
  if (notes.size) r.Description = [...notes].join('\n---\n');
  const plain = [], awkward = [];
  for (const a of addresses.values()) (a.pobox || a.extended ? awkward : plain).push(a);
  const put = (a, prefix) => { for (const [k, f] of [['street', 'Street'], ['city', 'City'], ['region', 'State'], ['postal', 'Zip'], ['country', 'Country']]) if (a[k]) r[`${prefix}_${f}`] = a[k]; };
  if (plain[0]) put(plain[0], 'Mailing');
  if (plain[1]) put(plain[1], 'Other');
  const more = [...plain.slice(2), ...awkward];
  if (more.length) r.Google_Extra_Addresses = more.map(addressKey).join('; ');
  if (extras.size) r.Google_Extra_Values = [...extras].join('; ');
  r.Google_Source_IDs = members.map((m) => `${account}|${m.source_id}`).join(';');
  return r;
}

const shown = (v) => (v && v.name ? v.name : String(v));
function sameValue(field, held, incoming) {
  if (field === 'First_Name' || field === 'Last_Name') return normalizeName(held) === normalizeName(incoming);
  if (PHONE_SLOTS.includes(field)) return comparablePhone(held) === comparablePhone(incoming);
  if (field === 'Account_Name') return held.name === incoming.name;
  return String(held).trim() === String(incoming).trim();
}

// Rule for a record Zoho already holds: fill the empty fields, keep what is there, and hand any disagreement to a person.
export function applyExisting(record, zoho) {
  const working = { ...record };
  const held = [zoho.Email, zoho.Secondary_Email].filter(Boolean).map((e) => e.toLowerCase());
  const google = [record.Email, record.Secondary_Email, ...(record.Google_Extra_Emails ? record.Google_Extra_Emails.split('; ') : [])].filter(Boolean);
  const order = [...held, ...google.filter((e) => !held.includes(e))];
  delete working.Email; delete working.Secondary_Email; delete working.Google_Extra_Emails;
  if (order[0]) working.Email = order[0];
  if (order[1]) working.Secondary_Email = order[1];
  if (order.length > 2) working.Google_Extra_Emails = order.slice(2).join('; ');
  const update = { id: zoho.id }, conflicts = [];
  for (const [field, value] of Object.entries(working)) {
    const current = zoho[field];
    if (current === undefined || current === null || current === '') { update[field] = value; continue; }
    if (field === 'Email' || field === 'Secondary_Email') continue;
    if (sameValue(field, current, value)) continue;
    conflicts.push({ field, zoho: shown(current), google: shown(value) });
  }
  return { update, conflicts };
}
