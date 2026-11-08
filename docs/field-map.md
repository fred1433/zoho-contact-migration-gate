# Field map: Google Contacts export to Zoho CRM Contacts

Field names are written from Zoho's documentation and were not read from a live org. On a real job, confirm them first with the Fields Metadata API. Fields starting with `Google_` are custom fields to create first. Zoho's feature list shows no custom fields on the Free edition.

| Google column | Zoho field | Rule |
|---|---|---|
| First Name | `First_Name` | As written, first member of a merge group |
| Last Name | `Last_Name` | Required by Zoho. If empty, the contact waits as an open case. Nothing is invented |
| Organization Name | `Account_Name` | Lookup |
| Organization Title | `Title` | |
| Notes | `Description` | Distinct notes from merged contacts are joined with a `---` line |
| E-mail 1, 2 | `Email`, `Secondary_Email` | Compared in lower case |
| E-mail 3 and up | `Google_Extra_Emails` | Separated by `; ` |
| Phone (Work) | `Phone` | Raw value kept, extension included |
| Phone (Mobile) | `Mobile` | Raw value kept |
| Phone (Home) | `Home_Phone` | Raw value kept |
| Phone (Other) | `Other_Phone` | Raw value kept. A slot already taken falls to the next free one |
| Further phones | `Google_Extra_Phones` | Separated by `; ` |
| Address 1, 2 | `Mailing_*`, `Other_*` | |
| Further addresses | `Google_Extra_Addresses` | |
| Labels | `Google_Labels` | Separated by `; `. Not Zoho tags, because Zoho's help page caps tags per record (5 on Standard, 10 above) |
| `* myContacts` | none | System label on every saved contact, so it carries no information. Dropped on purpose and only this one |
| Source ID | `Google_Source_IDs` | `account|ID`, `;` between merged sources. See `sync-plan.md` |

## Comparable form

A phone number is normalized to an E.164-style key with its extension (`+14155550102x204`) to compare and to spot duplicates. That key is never written to Zoho.

## Same person

Same normalized name and a shared email or phone. A shared email or phone under two names never merges on its own: a family inbox, a front desk and a home landline all look like that.
