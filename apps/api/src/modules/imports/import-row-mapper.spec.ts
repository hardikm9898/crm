import { describe, expect, it } from 'vitest';
import { mapImportRow, splitFullName } from './import-row-mapper.js';
import type { ImportCatalogue } from './import-catalogue.service.js';

/**
 * The mapper is pure, which is the point: "what does this cell mean" is testable without a
 * database, a tenant context or a queue, and the wizard's dry run and the real run therefore
 * cannot disagree about it.
 */
const catalogue: ImportCatalogue = {
  statuses: new Map([
    ['new', 'status-new'],
    ['site visit done', 'status-visit'],
  ]),
  stages: new Map([['enquiry', { id: 'stage-1', pipelineId: 'pipeline-1' }]]),
  sources: new Map([['walk in', 'source-walkin']]),
  owners: new Map([
    ['priya sharma', 'user-priya'],
    ['priya example test', 'user-priya'],
  ]),
  tags: new Map([['follow up', 'tag-follow']]),
  customFields: [
    {
      id: 'cf-1',
      key: 'budget',
      label: 'Budget',
      type: 'currency',
      isRequired: false,
      isActive: true,
      validation: null,
      entityType: 'lead',
      placeholder: null,
      helpText: null,
      defaultValue: null,
      sectionId: null,
      sortOrder: 0,
      showInList: false,
      isSearchable: false,
      isFilterable: true,
      isIndexed: false,
      isPii: false,
      options: [],
    },
    {
      id: 'cf-2',
      key: 'interests',
      label: 'Interests',
      type: 'multiselect',
      isRequired: false,
      isActive: true,
      validation: null,
      entityType: 'lead',
      placeholder: null,
      helpText: null,
      defaultValue: null,
      sectionId: null,
      sortOrder: 1,
      showInList: false,
      isSearchable: false,
      isFilterable: true,
      isIndexed: false,
      isPii: false,
      options: [],
    },
  ],
  defaultPhoneCountry: 'IN',
  defaultCurrency: 'INR',
  statusNames: ['New', 'Site visit done'],
  stageNames: ['Enquiry'],
  sourceNames: ['Walk in'],
};

const map = (record: Record<string, string>, mapping: Record<string, string>) =>
  mapImportRow(record, { mapping, catalogue });

describe('mapping a spreadsheet row onto a lead', () => {
  it('splits a full name only into the halves nothing else fills', () => {
    const both = map({ Name: 'Priya Sharma Nair' }, { Name: 'fullName' });
    expect(both.draft).toEqual({ firstName: 'Priya Sharma', lastName: 'Nair' });

    const explicit = map(
      { Name: 'Ignored Completely', First: 'Anita', Last: 'Rao' },
      { Name: 'fullName', First: 'firstName', Last: 'lastName' },
    );
    expect(explicit.draft).toEqual({ firstName: 'Anita', lastName: 'Rao' });
  });

  it('resolves a status by name, forgiving case and punctuation', () => {
    expect(map({ S: 'new' }, { S: 'statusId' }).draft['statusId']).toBe('status-new');
    expect(map({ S: 'Site  Visit-Done!' }, { S: 'statusId' }).draft['statusId']).toBe(
      'status-visit',
    );
  });

  it('reports an unknown status with the names that would have worked', () => {
    const result = map({ S: 'Qualified Later' }, { S: 'statusId' });
    expect(result.draft['statusId']).toBeUndefined();
    expect(result.errors[0]?.code).toBe('UNKNOWN_REFERENCE');
    // The list is what turns "unknown status" into something a person can fix.
    expect(result.errors[0]?.message).toContain('New');
  });

  it('never invents a status, a stage, a source or an owner', () => {
    const result = map(
      { S: 'Nope', T: 'Nope', U: 'Nope', O: 'Nobody' },
      { S: 'statusId', T: 'stageId', U: 'leadSourceId', O: 'assignedUserId' },
    );
    expect(result.errors.map((e) => e.field).sort()).toEqual([
      'assignedUserId',
      'leadSourceId',
      'stageId',
      'statusId',
    ]);
  });

  it('carries the pipeline a stage belongs to, so the composite FK is satisfiable', () => {
    const result = map({ Stage: 'Enquiry' }, { Stage: 'stageId' });
    expect(result.draft).toEqual({ stageId: 'stage-1', pipelineId: 'pipeline-1' });
  });

  it('matches an owner by name or by email address', () => {
    expect(map({ O: 'PRIYA SHARMA' }, { O: 'assignedUserId' }).draft['assignedUserId']).toBe(
      'user-priya',
    );
    expect(map({ O: 'priya@example.test' }, { O: 'assignedUserId' }).draft['assignedUserId']).toBe(
      'user-priya',
    );
  });

  it('reads an Indian-grouped amount as minor units', () => {
    expect(map({ B: '1,25,000' }, { B: 'value' }).draft).toEqual({
      valueMinor: 12_500_000,
      currency: 'INR',
    });
  });

  it('refuses a two-letter country code it cannot be sure of', () => {
    expect(map({ C: 'in' }, { C: 'country' }).draft['country']).toBe('IN');
    const full = map({ C: 'India' }, { C: 'country' });
    expect(full.errors[0]?.code).toBe('INVALID_COUNTRY');
    // Truncating "India" to "In" would be a lie that nobody would notice.
    expect(full.draft['country']).toBeUndefined();
  });

  it('reads a day-first date and refuses one in the future', () => {
    const past = map({ D: '15/03/2024' }, { D: 'createdAt' });
    expect(past.capturedAt?.toISOString().slice(0, 10)).toBe('2024-03-15');

    const future = map({ D: '01/01/2099' }, { D: 'createdAt' });
    expect(future.errors[0]?.code).toBe('FUTURE_DATE');
    expect(future.capturedAt).toBeNull();
  });

  it('separates a tag list on commas or semicolons without creating anything', () => {
    const result = map({ T: 'Follow up; Walk-in, VIP' }, { T: 'tags' });
    expect(result.tagNames).toEqual(['Follow up', 'Walk-in', 'VIP']);
    expect(result.errors).toEqual([]);
  });

  it('keeps a note out of the draft, because a lead has no note column', () => {
    const result = map({ R: 'Call after 6pm' }, { R: 'notes' });
    expect(result.note).toBe('Call after 6pm');
    expect(result.draft).toEqual({});
  });

  it('reads a yes or a no as consent, and refuses anything else', () => {
    expect(map({ W: 'Yes' }, { W: 'consentWhatsapp' }).draft).toEqual({
      consent: { whatsapp: true },
    });
    expect(map({ W: '0' }, { W: 'consentEmail' }).draft).toEqual({ consent: { email: false } });
    expect(map({ W: 'maybe' }, { W: 'consentCalls' }).errors[0]?.code).toBe('INVALID_BOOLEAN');
  });

  it('passes a custom field through as text, splitting only the multi-value types', () => {
    const result = map(
      { B: '45000', I: 'solar; batteries' },
      { B: 'custom.budget', I: 'custom.interests' },
    );
    // Coercion belongs to `validateCustomValues`, which owns every type's rules.
    expect(result.customValues).toEqual({ budget: '45000', interests: ['solar', 'batteries'] });
  });

  it('reports a mapping to a custom field that no longer exists', () => {
    const result = map({ X: 'anything' }, { X: 'custom.deleted_field' });
    expect(result.errors[0]?.code).toBe('UNKNOWN_FIELD');
  });

  it('reports a row of nothing as blank rather than as broken', () => {
    const result = map({ Name: '', Phone: '  ' }, { Name: 'fullName', Phone: 'phone' });
    expect(result.isBlank).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('treats a row with any value at all as a real row', () => {
    expect(map({ Name: 'Anita', Phone: '' }, { Name: 'fullName', Phone: 'phone' }).isBlank).toBe(
      false,
    );
  });

  it('leaves the phone for the lead service to normalize', () => {
    // Normalization needs the organization's country and belongs where every other caller gets it.
    expect(map({ P: ' 98765 43210 ' }, { P: 'phone' }).draft['phone']).toBe('98765 43210');
  });

  it('still refuses a phone number that cannot be read at all', () => {
    // The dry run has to be able to say so *before* the import. `createLeadSchema` only knows the
    // string is 4–32 characters, so without this check a column of rubbish reported as rows ready
    // to import and then failed every one of them at import time.
    const result = map({ P: 'not-a-phone' }, { P: 'phone' });
    expect(result.errors.map((error) => error.code)).toEqual(['INVALID_PHONE']);
    expect(result.draft['phone']).toBeUndefined();
  });

  it('accepts a number already in international form', () => {
    expect(map({ P: '+91 98450 12345' }, { P: 'whatsapp' }).draft['whatsapp']).toBe(
      '+91 98450 12345',
    );
  });
});

describe('splitting a name', () => {
  it('treats the last word as the surname and the rest as given names', () => {
    expect(splitFullName('Priya Sharma Nair')).toEqual({
      firstName: 'Priya Sharma',
      lastName: 'Nair',
    });
  });

  it('treats a single word as a first name, not a surname', () => {
    expect(splitFullName('Priya')).toEqual({ firstName: 'Priya', lastName: null });
  });

  it('survives extra spacing', () => {
    expect(splitFullName('  Anita   Rao  ')).toEqual({ firstName: 'Anita', lastName: 'Rao' });
  });
});
