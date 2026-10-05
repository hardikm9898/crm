import { describe, expect, it } from 'vitest';
import {
  IMPORTABLE_LEAD_FIELDS,
  IMPORT_MODE_SPECS,
  IMPORT_MODES,
  importableFields,
  normalizeHeader,
  parseAmount,
  parseBoolean,
  parseSpreadsheetDate,
  proposeMapping,
  splitList,
  validateMapping,
} from './import-mapping.js';

describe('proposing a mapping from real spreadsheet headers', () => {
  it('matches the headers an old CRM exports', () => {
    // The point of the aliases: a mapping screen that proposes nothing leaves a person to pick
    // thirty columns by hand, which is where imports get abandoned.
    const { mapping, unmatched } = proposeMapping([
      'Full Name',
      'Mobile No.',
      'E-mail ID',
      'Company Name',
      'Lead Source',
      'Assigned To',
      'Pincode',
      'Deal Value',
    ]);
    expect(mapping).toEqual({
      'Full Name': 'fullName',
      'Mobile No.': 'phone',
      'E-mail ID': 'email',
      'Company Name': 'company',
      'Lead Source': 'leadSourceId',
      'Assigned To': 'assignedUserId',
      Pincode: 'postalCode',
      'Deal Value': 'value',
    });
    expect(unmatched).toEqual([]);
  });

  it('matches a field by its own name and by its label', () => {
    expect(proposeMapping(['firstName', 'Last name']).mapping).toEqual({
      firstName: 'firstName',
      'Last name': 'lastName',
    });
  });

  it('reports a column it cannot place rather than dropping it', () => {
    const { mapping, unmatched } = proposeMapping(['Name', 'Favourite colour']);
    expect(mapping).toEqual({ Name: 'fullName' });
    expect(unmatched).toEqual(['Favourite colour']);
  });

  it('refuses to guess when two columns claim the same field', () => {
    // Importing the fax number as the mobile is worse than asking.
    const { mapping, ambiguous, unmatched } = proposeMapping(['Mobile', 'Phone No']);
    expect(mapping).toEqual({});
    expect(ambiguous).toEqual([{ field: 'phone', headers: ['Mobile', 'Phone No'] }]);
    expect(unmatched).toEqual(['Mobile', 'Phone No']);
  });

  it('ignores an empty header', () => {
    expect(proposeMapping(['Name', '', '  ']).unmatched).toEqual([]);
  });

  it('normalizes punctuation, case and spacing', () => {
    expect(normalizeHeader('Mobile No.')).toBe('mobile no');
    expect(normalizeHeader('E-MAIL_ID')).toBe('e mail id');
  });

  it('matches a header whose punctuation splits a word the alias keeps together', () => {
    // `E-mail ID` normalizes to `e mail id`, which no alias list would contain. The compacted
    // second pass covers every hyphenation and spacing variant without enumerating them.
    expect(proposeMapping(['E-mail ID']).mapping).toEqual({ 'E-mail ID': 'email' });
    expect(proposeMapping(['Pin-Code']).mapping).toEqual({ 'Pin-Code': 'postalCode' });
    expect(proposeMapping(['first  name']).mapping).toEqual({ 'first  name': 'firstName' });
  });

  it('includes this tenant’s custom fields, under a prefix a column cannot collide with', () => {
    const fields = importableFields([
      { key: 'budget', label: 'Budget', type: 'currency' },
      { key: 'interested_in', label: 'Interested in', type: 'multiselect' },
      { key: 'site_visit_on', label: 'Site visit on', type: 'date' },
    ]);
    const budget = fields.find((field) => field.field === 'custom.budget');
    expect(budget?.kind).toBe('money');
    expect(fields.find((field) => field.field === 'custom.interested_in')?.kind).toBe('tags');
    expect(fields.find((field) => field.field === 'custom.site_visit_on')?.kind).toBe('date');
  });

  it('proposes a custom field from its key, so `site_visit_on` matches "Site visit on"', () => {
    const fields = importableFields([
      { key: 'site_visit_on', label: 'Site visit on', type: 'date' },
    ]);
    expect(proposeMapping(['Site Visit On'], fields).mapping).toEqual({
      'Site Visit On': 'custom.site_visit_on',
    });
  });

  it('describes every field it offers', () => {
    for (const field of IMPORTABLE_LEAD_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(Array.isArray(field.aliases)).toBe(true);
    }
  });
});

describe('a mapping is checked before anything is written', () => {
  const headers = ['Name', 'Mobile', 'City', 'Spare'];

  it('accepts a mapping with a name and an identifier', () => {
    expect(validateMapping({ Name: 'fullName', Mobile: 'phone', City: 'city' }, headers)).toEqual(
      [],
    );
  });

  it('refuses a file with no way to identify a person', () => {
    // Ten thousand rows that cannot be deduplicated, called, or matched to anything later is worse
    // than importing none, and it cannot be undone by hand.
    const problems = validateMapping({ Name: 'fullName', City: 'city' }, headers);
    expect(problems.map((problem) => problem.code)).toContain('NO_IDENTIFIER');
    expect(problems.find((problem) => problem.code === 'NO_IDENTIFIER')?.message).toContain(
      'deduplicated',
    );
  });

  it('refuses a file with no name', () => {
    expect(validateMapping({ Mobile: 'phone' }, headers).map((problem) => problem.code)).toContain(
      'NO_NAME',
    );
  });

  it('accepts a first or last name as a name', () => {
    expect(validateMapping({ Name: 'firstName', Mobile: 'phone' }, headers)).toEqual([]);
    expect(validateMapping({ Name: 'lastName', Mobile: 'whatsapp' }, headers)).toEqual([]);
  });

  it('refuses two columns mapped to one field', () => {
    const problems = validateMapping({ Name: 'fullName', Mobile: 'phone', City: 'phone' }, headers);
    expect(problems.map((problem) => problem.code)).toContain('DUPLICATE_TARGET');
  });

  it('refuses a column the file does not have', () => {
    const problems = validateMapping({ Nmae: 'fullName', Mobile: 'phone' }, headers);
    expect(problems[0]?.code).toBe('UNKNOWN_COLUMN');
    expect(problems[0]?.message).toContain('Nmae');
  });

  it('refuses a field an import cannot fill', () => {
    const problems = validateMapping({ Name: 'fullName', Mobile: 'phone', City: 'score' }, headers);
    expect(problems.map((problem) => problem.code)).toContain('UNKNOWN_FIELD');
  });
});

describe('the three modes say what they do', () => {
  it('describes each one', () => {
    for (const mode of IMPORT_MODES) {
      expect(IMPORT_MODE_SPECS[mode].label.length).toBeGreaterThan(0);
      expect(IMPORT_MODE_SPECS[mode].describe.length).toBeGreaterThan(20);
    }
  });

  it('names the duplicate rules in the default mode, because that is what it uses', () => {
    expect(IMPORT_MODE_SPECS.create_only.describe).toContain('duplicate rules');
  });
});

describe('reading cells a person formatted', () => {
  it('splits a list the way people write one', () => {
    expect(splitList('hot, site visit ; referral')).toEqual(['hot', 'site visit', 'referral']);
    expect(splitList('')).toEqual([]);
    expect(splitList(' , ,')).toEqual([]);
  });

  it('reads the ways a spreadsheet says yes and no', () => {
    for (const yes of ['Yes', 'y', 'TRUE', '1']) expect(parseBoolean(yes)).toBe(true);
    for (const no of ['No', 'n', 'false', '0']) expect(parseBoolean(no)).toBe(false);
    expect(parseBoolean('maybe')).toBeNull();
  });

  it('reads an amount through formatting, including lakh grouping', () => {
    // Indian grouping writes 1,250,000 as `12,50,000` — several commas, the last of them three
    // digits from the end, which a "comma means decimal" rule reads as 12.5 and silently imports a
    // deal worth twelve and a half rupees.
    expect(parseAmount('₹ 12,50,000')).toBe(1250000);
    expect(parseAmount('1,250,000')).toBe(1250000);
    expect(parseAmount('2500000.50')).toBe(2500000.5);
    expect(parseAmount('2,500')).toBe(2500);
    // European formatting: dots group and the comma is the decimal point.
    expect(parseAmount('1.250,00')).toBe(1250);
    expect(parseAmount('99,99')).toBe(99.99);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('not a number')).toBeNull();
  });

  it('reads a date as day-first, which is how this market writes them', () => {
    expect(parseSpreadsheetDate('05/10/2026').date?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(parseSpreadsheetDate('5-10-26').date?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('flags a date that could be read either way', () => {
    // A file whose dates are silently transposed for eleven months of the year is worse than one
    // that says it is unsure.
    expect(parseSpreadsheetDate('05/10/2026').ambiguous).toBe(true);
    expect(parseSpreadsheetDate('25/10/2026').ambiguous).toBe(false);
    expect(parseSpreadsheetDate('10/10/2026').ambiguous).toBe(false);
  });

  it('reads an unambiguous American date the other way round rather than refusing', () => {
    const read = parseSpreadsheetDate('10/25/2026');
    expect(read.date?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(read.ambiguous).toBe(false);
  });

  it('rejects a date that does not exist', () => {
    expect(parseSpreadsheetDate('31/02/2026').date).toBeNull();
    expect(parseSpreadsheetDate('99/99/9999').date).toBeNull();
  });

  it('reads an ISO date', () => {
    expect(parseSpreadsheetDate('2026-10-05').date?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('returns nothing for an empty cell rather than today', () => {
    expect(parseSpreadsheetDate('   ').date).toBeNull();
  });
});

describe('dates a spreadsheet actually exports', () => {
  it('reads a day-first date with a time after it', () => {
    // Without dropping the time this fell through to `new Date()`, which reads `14/02/2026` as
    // invalid — so every dated row of such a file failed for a reason nobody could see.
    const result = parseSpreadsheetDate('14/02/2026 10:30');
    expect(result.date?.toISOString().slice(0, 10)).toBe('2026-02-14');
  });

  it('reads back the timestamp format an export writes', () => {
    // The export writes `YYYY-MM-DD HH:mm`, and `FR-IO-1` requires re-importing a corrected export.
    expect(parseSpreadsheetDate('2026-09-26 19:42').date?.getFullYear()).toBe(2026);
  });

  it('still refuses a day that does not exist', () => {
    expect(parseSpreadsheetDate('31/02/2026 09:00').date).toBeNull();
  });
});
