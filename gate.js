#!/usr/bin/env node
// Command line for the gate. Exit code 0 = go, 1 = hold, 2 = bad usage or missing files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generate } from './src/generate.js';
import { rehearse, fingerprint, openCasesFrom } from './src/pipeline.js';
import { runChecks, plainWords, tracePerson } from './src/verify.js';
import { replacePersonWithDuplicate, applyFault, FAULT_NAMES } from './src/faults.js';
import { inventory, restoreDrill } from './src/restore.js';
import { SyncSim } from './sync/sim.js';

const USAGE = `Usage:
  node gate.js generate                         build the fictional archive and the answer key
  node gate.js rehearse                         migrate, import into the local stand-in, read everything back
  node gate.js check --copy intact|held [--fault NAME]
  node gate.js restore-drill                    restore one record with its note and relation in an isolated copy
  node gate.js sync-sim                         run the simulated sync scenarios
Faults: ${FAULT_NAMES.join(', ')}`;

const die = (msg) => { console.error(`${msg}\n\n${USAGE}`); process.exit(2); };
const read = (p) => { if (!existsSync(p)) { console.error(`Missing ${p}. Run the step that builds it first (node gate.js generate, then node gate.js rehearse).`); process.exit(2); } return readFileSync(p, 'utf8'); };

function loadArchive() {
  return { csv: read('archive/google-contacts.csv'), ids: read('archive/google-contact-ids.json'), zoho: read('archive/zoho-snapshot.json') };
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) die('No command given.');

if (cmd === 'generate') {
  if (rest.length) die(`generate takes no arguments, got: ${rest.join(' ')}`);
  const g = generate();
  mkdirSync('archive', { recursive: true }); mkdirSync('reference', { recursive: true });
  writeFileSync('archive/google-contacts.csv', g.csv);
  writeFileSync('archive/google-contact-ids.json', g.ids);
  writeFileSync('archive/zoho-snapshot.json', g.zoho);
  // Frozen here and only here. rehearse never writes this file, so it cannot certify an archive changed after this point.
  writeFileSync('archive/manifest.json', JSON.stringify(fingerprint(g), null, 2));
  writeFileSync('reference/reference.json', JSON.stringify(g.reference));
  console.log(`Wrote ${g.planned.plan.length} source contacts and ${g.planned.zoho.length} Zoho snapshot records.`);
} else if (cmd === 'rehearse') {
  if (rest.length) die(`rehearse takes no arguments, got: ${rest.join(' ')}`);
  const run = rehearse(loadArchive());
  mkdirSync('out', { recursive: true });
  writeFileSync('out/decision-log.json', JSON.stringify(run.decisionLog));
  writeFileSync('out/readback.json', JSON.stringify(run.readback));
  writeFileSync('out/open-cases.json', JSON.stringify(openCasesFrom(run.pending)));
  writeFileSync('out/receipt.json', JSON.stringify(run.receipt, null, 2));
  writeFileSync('out/call-log.json', JSON.stringify(run.callLog));
  console.log(JSON.stringify(run.receipt, null, 2));
} else if (cmd === 'check') {
  let copy = null, fault = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--copy') { copy = rest[++i]; if (copy === undefined) die('--copy needs a value.'); }
    else if (rest[i] === '--fault') { fault = rest[++i]; if (fault === undefined) die('--fault needs a value.'); }
    else die(`Unknown argument: ${rest[i]}`);
  }
  if (!['intact', 'held'].includes(copy)) die('check needs --copy intact or --copy held.');
  if (fault && !FAULT_NAMES.includes(fault)) die(`Unknown fault: ${fault}`);
  const archive = loadArchive();
  const reference = JSON.parse(read('reference/reference.json'));
  let state;
  if (fault === 'wrong-merge') {
    const run = rehearse(archive, { matchRule: 'identifier-only' });
    state = { reference, readback: run.readback, decisionLog: run.decisionLog, openCases: openCasesFrom(run.pending) };
  } else {
    state = { reference, readback: JSON.parse(read('out/readback.json')), decisionLog: JSON.parse(read('out/decision-log.json')), openCases: JSON.parse(read('out/open-cases.json')) };
  }
  state.archive = { recorded: JSON.parse(read('archive/manifest.json')), actual: fingerprint(archive) };
  if (copy === 'held') state.readback = replacePersonWithDuplicate(reference, state.readback, 'Maya Chen', 'Alex Reed').readback;
  if (fault && fault !== 'wrong-merge') state = applyFault(fault, state);
  const result = runChecks(state);
  const words = plainWords(result);
  console.log(`${words.title}\n${words.line}\nTechnician's next step: ${words.next}\nOwner action: ${words.owner}\n`);
  console.log(`Operation: ${result.operation.name}. Batch: ${result.operation.batch}. Fictional data, this reconciliation only.`);
  const t = result.tally;
  console.log(`Sources ${t.sources} = ${t.individual} individual + ${t.merged} in ${t.groups} groups + ${t.excluded} excluded + ${t.open} open${t.holds ? `, with ${t.holds} hold on a record already placed` : ''}`);
  console.log(`Target records ${t.targets}, of which ${t.already_in_zoho} already in Zoho and ${t.creations} new\n`);
  for (const c of result.checks) console.log(`${c.pass ? (c.partial ? 'part' : 'pass') : 'FAIL'}  ${c.name}: ${c.detail}`);
  for (const name of ['Maya Chen', 'Alex Reed']) { const tr = tracePerson(reference, state.readback, name); console.log(`${name}: source ${tr.source_ids.join(', ')} on ${tr.records.length} record(s)`); }
  process.exit(result.verdict === 'GO' ? 0 : 1);
} else if (cmd === 'restore-drill') {
  if (rest.length) die(`restore-drill takes no arguments, got: ${rest.join(' ')}`);
  const archive = loadArchive(), zoho = JSON.parse(archive.zoho);
  console.log(JSON.stringify({ inventory: inventory({ csvRows: JSON.parse(archive.ids).length, zoho }), drill: restoreDrill(zoho) }, null, 2));
} else if (cmd === 'sync-sim') {
  if (rest.length) die(`sync-sim takes no arguments, got: ${rest.join(' ')}`);
  const s = new SyncSim();
  for (let i = 1; i <= 51; i++) s.googleSave(`g${i}`, { First_Name: 'Sim', Last_Name: `Contact ${i}`, Email: `sim.${i}@example.com` });
  const seen = s.poll(); seen.forEach((e) => s.applyEvent(e));
  const afterPoll = s.zoho.size;
  const rec = s.reconcile();
  s.googleDelete('g1');
  const rec2 = s.reconcile();
  for (let i = 2; i <= 51; i++) s.googleSave(`g${i}`, { First_Name: 'Sim', Last_Name: `Contact ${i}`, Email: `sim.${i}.new@example.com` });
  s.googleSave('g52', { First_Name: 'Sim', Last_Name: 'Contact 52', Email: 'sim.52@example.com' });
  const third = s.poll(); third.forEach((e) => s.applyEvent(e));
  const rec3 = s.reconcile();
  console.log(`SIMULATED. 51 contacts created between two reads: poll returned ${seen.length}, created ${afterPoll}, reconciliation found ${rec.created} more.`);
  console.log(`SIMULATED. One Google deletion: ${rec2.sent_to_review} sent to review, Zoho still holds ${s.zoho.size - 1} records before the next step.`);
  console.log(`SIMULATED. 51 changes between two reads: poll returned ${third.length}, reconciliation found ${rec3.created + rec3.updated} more.`);
} else die(`Unknown command: ${cmd}`);
