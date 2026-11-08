// Runs the rehearsal, runs the check on the held copy, and writes the page from that result.
// Nothing on the first paint is typed by hand: names and numbers come from the run.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rehearse, fingerprint, openCasesFrom } from '../src/pipeline.js';
import { runChecks } from '../src/verify.js';
import { replacePersonWithDuplicate } from '../src/faults.js';
import { slots, letterCounts, tabFlags, tabsHtml } from '../src/render.js';
import { NOT_COVERED } from '../src/restore.js';

const archive = { csv: readFileSync('archive/google-contacts.csv', 'utf8'), ids: readFileSync('archive/google-contact-ids.json', 'utf8'), zoho: readFileSync('archive/zoho-snapshot.json', 'utf8') };
const reference = JSON.parse(readFileSync('reference/reference.json', 'utf8'));
const run = rehearse(archive);
const { readback: held, patch } = replacePersonWithDuplicate(reference, run.readback, 'Maya Chen', 'Alex Reed');
const openCases = openCasesFrom(run.pending);
const result = runChecks({ reference, readback: held, decisionLog: run.decisionLog, openCases, archive: { recorded: run.decisionLog.archive_fingerprint, actual: fingerprint(archive) } });
if (result.verdict !== 'HOLD') throw new Error('The held copy should hold.');

mkdirSync('site/data/archive', { recursive: true });
for (const f of ['verify.js', 'render.js', 'app.js']) copyFileSync(`src/${f}`, `site/${f}`);
copyFileSync('scripts/style.css', 'site/style.css');
for (const f of ['google-contacts.csv', 'google-contact-ids.json', 'zoho-snapshot.json']) copyFileSync(`archive/${f}`, `site/data/archive/${f}`);
writeFileSync('site/data/reference.json', JSON.stringify(reference));
writeFileSync('site/data/readback-intact.json', JSON.stringify(run.readback));
writeFileSync('site/data/held-patch.json', JSON.stringify(patch));
writeFileSync('site/data/decision-log.json', JSON.stringify(run.decisionLog));
writeFileSync('site/data/open-cases.json', JSON.stringify(openCases));
writeFileSync('site/data/receipt.json', JSON.stringify(run.receipt, null, 2));

const n = (v) => v.toLocaleString('en-US');
const r = run.receipt;
const line = (a, b) => `<li><span>${a}</span><i></i><b>${b}</b></li>`;
const receipt = [
  line('Created', n(r.created)), line('Updated', n(r.updated)), line('Rejected', n(r.rejected)),
  line('Largest write batch', n(r.largest_write_batch)), line('Pages read back', n(r.pages_read)),
  line('Last page', `${n(r.last_page.count)} records, no more`), line('Zoho merge calls', n(r.merge_calls)),
].join('');
const codeHash = createHash('sha256').update(readFileSync('src/verify.js')).digest('hex');
const s = slots(result, reference, held);
const fill = { ...s, tabs: tabsHtml(letterCounts(reference), tabFlags(result)), receipt, code: codeHash.slice(0, 16), code_full: codeHash, not_covered: NOT_COVERED.join(', ').replaceAll('"', '&quot;') };
const html = readFileSync('scripts/page.template.html', 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in fill)) throw new Error(`No value for ${k}`); return fill[k]; });
writeFileSync('site/index.html', html);
console.log(`Page written. ${s.title}: ${result.checks.filter((c) => !c.pass).map((c) => c.name).join(', ')} failed.`);
