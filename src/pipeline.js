// Import and read-back against any object with Zoho's request shape. Today that object is the local stand-in.
import { createHash } from 'node:crypto';
import { migrate } from './migrate.js';
import { ZohoStandIn } from './zoho-standin.js';

export const READ_FIELDS = ['First_Name', 'Last_Name', 'Email', 'Secondary_Email', 'Phone', 'Mobile', 'Home_Phone', 'Other_Phone', 'Title', 'Account_Name', 'Description',
  'Mailing_Street', 'Mailing_City', 'Mailing_State', 'Mailing_Zip', 'Mailing_Country', 'Other_Street', 'Other_City', 'Other_State', 'Other_Zip', 'Other_Country',
  'Google_Source_IDs', 'Google_Extra_Emails', 'Google_Extra_Phones', 'Google_Extra_Addresses', 'Google_Labels'];

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const fingerprint = ({ csv, ids, zoho }) => ({ 'google-contacts.csv': sha256(csv), 'google-contact-ids.json': sha256(ids), 'zoho-snapshot.json': sha256(zoho) });

// Writes in batches of 100 at most, reads each result on its own, replays only what failed.
export function writeBatches(api, method, path, records, { replays = 1 } = {}) {
  const done = [], rejected = [];
  let queue = records, largest = 0, replayed = 0;
  for (let attempt = 0; attempt <= replays && queue.length; attempt++) {
    const failedNow = [];
    for (let i = 0; i < queue.length; i += 100) {
      const batch = queue.slice(i, i + 100);
      largest = Math.max(largest, batch.length);
      const { body } = api.request(method, path, { data: batch.map((b) => b.record) });
      if (!body.data) throw new Error(`Whole batch refused: ${body.code}`);
      body.data.forEach((res, j) => {
        if (res.status === 'success') done.push({ ...batch[j], id: res.details.id });
        else failedNow.push({ ...batch[j], code: res.code, field: res.details?.api_name });
      });
    }
    if (attempt < replays && failedNow.length) replayed += failedNow.length;
    queue = failedNow;
  }
  rejected.push(...queue);
  return { done, rejected, largest, replayed };
}

export function readBack(api, known = new Set()) {
  const out = [];
  let pages = 0, token = null, last = null;
  for (;;) {
    const params = { fields: READ_FIELDS, per_page: 200, ...(token ? { page_token: token } : { page: 1 }) };
    const { status, body } = api.request('GET', '/Contacts', { params });
    if (status !== 200) throw new Error(`Read-back stopped: ${body.code}`);
    out.push(...body.data);
    pages++;
    last = { count: body.info.count, more_records: body.info.more_records };
    token = body.info.next_page_token;
    if (!body.info.more_records) break;
  }
  // Notes live on a related list, so they are read one record at a time, only where the snapshot says a note exists.
  for (const rec of out) {
    if (!known.has(rec.id)) continue;
    const { body } = api.request('GET', `/Contacts/${rec.id}/Notes`);
    rec.Notes = body.data.map((n) => n.Note_Content);
  }
  return { records: out, pages, last_page: last };
}

export function rehearse({ csv, ids, zoho }, opts = {}) {
  const idList = JSON.parse(ids), zohoList = JSON.parse(zoho);
  const archiveFingerprint = fingerprint({ csv, ids, zoho });
  const { decisionLog, targets, pending } = migrate({ csv, ids: idList, zoho: zohoList, archiveFingerprint }, opts);
  const api = opts.api ?? new ZohoStandIn(zohoList);
  const updates = targets.filter((t) => t.existing_id).map((t) => ({ ...t, record: { id: t.existing_id, ...t.record } }));
  const creates = targets.filter((t) => !t.existing_id);
  const u = writeBatches(api, 'PUT', '/Contacts', updates);
  const c = writeBatches(api, 'POST', '/Contacts', creates);
  const back = readBack(api, new Set(zohoList.map((z) => z.id)));
  const receipt = {
    target: 'local stand-in built from the Zoho API documentation, not Zoho',
    created: c.done.length, updated: u.done.length, rejected: c.rejected.length + u.rejected.length, replayed: c.replayed + u.replayed,
    largest_write_batch: Math.max(c.largest, u.largest), records_read_back: back.records.length, pages_read: back.pages,
    last_page: back.last_page, merge_calls: api.calls.filter((k) => /merge/i.test(k.path)).length, delete_calls: api.calls.filter((k) => k.method === 'DELETE').length,
    calls: api.calls.length,
  };
  return { decisionLog, targets, pending, readback: back.records, receipt, callLog: api.calls, api };
}

export const openCasesFrom = (pending) => pending.map(({ source_id, reason, name, identifiers }) => ({ source_id, reason, name, identifiers }));
