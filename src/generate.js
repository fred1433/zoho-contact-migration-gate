// Builds the fictional address book. The plan (who is who) is decided here, before any migration code runs,
// which is what makes reference/reference.json independent of src/migrate.js.
import { toCsv } from './csv.js';

const BASE = ['First Name', 'Middle Name', 'Last Name', 'Phonetic First Name', 'Phonetic Middle Name', 'Phonetic Last Name',
  'Name Prefix', 'Name Suffix', 'Nickname', 'File As', 'Organization Name', 'Organization Title', 'Organization Department',
  'Birthday', 'Notes', 'Photo', 'Labels'];
const ADDRESS_PARTS = ['Formatted', 'Street', 'City', 'PO Box', 'Region', 'Postal Code', 'Country', 'Extended Address'];

const GIVEN = ('Ada Adrian Aisha Alan Alicia Amara Amir Ana Andre Anika Anton Arjun Astrid Aya Beatriz Ben Bianca Boris Bruno Caleb Camila Carla Carlos Chloe Clara Cora Daniel Dara Dmitri Elena Eli Elif Emma Erik Esther Farah Felix Fiona Gabriel Grace Greta Hana Hector Helen Henry Hugo Ida Imani Ines Ingrid Ivan Jada Jamal Jana Jasper Jin Joan Jonas José Julia Kai Kamal Kara Karim Kenji Keiko Laila Lars Lena Leo Lina Lucas Lucia Luis Mabel Malik Marco Maria Marta Mateo Mei Mina Miguel Mira Nadia Naomi Nia Nico Nina Noor Olga Omar Oscar Paula Pedro Petra Quinn Rafael Rana Raul Rosa Ruth Sami Sana Sara Sean Selin Simon Sofia Tara Teo Tomas Uma Vera Victor Wei Yara Yuki Yusuf Zara Zoe').split(' ');
const FAMILY = ('Abara Abbott Acosta Adeyemi Ahmed Aguilar Alvarez Andersen Aoki Arslan Baker Banerjee Barros Bauer Becker Bell Bianchi Bishop Blanco Bose Boyd Brandt Brooks Cabrera Campos Carter Castro Chandra Chavez Cho Clarke Cohen Costa Cruz Dang Das Davies Delgado Dias Dogan Dubois Duarte Eaton Egan Ellis Engel Erikson Evans Farah Fernandez Fischer Flores Fontaine Foster Fujita Garcia Gill Gomez Graham Greene Gupta Haddad Hall Hansen Hayes Herrera Hoang Holm Howard Hughes Ibrahim Ito Ivanov Jansen Jensen Jimenez Johal Kaya Keller Khan Kim Klein Koch Kovacs Kumar Lam Larsen Le Leon Lindholm Lopez Lund Mahmoud Marin Martins Mehta Mendez Moreau Mori Muller Murphy Nakamura Navarro Nguyen Nilsson Núñez Obi Okafor Oliveira Ortiz Osei Park Patel Pereira Petrov Pham Quinn Rahman Ramos Rao Reyes Rivera Rossi Roy Saito Salazar Santos Sato Schmidt Sharma Silva Singh Soto Stein Suarez Sullivan Suzuki Tan Tanaka Torres Tran Turner Vargas Vega Vogel Wagner Walsh Wang Weber Wong Yamada Yilmaz Young Zhang Zimmer').split(' ');
const ORGS = ['Harbor Street Clinic', 'North Fork Supply', 'Larkspur Print Co', 'Bluestem Accounting', 'Cedar Row Studio', 'Fifth Avenue Tailors', 'Quarry Lane Books', 'Oak and Iron Works', 'Tidewater Freight', 'Sable Point Press'];
const TITLES = ['Owner', 'Office manager', 'Bookkeeper', 'Director', 'Partner', 'Coordinator'];
const LABELS = ['Clients', 'Vendors', 'Newsletter', 'Family', 'Old leads', 'Board', 'Events', 'Referrals', 'Press', 'Alumni', 'Volunteers', 'Follow up', 'Past clients', 'Partners', 'Holiday cards', 'Do not call'];
const CITIES = [['Springfield', 'IL', '62701'], ['Madison', 'WI', '53703'], ['Salem', 'OR', '97301'], ['Dover', 'DE', '19901'], ['Helena', 'MT', '59601'], ['Albany', 'NY', '12207']];
// Fictional numbers only: 555-0100 to 555-0199, across many area codes so that 100 numbers do not collide constantly.
// 707 is left out on purpose.
const AREAS = [201, 202, 203, 205, 206, 207, 208, 212, 213, 214, 215, 216, 217, 218, 219, 224, 225, 228, 229, 231, 234, 239, 240, 248, 251, 252, 253, 254, 256, 260, 262, 267, 269, 270, 276, 281, 301, 302, 303, 304, 305, 307, 308, 309, 310, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 323, 325, 330, 334, 336];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function formatPhone(area, line, style, ext = '') {
  const suffix = ext ? ` ext. ${ext}` : '';
  const forms = [`(${area}) 555-${line}`, `${area}-555-${line}`, `+1 ${area} 555 ${line}`, `${area}.555.${line}`, `1-${area}-555-${line}`];
  return forms[style % forms.length] + suffix;
}
export const phoneTruth = (area, line, ext = '') => `+1${area}555${line}${ext ? `x${ext}` : ''}`;

export function makePlan(seed = 20261108) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const plan = [];
  let counter = 0, personNo = 0;
  const reserved = new Set(['maya chen', 'alex reed', 'priya nair', 'dev nair']);
  const usedPhone = new Set();

  const email = (given, family) => { counter++; return `${ascii(given)}.${ascii(family).replace(/[^a-z]/g, '')}.${counter}@example.com`; };
  const newPhone = (given, family, label = 'Mobile', ext = '') => {
    for (;;) {
      const area = pick(AREAS), line = String(100 + Math.floor(r() * 100)).padStart(4, '0');
      const key = `${ascii(given + ' ' + family)}|${area}${line}`;
      if (usedPhone.has(key)) continue;
      usedPhone.add(key);
      return { label, value: formatPhone(area, line, Math.floor(r() * 5), ext), truth: phoneTruth(area, line, ext), area, line };
    }
  };
  const nextPerson = () => `P-${String(++personNo).padStart(5, '0')}`;
  const blank = (given, family) => ({ given, family, middle: '', prefix: '', suffix: '', org: '', title: '', notes: '', labels: [], emails: [], phones: [], addresses: [] });
  const randomName = () => {
    for (;;) { const g = pick(GIVEN), f = pick(FAMILY); if (!reserved.has(ascii(`${g} ${f}`))) return [g, f]; }
  };
  const person = () => {
    const [g, f] = randomName();
    const c = blank(g, f);
    if (r() < 0.97) c.emails.push({ label: pick(['Work', 'Home', 'Other']), value: email(g, f) });
    if (r() < 0.14) c.phones.push(newPhone(g, f, pick(['Mobile', 'Work', 'Home'])));
    if (r() < 0.3) c.org = pick(ORGS);
    if (c.org && r() < 0.5) c.title = pick(TITLES);
    if (r() < 0.25) c.labels.push(pick(LABELS));
    if (r() < 0.08) c.labels.push(pick(LABELS));
    c.labels = [...new Set(c.labels)];
    if (r() < 0.06) c.notes = pick(['Met at the spring dinner.', 'Prefers email.', 'Asked to be called after 3pm.', 'Sent the holiday card.']);
    if (r() < 0.05) c.middle = pick(['J.', 'Lee', 'Marie']);
    if (r() < 0.04) c.prefix = 'Dr.';
    if (r() < 0.12) { const [city, st, zip] = pick(CITIES); c.addresses.push({ label: 'Home', street: `${100 + Math.floor(r() * 8900)} Elm St`, city, region: st, postal: zip, country: 'US' }); }
    return c;
  };
  const differentGiven = (a) => { for (;;) { const b = person(); if (b.given !== a.given) return b; } };
  const add = (contact, personId, kind = 'person', reason = '') => plan.push({ contact, person: personId, kind, reason });

  // Named cases used by the sheet and the shared-identifier test.
  const maya = blank('Maya', 'Chen');
  maya.emails.push({ label: 'Work', value: 'maya.chen@example.com' });
  maya.emails.push({ label: 'Home', value: 'maya.c.home@example.com' });
  maya.phones.push({ label: 'Mobile', value: formatPhone(415, '0142', 0), truth: phoneTruth(415, '0142') });
  maya.org = 'Larkspur Print Co'; maya.title = 'Owner'; maya.labels = ['Clients']; maya.notes = 'Prefers email.';
  add(maya, nextPerson());
  const alex = blank('Alex', 'Reed');
  alex.emails.push({ label: 'Work', value: 'alex.reed@example.com' });
  alex.phones.push({ label: 'Work', value: formatPhone(312, '0177', 1, '204'), truth: phoneTruth(312, '0177', '204') });
  alex.org = 'Tidewater Freight'; alex.labels = ['Vendors', 'Follow up'];
  add(alex, nextPerson());
  const priya = blank('Priya', 'Nair');
  priya.emails.push({ label: 'Home', value: 'nair.family@example.com' });
  priya.org = 'Harbor Street Clinic';
  const priyaId = nextPerson(); add(priya, priyaId);
  const dev = blank('Dev', 'Nair');
  dev.emails.push({ label: 'Home', value: 'nair.family@example.com' });
  add(dev, nextPerson());

  // Pairs of different people on one email (family, front desk) or one landline.
  for (let i = 0; i < 40; i++) {
    const a = person(), b = differentGiven(a);
    const shared = email(`shared${i}`, 'desk');
    a.emails = [{ label: 'Home', value: shared }]; b.emails = [{ label: 'Home', value: shared }];
    b.family = a.family;
    add(a, nextPerson()); add(b, nextPerson());
  }
  for (let i = 0; i < 25; i++) {
    const a = person(), b = differentGiven(a);
    const p = newPhone(`landline${i}`, 'x', 'Home');
    a.phones = [p]; b.phones = [{ ...p, value: formatPhone(p.area, p.line, (i % 4) + 1) }];
    b.family = a.family;
    add(a, nextPerson()); add(b, nextPerson());
  }
  // More values than Zoho has standard slots for.
  for (let i = 0; i < 30; i++) {
    const c = person();
    c.emails = [1, 2, 3, 4, 5].map((n) => ({ label: n % 2 ? 'Work' : 'Other', value: email(c.given + n, c.family) }));
    c.phones = ['Mobile', 'Work', 'Home', 'Other', 'Work', 'Mobile'].map((l) => newPhone(c.given, c.family, l, i % 3 === 0 && l === 'Work' ? String(100 + i) : ''));
    add(c, nextPerson());
  }
  // Two emails in one cell, the way a Google export writes them.
  for (let i = 0; i < 15; i++) {
    const c = person();
    c.emails = [{ label: 'Work', value: `${email(c.given, c.family)} ::: ${email(c.given + 'x', c.family)}` }];
    add(c, nextPerson());
  }
  // More labels than Zoho tags allow per record.
  for (let i = 0; i < 12; i++) {
    const c = person(); c.labels = LABELS.slice(0, 14); add(c, nextPerson());
  }
  // Several postal addresses.
  for (let i = 0; i < 40; i++) {
    const c = person();
    c.addresses = [1, 2, 3].map((n) => { const [city, st, zip] = pick(CITIES); return { label: n === 1 ? 'Home' : 'Work', street: `${n}${100 + i} Pine Ave`, city, region: st, postal: zip, country: 'US' }; });
    add(c, nextPerson());
  }
  // Phone extensions.
  for (let i = 0; i < 60; i++) {
    const c = person(); c.phones = [newPhone(c.given, c.family, 'Work', String(200 + i))]; add(c, nextPerson());
  }

  const individualsSoFar = plan.length;
  for (let i = individualsSoFar; i < 10780; i++) add(person(), nextPerson());

  // 100 merge groups of two: same person, entered twice.
  for (let i = 0; i < 100; i++) {
    const a = person();
    if (!a.emails.length) a.emails.push({ label: 'Work', value: email(a.given, a.family) });
    const id = nextPerson();
    const b = blank(i % 2 ? a.given.toUpperCase() : a.given, i % 2 ? a.family.toUpperCase() : a.family);
    if (i % 3 === 2) {
      const p = newPhone(a.given, a.family, 'Mobile');
      a.phones = [p];
      b.phones = [{ ...p, value: formatPhone(p.area, p.line, (i % 4) + 1) }];
      b.emails = [{ label: 'Other', value: email(a.given + 'alt', a.family) }];
    } else {
      b.emails = [{ label: 'Work', value: a.emails[0].value.toUpperCase() }];
      if (i % 2) b.emails.push({ label: 'Other', value: email(a.given + 'alt', a.family) });
    }
    b.labels = [LABELS[i % LABELS.length]];
    if (i % 5 === 0) b.notes = 'Added from an old phone.';
    a.org = a.org || ''; b.org = a.org; b.title = a.title;
    add(a, id); add(b, id);
  }

  // 20 exclusions, each with a written reason.
  for (let i = 0; i < 14; i++) add(blank('', ''), null, 'excluded', 'empty');
  for (let i = 0; i < 6; i++) { const c = blank('', ''); c.labels = [LABELS[i]]; add(c, null, 'excluded', 'label_only'); }

  // Stable shuffle, then 80 records already in Zoho.
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  plan.forEach((e, i) => { e.source_id = `c${7100000000000 + i + 1}`; });

  const zoho = [];
  const zohoFrom = (e, note, withAccount) => {
    const c = e.contact;
    zoho.push({ id: String(5725767000000100000n + BigInt(zoho.length + 1)), First_Name: c.given, Last_Name: c.family, Email: c.emails[0].value,
      ...(withAccount && c.org ? { Account_Name: { name: c.org, id: String(5725767000000900000n + BigInt(zoho.length + 1)) } } : {}), Notes: [note] });
  };
  const priyaEntry = plan.find((e) => e.person === priyaId);
  zohoFrom(priyaEntry, 'Asked for the spring invoice to go to the clinic.', true);
  const groupMembers = new Set(); const seen = new Map();
  for (const e of plan) { if (!e.person) continue; if (seen.has(e.person)) groupMembers.add(e.person); seen.set(e.person, true); }
  const sharedEmails = new Map();
  for (const e of plan) for (const m of e.contact.emails) for (const v of m.value.split(' ::: ')) sharedEmails.set(v.toLowerCase(), (sharedEmails.get(v.toLowerCase()) || 0) + 1);
  for (const e of plan) {
    if (zoho.length >= 80) break;
    if (e.kind !== 'person' || groupMembers.has(e.person) || e === priyaEntry) continue;
    const c = e.contact;
    if (!c.emails.length || ['maya chen', 'alex reed'].includes(ascii(`${c.given} ${c.family}`))) continue;
    if (c.emails[0].value.includes(' ::: ') || sharedEmails.get(c.emails[0].value.toLowerCase()) > 1) continue;
    zohoFrom(e, 'Existing Zoho note, kept as is.', zoho.length % 4 === 0);
    e.zoho_id = zoho[zoho.length - 1].id;
  }
  priyaEntry.zoho_id = zoho[0].id;
  return { plan, zoho };
}

// Writes the plan out in the column layout of a Google Contacts export.
export function renderArchive({ plan, zoho }) {
  const nE = Math.max(1, ...plan.map((e) => e.contact.emails.length));
  const nP = Math.max(1, ...plan.map((e) => e.contact.phones.length));
  const nA = Math.max(1, ...plan.map((e) => e.contact.addresses.length));
  const header = [...BASE];
  for (let i = 1; i <= nE; i++) header.push(`E-mail ${i} - Label`, `E-mail ${i} - Value`);
  for (let i = 1; i <= nP; i++) header.push(`Phone ${i} - Label`, `Phone ${i} - Value`);
  for (let i = 1; i <= nA; i++) { header.push(`Address ${i} - Label`); for (const p of ADDRESS_PARTS) header.push(`Address ${i} - ${p}`); }
  const rows = [header];
  for (const { contact: c } of plan) {
    const row = [c.given, c.middle, c.family, '', '', '', c.prefix, c.suffix, '', '', c.org, c.title, '', '', c.notes, '', [...c.labels, '* myContacts'].join(' ::: ')];
    for (let i = 0; i < nE; i++) row.push(c.emails[i]?.label ?? '', c.emails[i]?.value ?? '');
    for (let i = 0; i < nP; i++) row.push(c.phones[i]?.label ?? '', c.phones[i]?.value ?? '');
    for (let i = 0; i < nA; i++) {
      const a = c.addresses[i];
      if (!a) { row.push('', '', '', '', '', '', '', '', ''); continue; }
      row.push(a.label, `${a.street}, ${a.city} ${a.region} ${a.postal}`, a.street, a.city, '', a.region, a.postal, a.country, '');
    }
    rows.push(row);
  }
  return {
    csv: toCsv(rows),
    ids: JSON.stringify(plan.map((e) => e.source_id)),
    zoho: JSON.stringify(zoho),
  };
}

// The answer key. It reads the plan, never the CSV, so a bug in parsing or merging cannot also bend the key.
export function referenceFromPlan({ plan, zoho }) {
  const sources = {}, people = {};
  const byZoho = new Map(zoho.map((z) => [z.id, z]));
  for (const e of plan) {
    if (e.kind === 'excluded') { sources[e.source_id] = { kind: 'excluded', reason: e.reason }; continue; }
    if (e.kind === 'pending') { sources[e.source_id] = { kind: 'pending', reason: e.reason }; continue; }
    sources[e.source_id] = { kind: 'person', person: e.person };
    const p = people[e.person] ??= { name: `${e.contact.given} ${e.contact.family}`, sources: [], values: [] };
    p.sources.push(e.source_id);
    const c = e.contact, v = new Set(p.values);
    v.add(`name:${ascii(p.name)}`);
    for (const m of c.emails) for (const x of m.value.split(' ::: ')) v.add(`email:${x.toLowerCase()}`);
    for (const m of c.phones) v.add(`phone:${m.truth}`);
    for (const l of c.labels) v.add(`label:${l}`);
    if (c.org) v.add(`org:${c.org}`);
    if (c.title) v.add(`title:${c.title}`);
    if (c.notes) v.add(`note:${c.notes}`);
    for (const a of c.addresses) v.add(`address:${a.street}|${a.city}|${a.region}|${a.postal}|${a.country}`);
    if (e.zoho_id) { p.zoho_id = e.zoho_id; for (const n of byZoho.get(e.zoho_id).Notes) v.add(`zoho_note:${n}`); }
    p.values = [...v];
  }
  return { sources, people };
}

export const generate = (seed) => {
  const planned = makePlan(seed);
  return { ...renderArchive(planned), reference: referenceFromPlan(planned), planned };
};
