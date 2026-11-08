// Browser side. Loads the same files the command line reads and runs the same verify.js.
import { runChecks } from './verify.js';
import { slots, tabFlags, tabsHtml, letterCounts } from './render.js';

const $ = (id) => document.getElementById(id);
const book = $('book'), button = $('run'), status = $('status');
const LABEL = { intact: 'Run the check on the intact copy', held: 'Run the check on the held copy' };
let next = 'intact', cache = null;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf));
const bytes = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.arrayBuffer(); });
const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });

async function load() {
  if (cache) return cache;
  const [reference, intact, patch, decisionLog, openCases, csv, ids, zoho, code] = await Promise.all([
    json('data/reference.json'), json('data/readback-intact.json'), json('data/held-patch.json'), json('data/decision-log.json'), json('data/open-cases.json'),
    bytes('data/archive/google-contacts.csv'), bytes('data/archive/google-contact-ids.json'), bytes('data/archive/zoho-snapshot.json'), bytes('verify.js'),
  ]);
  const actual = { 'google-contacts.csv': await digest(csv), 'google-contact-ids.json': await digest(ids), 'zoho-snapshot.json': await digest(zoho) };
  const held = intact.map((r) => (r.id === patch.record_id ? patch.record : r));
  cache = { reference, intact, held, decisionLog, openCases, actual, code: await digest(code) };
  return cache;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Checking 11,000 source IDs';
  status.textContent = '';
  try {
    const d = await load();
    const readback = d[next];
    const started = performance.now();
    const result = runChecks({ reference: d.reference, readback, decisionLog: d.decisionLog, openCases: d.openCases, archive: { recorded: d.decisionLog.archive_fingerprint, actual: d.actual } });
    const ms = Math.max(1, Math.round(performance.now() - started));
    const s = slots(result, d.reference, readback);
    for (const key of Object.keys(s)) { const el = document.querySelector(`[data-slot="${key}"]`); if (el) el.innerHTML = s[key]; }
    document.querySelector('[data-slot="why"]').hidden = !s.why;
    $('tabs').innerHTML = tabsHtml(letterCounts(d.reference), tabFlags(result));
    book.dataset.state = result.verdict === 'GO' ? 'go' : 'hold';
    $('code').textContent = d.code.slice(0, 16);
    $('code').title = d.code;
    status.textContent = `Ran in your browser in ${ms} ms on the ${next === 'intact' ? 'intact' : 'held'} copy.`;
    document.title = `${s.title} | Zoho contact migration gate`;
    next = next === 'intact' ? 'held' : 'intact';
    button.textContent = LABEL[next];
    button.dataset.next = next;
  } catch (err) {
    button.textContent = original;
    status.textContent = 'The check could not load its files, so nothing was checked. The sheet still shows the last result. Reload and run it again.';
  } finally {
    button.disabled = false;
  }
});
