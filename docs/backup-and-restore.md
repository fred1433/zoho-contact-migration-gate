# Backup and restore

A fingerprint shows that archived bytes have not changed. It does not show that recovery works. The drill does that part. The fingerprint is frozen by `generate` in `archive/manifest.json`, and `rehearse` never writes that file.

Before any merge or deletion:

1. Inventory both sides and count them (`node gate.js restore-drill` prints the inventory).
2. Write down what the archive does not hold. Today: contact photos, Zoho attachments, Zoho activities and emails, Zoho custom modules, Google "Other contacts".
3. Restore at least one record with its note and its relation into an isolated environment and read it back.

The restored record gets a new Zoho ID, so the source map must be rewritten after a restore. The drill here ran on an isolated local stand-in, not on Zoho.

Merges are decided outside Zoho, in the merge decision log, which records the archive fingerprint. Zoho documents that merged duplicates "will be deleted permanently and the action cannot be reverted", three records at most per merge, with attachments, notes and activities moving to the master record.
