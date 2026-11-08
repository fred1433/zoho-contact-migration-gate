// Every column of a Google Contacts export gets a destination or a written reason. A non-empty column missing from this
// table stops the check, so a column nobody thought about cannot disappear quietly.
export const COLUMN_RULES = [
  [/^First Name$/, { to: 'First_Name' }],
  [/^Middle Name$/, { to: 'Google_Middle_Name' }],
  [/^Last Name$/, { to: 'Last_Name' }],
  [/^Phonetic First Name$/, { to: 'Google_Phonetic_First' }],
  [/^Phonetic Middle Name$/, { to: 'Google_Phonetic_Middle' }],
  [/^Phonetic Last Name$/, { to: 'Google_Phonetic_Last' }],
  [/^Name Prefix$/, { to: 'Salutation' }],
  [/^Name Suffix$/, { to: 'Google_Name_Suffix' }],
  [/^Nickname$/, { to: 'Google_Nickname' }],
  [/^File As$/, { to: 'Google_File_As' }],
  [/^Organization Name$/, { to: 'Account_Name' }],
  [/^Organization Title$/, { to: 'Title' }],
  [/^Organization Department$/, { to: 'Department' }],
  [/^Birthday$/, { to: 'Date_of_Birth' }],
  [/^Notes$/, { to: 'Description' }],
  [/^Photo$/, { reason: 'A link to a Google-hosted image. Photos are outside this archive and are listed as not covered.' }],
  [/^Labels$/, { to: 'Google_Labels' }],
  [/^E-mail \d+ - Value$/, { to: 'Email, Secondary_Email, Google_Extra_Emails' }],
  [/^E-mail \d+ - Label$/, { reason: "Zoho's email fields have no label to hold Work or Home, and no check depends on it." }],
  [/^Phone \d+ - Value$/, { to: 'Phone, Mobile, Home_Phone, Other_Phone, Google_Extra_Phones' }],
  [/^Phone \d+ - Label$/, { reason: 'Used to choose the Zoho phone field, then not stored.' }],
  [/^Address \d+ - (Street|City|Region|Postal Code|Country|PO Box|Extended Address)$/, { to: 'Mailing_*, Other_*, Google_Extra_Addresses' }],
  [/^Address \d+ - Formatted$/, { reason: 'Google builds it from the address parts. Used only if a row has no parts.' }],
  [/^Address \d+ - Label$/, { reason: 'Used to order nothing. The first two addresses fill Mailing and Other in export order.' }],
];

export function ruleFor(column) {
  for (const [pattern, rule] of COLUMN_RULES) if (pattern.test(column)) return rule;
  return null;
}
