import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_COLUMNS,
  EXPORTABLE_LEAD_COLUMNS,
  exportIncludesPii,
  exportableColumns,
  unknownExportColumns,
} from './export-columns.js';

describe('the exportable column catalogue', () => {
  it('declares every column it offers, rather than deriving them from the table', () => {
    // A derived list would classify the next column somebody adds as non-personal by default,
    // which is the one mistake this catalogue exists to prevent.
    expect(EXPORTABLE_LEAD_COLUMNS.length).toBeGreaterThan(20);
    expect(new Set(EXPORTABLE_LEAD_COLUMNS.map((c) => c.key)).size).toBe(
      EXPORTABLE_LEAD_COLUMNS.length,
    );
  });

  it('marks the columns that identify a person', () => {
    const pii = new Set(EXPORTABLE_LEAD_COLUMNS.filter((c) => c.pii).map((c) => c.key));
    for (const key of ['fullName', 'firstName', 'lastName', 'phone', 'whatsapp', 'email']) {
      expect(pii.has(key), `${key} should be personal data`).toBe(true);
    }
    // A city alone is not, but with a name it is — which is why it is marked.
    expect(pii.has('city')).toBe(true);
  });

  it('does not mark workspace configuration as personal data', () => {
    const pii = new Set(EXPORTABLE_LEAD_COLUMNS.filter((c) => c.pii).map((c) => c.key));
    for (const key of ['status', 'stage', 'pipeline', 'source', 'priority', 'score', 'value']) {
      expect(pii.has(key), `${key} should not need export:pii`).toBe(false);
    }
  });

  it('gives a useful default that a person would recognise as their spreadsheet', () => {
    const known = new Set(EXPORTABLE_LEAD_COLUMNS.map((c) => c.key));
    for (const key of DEFAULT_EXPORT_COLUMNS) expect(known.has(key)).toBe(true);
    expect(DEFAULT_EXPORT_COLUMNS).toContain('fullName');
    expect(DEFAULT_EXPORT_COLUMNS).toContain('status');
  });

  it('adds custom fields and keeps their own PII flag', () => {
    const columns = exportableColumns([
      { key: 'aadhaar', label: 'Aadhaar number', type: 'text', isPii: true },
      { key: 'budget', label: 'Budget', type: 'currency', isPii: false },
      { key: 'bogus', label: 'Unknown type', type: 'not_a_type', isPii: true },
    ]);
    const keys = columns.map((c) => c.key);
    expect(keys).toContain('custom.aadhaar');
    expect(keys).toContain('custom.budget');
    // A definition whose type the registry does not know is left out rather than guessed at.
    expect(keys).not.toContain('custom.bogus');
    expect(columns.find((c) => c.key === 'custom.aadhaar')?.pii).toBe(true);
    expect(columns.find((c) => c.key === 'custom.budget')?.pii).toBe(false);
  });

  it('answers whether a chosen set contains personal data', () => {
    expect(exportIncludesPii(['company', 'status', 'value'])).toBe(false);
    expect(exportIncludesPii(['company', 'phone'])).toBe(true);
  });

  it('counts a custom PII field as personal data too', () => {
    const catalogue = exportableColumns([
      { key: 'aadhaar', label: 'Aadhaar number', type: 'text', isPii: true },
    ]);
    expect(exportIncludesPii(['company', 'custom.aadhaar'], catalogue)).toBe(true);
    expect(exportIncludesPii(['company'], catalogue)).toBe(false);
  });

  it('names the columns it does not know, so a refusal can quote them', () => {
    expect(unknownExportColumns(['fullName', 'secretSauce', 'custom.nope'])).toEqual([
      'secretSauce',
      'custom.nope',
    ]);
    expect(unknownExportColumns(DEFAULT_EXPORT_COLUMNS)).toEqual([]);
  });
});
