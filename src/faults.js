// Named faults. Each one damages a copy, then the unchanged check is run on it.
import { sourceIdsOf } from './verify.js';

const clone = (x) => structuredClone(x);
const recordOf = (reference, readback, name) => {
  const person = Object.values(reference.people).find((p) => p.name === name);
  return readback.find((r) => sourceIdsOf(r).includes(person.sources[0]));
};

// The held copy: the slot holding one person now holds a second copy of another. Row count unchanged.
export function replacePersonWithDuplicate(reference, readback, goneName, twiceName) {
  const gone = recordOf(reference, readback, goneName), twice = recordOf(reference, readback, twiceName);
  const patch = { record_id: gone.id, record: { ...clone(twice), id: gone.id } };
  return { patch, readback: applyPatch(readback, patch) };
}
export const applyPatch = (readback, patch) => readback.map((r) => (r.id === patch.record_id ? patch.record : r));

const firstWith = (rb, test) => rb.findIndex(test);

export const FAULTS = {
  'lost-third-email': (s) => {
    const i = firstWith(s.readback, (r) => r.Google_Extra_Emails);
    const rec = s.readback[i], parts = rec.Google_Extra_Emails.split('; ');
    parts.pop(); rec.Google_Extra_Emails = parts.join('; ');
    if (!rec.Google_Extra_Emails) delete rec.Google_Extra_Emails;
  },
  'lost-extension': (s) => {
    const i = firstWith(s.readback, (r) => /ext\./.test(r.Phone ?? ''));
    s.readback[i].Phone = s.readback[i].Phone.replace(/\s*ext\.\s*\d+/, '');
  },
  'lost-label': (s) => {
    const i = firstWith(s.readback, (r) => (r.Google_Labels ?? '').includes('; '));
    const parts = s.readback[i].Google_Labels.split('; '); parts.pop(); s.readback[i].Google_Labels = parts.join('; ');
  },
  'lost-and-doubled': (s) => {
    const i = firstWith(s.readback, (r) => r.Email && r.Secondary_Email);
    s.readback[i].Secondary_Email = s.readback[i].Email;
  },
  'open-case': (s) => {
    const row = s.decisionLog.rows.find((r) => r.decision === 'merged');
    const person = s.reference.people[s.reference.sources[row.source_id].person];
    s.openCases.push({ source_id: row.source_id, name: person.name, reason: 'Someone asked to review this merge first.', identifiers: [] });
  },
  'archive-altered': (s) => { s.archive.actual = { ...s.archive.actual, 'google-contacts.csv': s.archive.actual['google-contacts.csv'].replace(/^./, (c) => (c === '0' ? '1' : '0')) }; },
};

export const FAULT_NAMES = [...Object.keys(FAULTS), 'wrong-merge'];

export function applyFault(name, state) {
  const s = { ...state, readback: clone(state.readback), openCases: clone(state.openCases), archive: clone(state.archive), decisionLog: state.decisionLog };
  FAULTS[name](s);
  return s;
}
