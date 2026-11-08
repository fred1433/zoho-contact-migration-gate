// SIMULATED. Nothing here talks to Google, Zapier or Zoho. It models the limits Zapier documents for Google Contacts
// (see docs/sources.md) so that the plan in docs/sync-plan.md can be tested before anyone turns a Zap on.
import { createHash } from 'node:crypto';

export const POLL_LIMIT = 50;
export const SYNCED_FIELDS = ['First_Name', 'Last_Name', 'Email', 'Phone', 'Google_Labels'];
export const ZOHO_OWNED_FIELDS = ['Owner', 'Lead_Source', 'Description'];

export function fingerprintOf(rec, fields = SYNCED_FIELDS) {
  return createHash('sha256').update(JSON.stringify(fields.map((f) => rec[f] ?? ''))).digest('hex');
}

// Which key to match on. A text field is the fallback, and it is not the same thing as External ID.
export function matchKeyFor(edition) {
  if (['Enterprise', 'Ultimate'].includes(edition)) return { field: 'External_ID', native_external_id: true };
  return { field: 'Google_Contact_ID', native_external_id: false, note: 'Custom unique text field holding account + source ID. Not equivalent to External ID.' };
}

export class SyncSim {
  constructor(account = 'demo') {
    this.account = account;
    this.google = new Map();   // source ID -> contact
    this.zoho = new Map();     // zoho ID -> record
    this.map = new Map();      // account|source ID -> zoho ID (the durable correspondence)
    this.prints = new Map();   // key -> fingerprint of the last synced state
    this.lastSynced = new Map(); // key -> last synced contact, to detect two-sided edits
    this.review = [];
    this.changes = [];         // pending Google events, oldest first
    this.writes = { zoho_created: 0, zoho_updated: 0, google_written: 0 };
    this.nextZoho = 1;
    this.halted = false;
  }
  key(id) { return `${this.account}|${id}`; }

  googleSave(id, contact) {
    this.google.set(id, { ...contact });
    this.changes.push(id);
  }
  googleDelete(id) { this.google.delete(id); } // Zapier documents no delete trigger, so no event is produced.

  // A polling read: at most POLL_LIMIT items, the most recent ones. What is older than that is missed.
  poll() {
    const unique = [...new Set(this.changes)];
    const seen = unique.slice(-POLL_LIMIT);
    this.changes = [];
    return seen.map((id) => ({ id, contact: this.google.get(id) })).filter((e) => e.contact);
  }

  applyEvent({ id, contact }) {
    if (this.halted) return 'halted';
    const key = this.key(id);
    const print = fingerprintOf(contact);
    if (this.prints.get(key) === print) return 'ignored-echo';
    const zid = this.map.get(key);
    if (!zid) {
      const newId = `z${this.nextZoho++}`;
      this.zoho.set(newId, { id: newId, ...contact, Google_Contact_ID: key });
      this.map.set(key, newId);
      this.writes.zoho_created++;
    } else {
      const cur = this.zoho.get(zid), base = this.lastSynced.get(key) ?? {};
      const next = { ...cur };
      for (const f of SYNCED_FIELDS) {
        const googleChanged = (contact[f] ?? '') !== (base[f] ?? '');
        const zohoChanged = (cur[f] ?? '') !== (base[f] ?? '');
        if (googleChanged && zohoChanged && contact[f] !== cur[f]) {
          this.review.push({ type: 'conflict', key, field: f, google_value: contact[f], zoho_value: cur[f] });
          next.Conflict_Values = { ...(next.Conflict_Values ?? {}), [f]: { google: contact[f], zoho: cur[f] } };
        } else if (googleChanged) next[f] = contact[f];
      }
      this.zoho.set(zid, next);
      this.writes.zoho_updated++;
    }
    this.prints.set(key, print);
    this.lastSynced.set(key, { ...contact });
    return 'applied';
  }

  // A Zoho change on a synced field comes back only if its fingerprint moved. Zoho-owned fields never leave Zoho.
  zohoEdit(id, fields) { Object.assign(this.zoho.get(id), fields); }
  writeBackFromZoho(zid) {
    const rec = this.zoho.get(zid);
    const key = rec.Google_Contact_ID;
    const print = fingerprintOf(rec);
    if (this.prints.get(key) === print) return 'ignored-echo';
    const id = key.split('|')[1];
    const contact = { ...this.google.get(id) };
    for (const f of SYNCED_FIELDS) if (rec[f] !== undefined) contact[f] = rec[f];
    this.google.set(id, contact);
    this.changes.push(id);
    this.writes.google_written++;
    this.prints.set(key, print);
    this.lastSynced.set(key, { ...contact });
    return 'written';
  }

  // Full comparison that catches what polling missed. Deletions go to a person, never to an automatic delete.
  reconcile() {
    const found = { created: 0, sent_to_review: 0 };
    for (const [id, contact] of this.google) {
      if (!this.map.has(this.key(id))) { this.applyEvent({ id, contact }); found.created++; }
    }
    for (const [key, zid] of this.map) {
      const id = key.split('|')[1];
      if (!this.google.has(id) && !this.review.some((r) => r.type === 'google_deleted' && r.key === key)) {
        this.review.push({ type: 'google_deleted', key, zoho_id: zid });
        found.sent_to_review++;
      }
    }
    return found;
  }
}

// Order of work during the import window.
export const CUTOVER = ['Turn off every Zap touching contacts', 'Turn off any native Google sync inside Zoho', 'Take the snapshot and count both sides', 'Import and read back', 'Reconcile everything changed since the snapshot', 'Turn flows back on one direction at a time'];
