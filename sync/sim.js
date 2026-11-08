// SIMULATED. Nothing here talks to Google, Zapier or Zoho. It models the limits Zapier documents for Google Contacts
// (see docs/sources.md) so that the plan in docs/sync-plan.md can be tested before anyone turns a Zap on.
import { createHash } from 'node:crypto';

export const POLL_LIMIT = 50;
export const ZOHO_OWNED_FIELDS = ['Owner', 'Lead_Source', 'Description'];
const INTERNAL = ['id', 'Google_Contact_ID', 'Conflict_Values', ...ZOHO_OWNED_FIELDS];
// Everything else on a contact synchronizes. A new field cannot be mistaken for an echo.
export const SYNCED_FIELDS = 'every field except Zoho-owned and internal ones';
const syncedKeys = (...recs) => [...new Set(recs.flatMap((r) => Object.keys(r ?? {})))].filter((k) => !INTERNAL.includes(k)).sort();

export function fingerprintOf(rec) {
  return createHash('sha256').update(JSON.stringify(syncedKeys(rec).filter((k) => rec[k] !== undefined && rec[k] !== '').map((k) => [k, rec[k]]))).digest('hex');
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
    this.lastSynced = new Map(); // key -> last common state, to detect two-sided edits
    this.review = [];
    this.changes = [];         // pending Google events, oldest first
    this.writes = { zoho_created: 0, zoho_updated: 0, google_written: 0 };
    this.nextZoho = 1;
    this.halted = false;
  }
  key(id) { return `${this.account}|${id}`; }
  openConflicts(key) { return this.review.filter((r) => r.type === 'conflict' && r.key === key); }

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

  // Both sides moved one field away from the last common state, to different values: keep both, a person decides.
  conflictsBetween(key, contact, rec) {
    const base = this.lastSynced.get(key) ?? {};
    return syncedKeys(contact, rec, base).filter((f) => (contact[f] ?? '') !== (base[f] ?? '') && (rec[f] ?? '') !== (base[f] ?? '') && (contact[f] ?? '') !== (rec[f] ?? ''));
  }
  recordConflicts(key, zid, fields, contact, rec) {
    const next = this.zoho.get(zid);
    for (const f of fields) {
      next.Conflict_Values = { ...(next.Conflict_Values ?? {}), [f]: { google: contact[f], zoho: rec[f] } };
      if (!this.openConflicts(key).some((c) => c.field === f)) this.review.push({ type: 'conflict', key, field: f, google_value: contact[f], zoho_value: rec[f] });
    }
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
      this.prints.set(key, print);
      this.lastSynced.set(key, { ...contact });
      return 'applied';
    }
    const cur = this.zoho.get(zid), base = this.lastSynced.get(key) ?? {};
    const conflicted = this.conflictsBetween(key, contact, cur);
    const next = { ...cur };
    for (const f of syncedKeys(contact, base)) {
      if (conflicted.includes(f) || (contact[f] ?? '') === (base[f] ?? '')) continue;
      next[f] = contact[f];
    }
    this.zoho.set(zid, next);
    this.recordConflicts(key, zid, conflicted, contact, cur);
    this.writes.zoho_updated++;
    this.prints.set(key, print);
    const common = { ...contact };
    for (const f of conflicted) common[f] = base[f];
    this.lastSynced.set(key, common);
    return conflicted.length ? 'applied-with-conflict' : 'applied';
  }

  // A Zoho change comes back only if its fingerprint moved. Zoho-owned fields never leave Zoho.
  // While a conflict is open on this contact, nothing goes back.
  zohoEdit(id, fields) { Object.assign(this.zoho.get(id), fields); }
  writeBackFromZoho(zid) {
    const rec = this.zoho.get(zid);
    const key = rec.Google_Contact_ID;
    const id = key.split('|')[1];
    const contact = this.google.get(id) ?? {};
    const fresh = this.conflictsBetween(key, contact, rec);
    if (fresh.length) this.recordConflicts(key, zid, fresh, contact, rec);
    if (this.openConflicts(key).length) return 'blocked-conflict';
    const print = fingerprintOf(rec);
    if (this.prints.get(key) === print) return 'ignored-echo';
    const next = { ...contact };
    for (const f of syncedKeys(rec)) if (rec[f] !== undefined) next[f] = rec[f];
    this.google.set(id, next);
    this.changes.push(id);
    this.writes.google_written++;
    this.prints.set(key, fingerprintOf(next));
    this.lastSynced.set(key, { ...next });
    return 'written';
  }

  // A person chooses the value. Only then do both sides move again.
  resolveConflict(key, field, value) {
    const zid = this.map.get(key), id = key.split('|')[1];
    const rec = this.zoho.get(zid);
    rec[field] = value;
    if (rec.Conflict_Values) { delete rec.Conflict_Values[field]; if (!Object.keys(rec.Conflict_Values).length) delete rec.Conflict_Values; }
    const contact = { ...this.google.get(id), [field]: value };
    this.google.set(id, contact);
    this.review = this.review.filter((r) => !(r.type === 'conflict' && r.key === key && r.field === field));
    const base = { ...(this.lastSynced.get(key) ?? {}), [field]: value };
    this.lastSynced.set(key, base);
    this.prints.set(key, fingerprintOf(contact));
  }

  // Full comparison that catches what polling missed: new contacts, and changes on contacts already linked,
  // compared by content fingerprint. Deletions go to a person, never to an automatic delete.
  reconcile() {
    const found = { created: 0, updated: 0, sent_to_review: 0 };
    for (const [id, contact] of this.google) {
      const key = this.key(id);
      if (!this.map.has(key)) { this.applyEvent({ id, contact }); found.created++; }
      else if (this.prints.get(key) !== fingerprintOf(contact)) { this.applyEvent({ id, contact }); found.updated++; }
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
