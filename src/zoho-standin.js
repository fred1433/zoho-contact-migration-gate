// A local stand-in for the Zoho CRM v8 Records API. It is NOT Zoho.
// Each rule below is taken from Zoho's published API documentation (see docs/sources.md). None was observed on a live org.
const FIELD_LIMIT = 50;

export class ZohoStandIn {
  constructor(seed = []) {
    this.records = new Map();
    this.nextId = 5725767000001000000n;
    this.calls = [];
    this.tokens = new Map();
    for (const z of seed) this.records.set(z.id, structuredClone(z));
  }
  newId() { this.nextId += 1n; return String(this.nextId); }

  request(method, path, { params = {}, data } = {}) {
    this.calls.push({ method, path, records: data?.length ?? 0, params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'fields')) });
    if (method === 'POST' && path === '/Contacts') return this.write(data, (rec) => this.insert(rec), 201);
    if (method === 'PUT' && path === '/Contacts') return this.write(data, (rec) => this.update(rec), 200);
    if (method === 'POST' && path === '/Contacts/upsert') return this.upsert(data, params.duplicate_check_fields);
    if (method === 'GET' && path === '/Contacts') return this.list(params);
    if (method === 'DELETE' && path.startsWith('/Contacts/')) {
      const id = path.split('/')[2];
      if (!this.records.delete(id)) return { status: 404, body: { code: 'INVALID_DATA' } };
      return { status: 200, body: { data: [{ code: 'SUCCESS', details: { id } }] } };
    }
    const notes = /^\/Contacts\/(\d+)\/Notes$/.exec(path);
    if (notes && method === 'GET') return { status: 200, body: { data: (this.records.get(notes[1])?.Notes ?? []).map((n) => ({ Note_Content: n })) } };
    if (notes && method === 'POST') { const rec = this.records.get(notes[1]); (rec.Notes ??= []).push(...data.map((d) => d.Note_Content)); return { status: 201, body: { data: [{ code: 'SUCCESS' }] } }; }
    return { status: 404, body: { code: 'INVALID_URL' } };
  }

  write(data, one, okStatus) {
    if (data.length > 100) return { status: 400, body: { code: 'LIMIT_EXCEEDED', message: 'A maximum of 100 records per API call' } };
    const results = data.map((rec, i) => one(rec, i));
    const failed = results.filter((r) => r.status === 'error').length;
    return { status: failed === 0 ? okStatus : failed === results.length ? 400 : 207, body: { data: results } };
  }
  insert(rec, i = 0) {
    if (!rec.Last_Name) return { code: 'MANDATORY_NOT_FOUND', details: { api_name: 'Last_Name', json_path: `$.data[${i}].Last_Name` }, message: 'required field not found', status: 'error' };
    const id = this.newId();
    this.records.set(id, { id, ...structuredClone(rec) });
    return { code: 'SUCCESS', details: { id }, message: 'record added', status: 'success' };
  }
  update(rec, i = 0) {
    const cur = this.records.get(rec.id);
    if (!cur) return { code: 'INVALID_DATA', details: { api_name: 'id', json_path: `$.data[${i}].id` }, message: 'the id given seems to be invalid', status: 'error' };
    Object.assign(cur, structuredClone(rec));
    return { code: 'SUCCESS', details: { id: rec.id }, message: 'record updated', status: 'success' };
  }
  // Zoho documents Email as the default duplicate check field for Contacts.
  upsert(data, fields = ['Email']) {
    return this.write(data, (rec, i) => {
      for (const f of fields) {
        if (!rec[f]) continue;
        const hit = [...this.records.values()].find((r) => r[f] && r[f].toLowerCase() === String(rec[f]).toLowerCase());
        if (hit) { const out = this.update({ ...rec, id: hit.id }, i); return { ...out, action: 'update', duplicate_field: f }; }
      }
      return { ...this.insert(rec, i), action: 'insert' };
    }, 200);
  }
  list({ fields, per_page = 200, page = 1, page_token }) {
    if (!fields) return { status: 400, body: { code: 'REQUIRED_PARAM_MISSING', details: { param: 'fields' } } };
    if (fields.length > FIELD_LIMIT) return { status: 400, body: { code: 'LIMIT_EXCEEDED', message: 'at most 50 field API names' } };
    if (per_page > 200) return { status: 400, body: { code: 'INVALID_DATA', message: 'per_page must be 200 or less' } };
    let offset;
    if (page_token) {
      if (!this.tokens.has(page_token)) return { status: 400, body: { code: 'INVALID_TOKEN' } };
      offset = this.tokens.get(page_token);
    } else {
      offset = (page - 1) * per_page;
      if (offset >= 2000) return { status: 400, body: { code: 'DISCRETE_PAGINATION_LIMIT_EXCEEDED', message: 'You can only get the first 2000 records without using page_token param.' } };
    }
    const all = [...this.records.values()];
    const slice = all.slice(offset, offset + per_page);
    const more = offset + per_page < all.length;
    const info = { per_page, count: slice.length, more_records: more, next_page_token: null };
    if (more) { const t = `tok-${offset + per_page}`; this.tokens.set(t, offset + per_page); info.next_page_token = t; }
    const keep = new Set(['id', ...fields]);
    return { status: 200, body: { data: slice.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k)))), info } };
  }
}
