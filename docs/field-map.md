# Field map: Google Contacts export to Zoho CRM Contacts

Field names are written from Zoho's documentation and were not read from a live org. They still need confirming with the Fields Metadata API on the real org. Fields starting with `Google_` are custom fields that must exist first, and Zoho's feature list shows no custom fields on the Free edition. `Salutation` is a picklist in Zoho, so a prefix outside its values may need adding.

`src/field-map.js` holds the same table in code. A non-empty column missing from it holds the merge.

| Google column | Zoho field | Rule |
|---|---|---|
| First Name, Last Name | `First_Name`, `Last_Name` | From the mixed-case member of a merge group. `Last_Name` is required by Zoho: if empty, the contact waits as an open case and nothing is invented |
| Middle Name | `Google_Middle_Name` | |
| Name Prefix | `Salutation` | |
| Name Suffix | `Google_Name_Suffix` | |
| Nickname | `Google_Nickname` | |
| Phonetic First, Middle, Last Name | `Google_Phonetic_First`, `_Middle`, `_Last` | |
| File As | `Google_File_As` | |
| Organization Name | `Account_Name` | Lookup, see Accounts below |
| Organization Title | `Title` | |
| Organization Department | `Department` | |
| Birthday | `Date_of_Birth` | |
| Notes | `Description` | Distinct notes from merged contacts are joined with a `---` line |
| E-mail 1, 2 | `Email`, `Secondary_Email` | Compared in lower case |
| E-mail 3 and up | `Google_Extra_Emails` | Separated by `; ` |
| Phone (Work) | `Phone` | Raw value kept, extension included |
| Phone (Mobile) | `Mobile` | Raw value kept |
| Phone (Home) | `Home_Phone` | Raw value kept |
| Phone (Other) | `Other_Phone` | Raw value kept. A slot already taken falls to the next free one |
| Further phones | `Google_Extra_Phones` | Separated by `; ` |
| Address 1, 2 | `Mailing_*`, `Other_*` | A partial address keeps its parts |
| Further addresses, or any with a PO box or extended address | `Google_Extra_Addresses` | Street, city, region, postal code, country, PO box and extended address, in that order |
| Labels | `Google_Labels` | Separated by `; `. Not Zoho tags, because Zoho's help page caps tags per record (5 on Standard, 10 above) |
| `* myContacts` | none | System label on every saved contact, so it carries no information. Dropped on purpose and only this one |
| Second value of a single field in a merge group | `Google_Extra_Values` | `kind:value`, so two companies or two titles both survive |
| Source ID | `Google_Source_IDs` | `account|ID`, `;` between merged sources. See `sync-plan.md` |

Columns kept out, each with a written reason in `src/field-map.js`: Photo, the E-mail, Phone and Address labels, and Address Formatted.

## Records Zoho already holds

The import fills empty fields only. Anything Zoho holds stays, including the account ID. If Zoho and Google hold different values in one field, the record is left as it was and the contact becomes an open case. Two emails are not a disagreement: Zoho's stay first and Google's follow.

## Accounts

Each new company becomes a Zoho account before any contact points to it, so that a contact links by ID. A company name already known from the snapshot links to that account. A name that two Zoho accounts share is not guessed: the contact waits for a person. An existing contact keeps the account ID it had.

## Comparable form

A phone number is normalized to a key with its extension (`+14155550102x204`) to compare and to spot duplicates. That key is never written to Zoho. A number starting with a plus sign keeps its country code. A number with no plus sign is read as North American, so a local number from elsewhere would compare wrongly. `ext`, `extension`, `x`, `#` and `;` are read as extension marks.

## Same person

Same normalized name and a shared email or phone. A shared email or phone under two names never merges on its own: a family inbox, a front desk and a home landline all look like that.
