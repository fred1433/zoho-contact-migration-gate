// Restore drill: can one record, with its note and its relation, come back from the archive in an isolated copy?
// A fingerprint only shows the archive has not changed. This drill is the part that tests recovery.
import { ZohoStandIn } from './zoho-standin.js';

export const NOT_COVERED = ['contact photos', 'Zoho attachments', 'Zoho activities and emails', 'Zoho custom modules', 'Google "Other contacts"'];

export function inventory({ csvRows, zoho }) {
  return {
    google: { contacts: csvRows, covered: ['names', 'emails', 'phones', 'addresses', 'organization', 'notes', 'labels'] },
    zoho: { contacts: zoho.length, notes: zoho.reduce((n, z) => n + z.Notes.length, 0), account_links: zoho.filter((z) => z.Account_Name).length, covered: ['contacts', 'notes', 'account links'] },
    not_covered: NOT_COVERED,
  };
}

export function restoreDrill(zoho, name = 'Priya Nair') {
  const original = zoho.find((z) => `${z.First_Name} ${z.Last_Name}` === name);
  if (!original) throw new Error(`Nobody called ${name} in the snapshot`);
  const isolated = new ZohoStandIn(zoho);
  const del = isolated.request('DELETE', `/Contacts/${original.id}`);
  if (del.status !== 200) throw new Error('Could not delete in the isolated copy');
  const { Notes, id: oldId, ...fields } = original;
  const ins = isolated.request('POST', '/Contacts', { data: [fields] });
  const newId = ins.body.data[0].details.id;
  isolated.request('POST', `/Contacts/${newId}/Notes`, { data: Notes.map((n) => ({ Note_Content: n })) });
  const back = isolated.records.get(newId);
  const noteBack = isolated.request('GET', `/Contacts/${newId}/Notes`).body.data.map((n) => n.Note_Content);
  return {
    target: 'isolated local stand-in, not Zoho', name, old_id: oldId, new_id: newId,
    id_changed: oldId !== newId,
    note_restored: JSON.stringify(noteBack) === JSON.stringify(Notes),
    relation_restored: back.Account_Name?.name === original.Account_Name?.name && Boolean(back.Account_Name),
    fields_restored: Object.keys(fields).every((k) => JSON.stringify(back[k]) === JSON.stringify(fields[k])),
    not_covered: NOT_COVERED,
  };
}
