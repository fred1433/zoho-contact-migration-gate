# Sources, read on 2026-11-08

## Zoho

- Records API, read: 200 per page at most, `page_token` needed past 2,000 records, valid 24 hours, error `DISCRETE_PAGINATION_LIMIT_EXCEEDED`. https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
- Records API, insert: 100 per call, `Last_Name` required for Contacts, HTTP 207 on partial success, `MANDATORY_NOT_FOUND`. https://www.zoho.com/crm/developer/docs/api/v8/insert-records.html
- Upsert: `Email` is the default duplicate check field for Contacts. https://www.zoho.com/crm/developer/docs/api/v8/upsert-records.html
- External ID: Enterprise and Ultimate only. https://www.zoho.com/crm/developer/docs/api/v8/records-api-ext-id-overview.html
- Merge: three records at most, duplicates deleted permanently. https://help.zoho.com/portal/en/kb/crm/manage-crm-data/duplication-management/articles/merge-duplicate-record
- Feature list: Free edition 5,000 records, 1,000 per import batch, no custom fields. https://www.zoho.com/crm/complete-feature-list.html
- Tags per record, 5 on Standard and 10 above: https://www.zoho.com/crm/help/tagging.html (seen through a search summary, not read in full)

## Zapier

- Google Contacts: 50 items per poll, three polling triggers, no deletion trigger listed. https://help.zapier.com/hc/en-us/articles/8495951097357-How-to-get-started-with-Google-Contacts-on-Zapier

## Google

- `resourceName`, in the form `people/{person_id}`: https://developers.google.com/people/api/rest/v1/people
- CSV header layout (`E-mail 1 - Label`, `E-mail 1 - Value` and so on, no ID column) and the `* myContacts` label: read from the header rows of public sample exports, no personal data copied. The source IDs in this repository stand in for People API resource names, because the CSV carries no ID.

## What has not been checked

- **No live Zoho test.** Every Zoho behaviour above is documented, none was observed here. The stand-in may differ from the real API, especially on custom fields, field lengths, picklists, lookups, notes and `DUPLICATE_DATA`. It rejects only a missing `Last_Name`, a batch over the limit and a bad ID, so its `Rejected 0` proves little about Zoho.
- **Accounts.** The rehearsal creates each new company through `/Accounts` before linking contacts by ID. That order is the plan, and the shape of the call has not been observed on Zoho.
- **Rate limits.** A 429 is retried at once in the rehearsal. A real run would wait for the time Zoho gives.
- **No export from a real Google account.** The ` ::: ` separator inside cells is modeled from general knowledge and did not appear in the public samples read. A five-contact export from a test account would confirm it, along with where a real export holds phone extensions. Columns such as Website or Relation are not in the table, so a real export holding them stops at the check until a rule is written.
- **Nothing ran on Zapier.**
- **The numbers** (10,780, 100 groups, 80 already in Zoho) are choices for the demonstration.
