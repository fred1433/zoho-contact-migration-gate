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
| Who wins on a conflict? | Nobody automatically. If both sides moved a field away from the last common state, in either arrival order, both values are kept, nothing goes back to Google for that contact, and a person decides | same field edited on both sides, both orders |
| Which fields does Zoho own? | `Owner`, `Lead_Source`, `Description`. They never travel to Google | fields Zoho owns |
| Which fields synchronize? | Every other field on the contact, so an added `Mobile` is applied and never read as an echo | Google adds Mobile |
| Replayed event | Same content fingerprint, so ignored: zero creations, zero writes back | replayed event |
| Loop | A round trip Google to Zoho to Google gives zero extra writes, for the same reason | round trip |
| Missed contacts and missed changes | A scheduled full comparison on content fingerprints finds new contacts and changes on linked ones | 51 contacts between two reads, 51 changes to linked contacts |
| Deleted in Google | Goes to a review line. Nothing is deleted in Zoho automatically | Google deletion |

## Match key

A durable map from account plus source ID to Zoho ID.

- Enterprise or Ultimate: Zoho's native External ID field.
- Other editions: a custom unique text field, `Google_Contact_ID`, holding account plus source ID. It is not equivalent to External ID and is not presented as such.
