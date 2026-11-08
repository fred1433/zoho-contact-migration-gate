// Turns a check result into the words on the sheet. Used at build time for the first paint and in the browser after each run,
// so what the page shows in both states comes from one code path.
import { plainWords, tracePerson } from './verify.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => v.toLocaleString('en-US');
const leader = (label, value, cls = '') => `<li class="${cls}"><span>${esc(label)}</span><i></i><b>${esc(value)}</b></li>`;
const inverted = (name) => { const p = name.split(' '); return `${p.at(-1)}, ${p.slice(0, -1).join(' ')}`; };

export const FOCUS = ['Maya Chen', 'Alex Reed'];

export function slots(result, reference, readback) {
  const w = plainWords(result), t = result.tally;
  const traces = FOCUS.map((name) => tracePerson(reference, readback, name));
  const sources = [
    leader('Source contacts', n(t.sources), 'sum'),
    leader('Individual records', n(t.individual)),
    leader(`In ${n(t.groups)} merge groups`, n(t.merged)),
    leader('Excluded with a written reason', n(t.excluded)),
    leader('Open cases', n(t.open)),
  ].join('');
  const targets = [
    leader('Records after this batch', n(t.targets), 'sum'),
    leader('From individual records', n(t.individual_targets)),
    leader('From merge groups', n(t.groups)),
    leader('In the Zoho snapshot, matched', n(t.already_in_zoho), 'split'),
    leader('New records to create', n(t.creations)),
  ].join('');
  const checks = result.checks.map((c) => `<li class="${c.pass ? 'pass' : 'fail'}"><div class="row"><span>${esc(c.name)}</span><i></i><b>${c.pass ? 'Passed' : 'Failed'}</b></div><p>${esc(c.detail)}</p></li>`).join('');
  const lines = traces.map((tr) => {
    const where = tr.records.length === 0 ? 'no record' : tr.records.length === 1 ? `record ${tr.records[0]}` : `${tr.records.length} records: ${tr.records.join(', ')}`;
    const bad = tr.records.length !== 1;
    return `<li class="${bad ? 'bad' : ''}"><div class="row"><span>${esc(inverted(tr.name))}</span><i></i><b>${bad ? (tr.records.length ? 'twice' : 'missing') : 'one record'}</b></div><p>Source ${esc(tr.source_ids.join(', '))} reaches ${esc(where)}.</p></li>`;
  }).join('');
  const go = result.verdict === 'GO';
  const why = go ? `${traces[0].name} is back on record ${traces[0].records[0]}, with all ${traces[0].value_count} values read back. ${traces[1].name} is on one record.` : '';
  return {
    title: esc(w.title), line: esc(w.line), why: esc(why), next: esc(w.next), owner: esc(w.owner),
    operation: `Operation: ${esc(result.operation.name)}. Batch: ${esc(result.operation.batch)}.`,
    sources, targets, checks, lines,
  };
}

export function letterCounts(reference) {
  const out = Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => [l, 0]));
  for (const p of Object.values(reference.people)) {
    const l = p.name.split(' ').at(-1).normalize('NFD')[0]?.toUpperCase();
    if (l in out) out[l]++;
  }
  return out;
}

const initial = (name) => name.split(' ').at(-1)[0].toUpperCase();
export function tabFlags(result) {
  const flags = {};
  for (const m of result.missing) flags[initial(m.name)] = (flags[initial(m.name)] ?? 0) - 1;
  for (const d of result.duplicated) flags[initial(d.name)] = (flags[initial(d.name)] ?? 0) + 1;
  return flags;
}
const flagText = (v) => (v > 0 ? `+${v}` : `−${Math.abs(v)}`);

export function tabsHtml(counts, flags) {
  return Object.entries(counts).map(([l, c]) => {
    const f = flags[l];
    return `<li data-letter="${l}" style="flex-grow:${Math.max(c, 40)}"${f ? ' class="flag"' : ''} title="${n(c)} people, last name ${l}"><span>${l}</span>${f ? `<em>${flagText(f)}</em>` : ''}</li>`;
  }).join('');
}
