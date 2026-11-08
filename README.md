# zoho-contact-migration-gate

A go or hold check for a Zoho CRM contact import, rehearsed on 11,000 fictional contacts.

Page: https://theaipipe.com/demos/zoho-contact-migration-gate/

**What this is not.** No live Zoho test. The import and the read-back ran on a local stand-in written from Zoho's API documentation (`src/zoho-standin.js`), and the Zapier scenarios are simulated (`sync/sim.js`). All data is fictional. A green sheet covers this one reconciliation and is not a promise of zero loss.

## The point

A row count can be exact while a person is gone. Replace Maya Chen with a second copy of Alex Reed and the totals still close. This check compares identities and values against an answer key the migration code never reads, and it names who went missing.

## Run it

Node 20 or later, no dependencies.

```
node gate.js generate                  # build the archive, the answer key and the fingerprint manifest
node gate.js rehearse                  # migrate, import into the stand-in, read back
node gate.js check --copy held         # exit 1: Hold the merge, with the names
node gate.js check --copy intact       # exit 0: Rehearsal passed
node gate.js check --copy intact --fault lost-extension
node gate.js restore-drill
node gate.js sync-sim
npm test
npm run build                          # rewrites site/ from a fresh run
```

Faults: `lost-third-email`, `lost-prefix`, `lost-extension`, `lost-label`, `lost-and-doubled`, `open-case`, `archive-altered`, `manifest-empty`, `wrong-merge`. Each one fails a single named check.

## The sums

```
11,000 sources = 10,780 individual + 200 members of 100 groups + 20 excluded with a reason + 0 open
10,880 records in the target = 10,780 + 100
10,880 = 80 already in Zoho, matched + 10,800 new
```

These numbers are choices for the demonstration. They describe no real address book.

## The four checks (`src/verify.js`)

| Check | Fails when |
|---|---|
| Source identities | A person is missing, twice, split, merged with someone else, or on another person's Zoho record, or a source ID reaches neither a record nor a written reason |
| Field values | A value is lost, doubled or unexpected, compared value by value, not by count. Names compare exactly and phones in their own field. A non-empty column with no destination and no written reason also fails here |
| Open cases | An open case touches this operation, whether it comes from the list or only from the decision log |
| Archive unchanged | A file no longer matches `archive/manifest.json`, the fingerprint frozen by `generate`, or that manifest is empty or incomplete. This shows the file has not changed. It says nothing about whether a restore works, which is what `restore-drill` is for |

The same `verify.js` runs under Node and in the browser. No model is called at any point.

## Where things are

- `archive/`: the export (`google-contacts.csv`), its stable IDs, the Zoho snapshot and the frozen manifest
- `reference/reference.json`: the answer key, written from the generator's plan and the snapshot
- `src/migrate.js`: the code under test. Merges are decided here, before import, in the merge decision log. On a record Zoho already holds, it fills empty fields only, and any disagreement becomes an open case
- `src/field-map.js`, `docs/field-map.md`: where each column goes, or why it does not
- `docs/sync-plan.md`, `docs/backup-and-restore.md`, `docs/sources.md`

Zoho documents that a merge deletes the duplicates permanently, so no merge is run inside Zoho here and the stand-in log shows none.

## What has not been checked

See the last section of `docs/sources.md`.

Frederic de Lavenne de Choulot, The AI Pipe. https://cal.theaipipe.com
