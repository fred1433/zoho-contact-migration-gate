// Import and read-back against any object with Zoho's request shape. Today that object is the local stand-in.
import { createHash } from 'node:crypto';
import { migrate } from './migrate.js';
import { ZohoStandIn } from './zoho-standin.js';

export const READ_FIELDS = ['First_Name', 'Last_Name', 'Email', 'Secondary_Email', 'Phone', 'Mobile', 'Home_Phone', 'Other_Phone', 'Title', 'Account_Name', 'Description', 'Salutation', 'Department', 'Date_of_Birth',
  'Mailing_Street', 'Mailing_City', 'Mailing_State', 'Mailing_Zip', 'Mailing_Country', 'Other_Street', 'Other_City', 'Other_State', 'Other_Zip', 'Other_Country',
  'Google_Source_IDs', 'Google_Extra_Emails', 'Google_Extra_Phones', 'Google_Extra_Addresses', 'Google_Extra_Values', 'Google_Labels', 'Google_Middle_Name', 'Google_Name_Suffix', 'Google_Nickname', 'Google_Phonetic_First', 'Google_Phonetic_Middle', 'Google_Phonetic_Last', 'Google_File_As'];

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const fingerprint = ({ csv, ids, zoho }) => ({ 'google-contacts.csv': sha256(csv), 'google-contact-ids.json': sha256(ids), 'zoho-snapshot.json': sha256(zoho) });

const MAX_RATE_RETRIES = 5;

// A 429 refuses the whole call, nothing was written, so the same call is sent again. A real run would wait for the time Zoho gives.
function send(api, method, path, data, stats) {
  for (let i = 0; ; i++) {
    const res = api.request(method, path, { data });
    if (res.status !== 429) return res;
    stats.rate_retries++;
    if (i === MAX_RATE_RETRIES) { const e = new Error(`Rate limited ${MAX_RATE_RETRIES + 1} times in a row. Rerun: records already written are found by source ID and not sent twice.`); e.code = 'RATE_LIMITED'; throw e; }
  }
}

// Writes in batches of 100 at most, reads each result on its own. Before any replay it reads the target,
// because an error reply does not prove the write failed.
export function writeBatches(api, method, path, records, { replays = 1 } = {}) {
  const done = [], rejected = [], stats = { rate_retries: 0, found_before_replay: 0 };
  let queue = records, largest = 0, replayed = 0;
  for (let attempt = 0; attempt <= replays && queue.length; attempt++) {
    const failedNow = [];
    for (let i = 0; i < queue.length; i += 100) {
      const batch = queue.slice(i, i + 100);
      largest = Math.max(largest, batch.length);
      const { body } = send(api, method, path, batch.map((b) => b.payload), stats);
      if (!body.data) { for (const b of batch) failedNow.push({ ...b, code: body.code }); continue; }
      body.data.forEach((res, j) => {
        if (res.status === 'success') done.push({ ...batch[j], id: res.details.id });
        else failedNow.push({ ...batch[j], code: res.code, field: res.details?.api_name });
      });
    }
    if (attempt < replays && failedNow.length) {
      const present = failedNow.some((f) => f.payload.Google_Source_IDs) ? sourceKeysInTarget(api) : new Map();
      queue = [];
      for (const f of failedNow) {
        const id = present.get(f.payload.Google_Source_IDs);
        if (id) { stats.found_before_replay++; done.push({ ...f, id }); } else { queue.push(f); replayed++; }
      }
    } else queue = failedNow;
  }
  rejected.push(...queue);
  return { done, rejected, largest, replayed, ...stats };
}

function readPages(api, fields) {
  const out = [];
  let pages = 0, token = null, last = { count: 0, more_records: false };
  for (;;) {
    const params = { fields, per_page: 200, ...(token ? { page_token: token } : { page: 1 }) };
    const { status, body } = api.request('GET', '/Contacts', { params });
    if (status === 204) break; // Zoho documents an empty reply when there is nothing to list.
    if (status !== 200) throw new Error(`Read-back stopped: ${body.code}`);
    out.push(...body.data);
    pages++;
    last = { count: body.info.count, more_records: body.info.more_records };
    token = body.info.next_page_token;
    if (!body.info.more_records) break;
    if (!token) throw new Error('Read-back stopped: more records announced and no page token given.');
  }
  return { out, pages, last };
}

// What is already there, by source key, so that a rerun or a replay never creates a record twice.
export function sourceKeysInTarget(api) {
  const { out } = readPages(api, ['Google_Source_IDs']);
  return new Map(out.filter((r) => r.Google_Source_IDs).map((r) => [r.Google_Source_IDs, r.id]));
}

export function readBack(api, known = new Set()) {
  const { out, pages, last } = readPages(api, READ_FIELDS);
  // Notes live on a related list, so they are read one record at a time, only where the snapshot says a note exists.
  for (const rec of out) {
    if (!known.has(rec.id)) continue;
    const { body } = api.request('GET', `/Contacts/${rec.id}/Notes`);
    rec.Notes = body.data.map((n) => n.Note_Content);
  }
  return { records: out, pages, last_page: last };
}

// Accounts come first, so that a new contact links to an account ID and not just to a name.
function linkAccounts(api, payloads) {
  const names = [...new Set(payloads.filter((p) => p.Account_Name && !p.Account_Name.id).map((p) => p.Account_Name.name))];
  const ids = new Map();
  const stats = { rate_retries: 0 };
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const { body } = send(api, 'POST', '/Accounts', batch.map((name) => ({ Account_Name: name })), stats);
    (body.data ?? []).forEach((res, j) => { if (res.status === 'success') ids.set(batch[j], res.details.id); });
  }
  for (const p of payloads) if (p.Account_Name && !p.Account_Name.id && ids.has(p.Account_Name.name)) p.Account_Name = { name: p.Account_Name.name, id: ids.get(p.Account_Name.name) };
  return ids.size;
}

export function rehearse({ csv, ids, zoho }, opts = {}) {
  const idList = JSON.parse(ids), zohoList = JSON.parse(zoho);
  const archiveFingerprint = fingerprint({ csv, ids, zoho });
  const { decisionLog, targets, pending } = migrate({ csv, ids: idList, zoho: zohoList, archiveFingerprint }, opts);
  const api = opts.api ?? new ZohoStandIn(zohoList);
  const already = sourceKeysInTarget(api);
  const updates = targets.filter((t) => t.existing_id).map((t) => ({ ...t, payload: structuredClone(t.update) }));
  const creates = targets.filter((t) => !t.existing_id).map((t) => ({ ...t, payload: structuredClone(t.record) }));
  const toCreate = creates.filter((t) => !already.has(t.record.Google_Source_IDs));
  const accountsCreated = linkAccounts(api, [...updates, ...toCreate].map((t) => t.payload));
  const u = writeBatches(api, 'PUT', '/Contacts', updates);
  const c = writeBatches(api, 'POST', '/Contacts', toCreate);
  const back = readBack(api, new Set(zohoList.map((z) => z.id)));
  const receipt = {
    target: 'local stand-in built from the Zoho API documentation, not Zoho',
    created: c.done.length - c.found_before_replay, updated: u.done.length, rejected: c.rejected.length + u.rejected.length, replayed: c.replayed + u.replayed,
    already_present: creates.length - toCreate.length, found_before_replay: c.found_before_replay + u.found_before_replay, rate_retries: c.rate_retries + u.rate_retries,
    accounts_created: accountsCreated, largest_write_batch: Math.max(c.largest, u.largest), records_read_back: back.records.length, pages_read: back.pages,
    last_page: back.last_page, merge_calls: api.calls.filter((k) => /merge/i.test(k.path)).length, delete_calls: api.calls.filter((k) => k.method === 'DELETE').length,
    calls: api.calls.length,
  };
  return { decisionLog, targets, pending, readback: back.records, receipt, callLog: api.calls, api };
}

export const openCasesFrom = (pending) => pending.map(({ source_id, reason, name, identifiers }) => ({ source_id, reason, name, identifiers }));
