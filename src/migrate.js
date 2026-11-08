// The migration code under test. It reads the archive only. It never opens reference/.
import { parseCsv } from './csv.js';

export const SEP = ' ::: ';
const SYSTEM_LABEL = '* myContacts'; // Every saved contact carries it, so it is not kept as a label. See docs/field-map.md.

export const normalizeName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// E.164-style form used only to compare. The raw value is what travels to Zoho, so an extension survives.
export function comparablePhone(raw) {
  const ext = /(?:ext\.?|x)\s*(\d+)\s*$/i.exec(raw);
  const body = ext ? raw.slice(0, ext.index) : raw;
  let digits = body.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return `+1${digits}${ext ? `x${ext[1]}` : ''}`;
}

export function readExport(csvText, ids) {
  const [header, ...rows] = parseCsv(csvText);
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (row, name) => row[col.get(name)] ?? '';
  const numbered = (row, kind, suffix) => {
    const out = [];
    for (let n = 1; col.has(`${kind} ${n} - ${suffix}`); n++) {
      const value = get(row, `${kind} ${n} - ${suffix}`);
      if (!value) continue;
      const label = get(row, `${kind} ${n} - Label`);
      for (const part of value.split(SEP)) out.push({ label, value: part.trim() });
    }
    return out;
  };
  return rows.map((row, i) => {
    const addresses = [];
    for (let n = 1; col.has(`Address ${n} - Street`); n++) {
      const street = get(row, `Address ${n} - Street`);
      if (!street) continue;
      addresses.push({ label: get(row, `Address ${n} - Label`), street, city: get(row, `Address ${n} - City`), region: get(row, `Address ${n} - Region`), postal: get(row, `Address ${n} - Postal Code`), country: get(row, `Address ${n} - Country`) });
    }
    return {
      source_id: ids[i],
      given: get(row, 'First Name').trim(), family: get(row, 'Last Name').trim(),
      org: get(row, 'Organization Name').trim(), title: get(row, 'Organization Title').trim(), notes: get(row, 'Notes').trim(),
      labels: get(row, 'Labels').split(SEP).map((s) => s.trim()).filter((l) => l && l !== SYSTEM_LABEL),
      emails: numbered(row, 'E-mail', 'Value'), phones: numbered(row, 'Phone', 'Value'), addresses,
    };
  });
}

function classify(c) {
  const anyone = c.given || c.family || c.org || c.notes || c.emails.length || c.phones.length || c.addresses.length;
  if (!anyone) return c.labels.length ? { decision: 'excluded', reason: 'label_only' } : { decision: 'excluded', reason: 'empty' };
  if (!c.family) {
    if (c.given) return { decision: 'pending', reason: 'First name only: Last_Name is required by Zoho, and none will be invented.' };
    if (c.org) return { decision: 'pending', reason: 'Company only: Last_Name is required by Zoho, and none will be invented.' };
    return { decision: 'pending', reason: 'Email or phone only: Last_Name is required by Zoho, and none will be invented.' };
  }
  return null;
}

const SAME_PERSON = (nameKey, identifier) => `${nameKey}|${identifier}`;
const IDENTIFIER_ONLY = (_nameKey, identifier) => identifier;

// opts.matchRule exists so that the test suite can plant a wrong grouping rule and prove the check catches it.
export function migrate({ csv, ids, zoho, archiveFingerprint = {} }, opts = {}) {
  const contacts = readExport(csv, ids);
  const matchKey = opts.matchRule === 'identifier-only' ? IDENTIFIER_ONLY : SAME_PERSON;
  const rows = [], live = [], pending = [];
  for (const c of contacts) {
    const verdict = classify(c);
    if (!verdict) { live.push(c); continue; }
    rows.push({ source_id: c.source_id, decision: verdict.decision, target: null, reason: verdict.reason });
    if (verdict.decision === 'pending') pending.push({ source_id: c.source_id, reason: verdict.reason, name: `${c.given} ${c.family}`.trim() || c.org, identifiers: identifiersOf(c), contact: c });
  }

  // Rule: the same person means the same name AND a shared email or phone.
  // A shared email or landline under two names never merges on its own.
  const parent = new Map(live.map((c) => [c, c]));
  const find = (c) => { while (parent.get(c) !== c) { parent.set(c, parent.get(parent.get(c))); c = parent.get(c); } return c; };
  const firstAt = new Map();
  const namesByIdentifier = new Map();
  const why = new Map();
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

  const targets = [];
  let n = 0;
  const existingByKey = new Map(zoho.map((z) => [`${normalizeName(`${z.First_Name} ${z.Last_Name}`)}|${z.Email.toLowerCase()}`, z]));
  for (const members of groups.values()) {
    const key = `T-${String(++n).padStart(5, '0')}`;
    const record = buildRecord(members);
    const nameKey = normalizeName(`${members[0].given} ${members[0].family}`);
    const emails = members.flatMap((m) => m.emails.map((e) => e.value.toLowerCase()));
    const existing = emails.map((e) => existingByKey.get(`${nameKey}|${e}`)).find(Boolean);
    targets.push({ key, record, existing_id: existing?.id ?? null, sources: members.map((m) => m.source_id) });
    for (const m of members) {
      rows.push({ source_id: m.source_id, decision: members.length > 1 ? 'merged' : 'individual', target: key,
        reason: members.length > 1 ? why.get(m) ?? 'Grouped with its partner' : '' });
    }
  }
  const sharedKeptApart = [...namesByIdentifier.values()].filter((s) => s.size > 1).length;
  rows.sort((a, b) => (a.source_id < b.source_id ? -1 : 1));
  return {
    decisionLog: { archive_fingerprint: archiveFingerprint, rows, groups: targets.filter((t) => t.sources.length > 1).length, identifiers_shared_by_different_names: sharedKeptApart },
    targets, pending,
  };
}

export function identifiersOf(c) {
  return [...c.emails.map((e) => e.value.toLowerCase()), ...c.phones.map((p) => comparablePhone(p.value))];
}

const SLOT_BY_LABEL = { work: 'Phone', mobile: 'Mobile', home: 'Home_Phone', other: 'Other_Phone' };
const PHONE_SLOTS = ['Phone', 'Mobile', 'Home_Phone', 'Other_Phone'];

export function buildRecord(members) {
  const first = members[0];
  const r = { First_Name: first.given, Last_Name: first.family };
  const emails = [], seenE = new Set();
  const phones = [], seenP = new Set();
  const labels = new Set(), notes = new Set(), addresses = new Map();
  for (const m of members) {
    for (const e of m.emails) { const k = e.value.toLowerCase(); if (!seenE.has(k)) { seenE.add(k); emails.push(k); } }
    for (const p of m.phones) { const k = comparablePhone(p.value); if (!seenP.has(k)) { seenP.add(k); phones.push(p); } }
    m.labels.forEach((l) => labels.add(l));
    if (m.notes) notes.add(m.notes);
    for (const a of m.addresses) addresses.set(`${a.street}|${a.city}|${a.region}|${a.postal}|${a.country}`, a);
    if (m.org && !r.Account_Name) r.Account_Name = { name: m.org };
    if (m.title && !r.Title) r.Title = m.title;
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
  const addr = [...addresses.values()];
  const put = (a, prefix) => { r[`${prefix}_Street`] = a.street; r[`${prefix}_City`] = a.city; r[`${prefix}_State`] = a.region; r[`${prefix}_Zip`] = a.postal; r[`${prefix}_Country`] = a.country; };
  if (addr[0]) put(addr[0], 'Mailing');
  if (addr[1]) put(addr[1], 'Other');
  if (addr.length > 2) r.Google_Extra_Addresses = addr.slice(2).map((a) => `${a.street}|${a.city}|${a.region}|${a.postal}|${a.country}`).join('; ');
  r.Google_Source_IDs = members.map((m) => `demo|${m.source_id}`).join(';');
  return r;
}
