import { describe, expect, it } from 'vitest';
import {
  INDUSTRY_TEMPLATES,
  INDUSTRY_TEMPLATE_KEYS,
  findIndustryTemplate,
  summariseIndustryTemplate,
} from './industry-templates.js';

/**
 * The catalogue is data, so these are the assertions that keep the data honest — the ones a
 * template with a typo in it would fail. The product never checks which template a workspace chose,
 * so there is no behaviour to test here; there is only "is each of these a workspace that works".
 */
describe('the industry template catalogue', () => {
  it('covers the ten industries FR-ONB-2 names', () => {
    expect(INDUSTRY_TEMPLATES).toHaveLength(10);
    expect(INDUSTRY_TEMPLATE_KEYS).toEqual([
      'real_estate',
      'education',
      'healthcare',
      'automobile',
      'ecommerce',
      'fitness',
      'salon',
      'travel',
      'professional_services',
      'home_services',
    ]);
  });

  it('has a unique key and a sentence of description for each', () => {
    expect(new Set(INDUSTRY_TEMPLATE_KEYS).size).toBe(INDUSTRY_TEMPLATES.length);
    for (const template of INDUSTRY_TEMPLATES) {
      expect(template.name.length, template.key).toBeGreaterThan(2);
      // A picker with a one-word description is a picker nobody can choose from.
      expect(template.description.length, template.key).toBeGreaterThan(40);
    }
  });

  it('gives every workspace exactly one default status, and somewhere to put a won lead', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      const defaults = template.statuses.filter((status) => status.isDefault);
      // `lead_statuses_one_default_per_org` is a partial unique index: two defaults would be
      // refused by the database, and none would make lead creation fail with no default to use.
      expect(defaults, template.key).toHaveLength(1);
      expect(defaults[0]?.category, template.key).toBe('open');
      expect(
        template.statuses.some((status) => status.category === 'won'),
        template.key,
      ).toBe(true);
      expect(
        template.statuses.some((status) => status.category === 'lost'),
        template.key,
      ).toBe(true);
    }
  });

  it('gives every pipeline exactly one won stage and one lost stage', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      expect(
        template.stages.filter((stage) => stage.isWon),
        template.key,
      ).toHaveLength(1);
      expect(
        template.stages.filter((stage) => stage.isLost),
        template.key,
      ).toHaveLength(1);
      // A deal moved to the won stage takes its probability; anything but 100 is a forecast that
      // discounts money already in the bank.
      expect(template.stages.find((stage) => stage.isWon)?.probability, template.key).toBe(100);
      expect(template.stages.find((stage) => stage.isLost)?.probability, template.key).toBe(0);
    }
  });

  it('keeps every stage probability inside the range the database allows', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      for (const stage of template.stages) {
        expect(stage.probability, `${template.key}/${stage.name}`).toBeGreaterThanOrEqual(0);
        expect(stage.probability, `${template.key}/${stage.name}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('orders the open stages by increasing probability, because a board is read left to right', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      const open = template.stages.filter((stage) => !stage.isWon && !stage.isLost);
      const probabilities = open.map((stage) => stage.probability);
      expect(
        [...probabilities].sort((a, b) => a - b),
        template.key,
      ).toEqual(probabilities);
    }
  });

  it('never repeats a name inside one list, which a unique index would refuse', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      for (const [label, names] of [
        ['statuses', template.statuses.map((row) => row.name)],
        ['stages', template.stages.map((row) => row.name)],
        ['sources', template.sources.map((row) => row.name)],
        ['lost reasons', template.lostReasons.map((row) => row.name)],
        ['tags', template.tags.map((row) => row.name)],
        ['field keys', template.fields.map((row) => row.key)],
        ['views', template.views.map((row) => row.name)],
      ] as const) {
        expect(new Set(names).size, `${template.key} ${label}`).toBe(names.length);
      }
    }
  });

  it('gives a select field its options, and nothing else options it cannot use', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      for (const field of template.fields) {
        const needsOptions = field.type === 'select' || field.type === 'multiselect';
        if (needsOptions) {
          expect(field.options?.length ?? 0, `${template.key}/${field.key}`).toBeGreaterThan(1);
        } else {
          expect(field.options, `${template.key}/${field.key}`).toBeUndefined();
        }
      }
    }
  });

  it('uses snake_case field keys, because they become API property names', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      for (const field of template.fields) {
        expect(field.key, `${template.key}/${field.key}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('writes every colour as a six-digit hex, which the colour column expects', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      for (const colour of [
        ...template.statuses.map((row) => row.colour),
        ...template.stages.map((row) => row.colour),
        ...template.tags.map((row) => row.colour),
      ]) {
        expect(colour, `${template.key} ${colour}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('gives each saved view a filter that names a status the template installs', () => {
    // A view seeded against a status the template does not create is a list that is always empty,
    // which is worse than no view at all.
    for (const template of INDUSTRY_TEMPLATES) {
      const statusNames = new Set(template.statuses.map((status) => status.name));
      for (const view of template.views) {
        const conditions =
          (view.filters as { conditions?: { value?: unknown }[] }).conditions ?? [];
        expect(conditions.length, `${template.key}/${view.name}`).toBeGreaterThan(0);
        for (const condition of conditions) {
          if (typeof condition.value === 'string') {
            expect(statusNames, `${template.key}/${view.name}`).toContain(condition.value);
          }
        }
      }
    }
  });

  it('finds a template by key, and nothing by a key it does not have', () => {
    expect(findIndustryTemplate('real_estate')?.name).toBe('Real estate');
    expect(findIndustryTemplate('underwater_basket_weaving')).toBeUndefined();
  });

  it('summarises a template as the counts a picker needs', () => {
    const summary = summariseIndustryTemplate(findIndustryTemplate('education')!);
    expect(summary.key).toBe('education');
    expect(summary.statuses).toBeGreaterThan(4);
    expect(summary.fields).toBeGreaterThan(2);
    expect(summary.fieldLabels).toContain('Course');
  });
});
