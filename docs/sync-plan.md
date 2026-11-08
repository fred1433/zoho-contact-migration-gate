# Zapier sync plan

All scenarios below run in `sync/sim.js` and are labeled simulated. Nothing here has run on Zapier.

## Limits taken from Zapier's documentation

- Google Contacts returns 50 items per poll. More than 50 new contacts between polls can be missed.
- Triggers are New or Updated Contact, New Contact and New Group. The article lists no deletion trigger.

## During the import

1. Turn off every Zap that touches contacts.
2. Turn off any native Google sync inside Zoho.
3. Take the snapshot and count both sides.
4. Import and read back.
5. Reconcile everything changed since the snapshot.
6. Turn flows back on one direction at a time.

## After the import

| Question | Rule | Test |
|---|---|---|
| Who wins on a conflict? | Nobody automatically. If both sides changed a field since the last sync, Zoho keeps its value, the Google value is kept beside it, and a person decides | both sides edit the same field |
| Which fields does Zoho own? | `Owner`, `Lead_Source`, `Description`. They never travel to Google | fields Zoho owns |
| Replayed event | Same fingerprint of the synced fields, so ignored: zero creations, zero writes back | replayed event |
| Loop | A round trip Google to Zoho to Google gives zero extra writes, for the same reason | round trip |
| Missed contacts | A scheduled full comparison finds them | 51 contacts between two reads |
| Deleted in Google | Goes to a review line. Nothing is deleted in Zoho automatically | Google deletion |

## Match key

A durable map from account plus source ID to Zoho ID.

- Enterprise or Ultimate: Zoho's native External ID field.
- Other editions: a custom unique text field, `Google_Contact_ID`, holding account plus source ID. It is not equivalent to External ID and is not presented as such.
