import { describe, expect, it } from 'vitest';
import { PARAM_TYPES } from './automation.js';
import {
  WEBSITE_BLOCKS,
  WEBSITE_BLOCK_TYPES,
  isSafeBlockUrl,
  isWebsiteBlockType,
  validateBlocks,
  websiteBlock,
} from './website-blocks.js';

describe('the block registry', () => {
  it('declares every type in the vocabulary, and nothing it does not', () => {
    expect(WEBSITE_BLOCKS.map((spec) => spec.type).sort()).toEqual([...WEBSITE_BLOCK_TYPES].sort());
  });

  it('uses only parameter types the shared vocabulary knows', () => {
    for (const spec of WEBSITE_BLOCKS) {
      for (const field of spec.params) {
        expect(PARAM_TYPES, `${spec.type}.${field.key}`).toContain(field.type);
      }
    }
  });

  it('gives every select its options, because a picker with no list renders empty', () => {
    // The same defect `REFERENCE_SOURCES` exists for, one registry over: a declaration a screen
    // cannot act on is half a feature, and an empty picker looks exactly like a workspace with
    // nothing configured.
    for (const spec of WEBSITE_BLOCKS) {
      for (const field of spec.params) {
        if (field.type === 'select') {
          expect((field.options ?? []).length, `${spec.type}.${field.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every field a label, since the editor renders from these and nothing else', () => {
    for (const spec of WEBSITE_BLOCKS) {
      expect(spec.label.length, spec.type).toBeGreaterThan(0);
      expect(spec.hint.length, spec.type).toBeGreaterThan(0);
      for (const field of spec.params) {
        expect(field.label.length, `${spec.type}.${field.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every text field a maximum, so a page cannot be a megabyte of prose', () => {
    for (const spec of WEBSITE_BLOCKS) {
      for (const field of spec.params) {
        if (field.type === 'text' || field.type === 'textarea' || field.type === 'url') {
          expect(field.max, `${spec.type}.${field.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has no duplicate parameter keys within a block', () => {
    for (const spec of WEBSITE_BLOCKS) {
      const keys = spec.params.map((field) => field.key);
      expect(new Set(keys).size, spec.type).toBe(keys.length);
    }
  });

  it('answers for a known type and not for an invented one', () => {
    expect(websiteBlock('hero')?.label).toBe('Hero');
    expect(websiteBlock('pricing_table_v2')).toBeUndefined();
    expect(isWebsiteBlockType('quote')).toBe(true);
    expect(isWebsiteBlockType('quote_v2')).toBe(false);
  });
});

describe('validateBlocks', () => {
  it('accepts an empty page', () => {
    expect(validateBlocks([])).toEqual([]);
  });

  it('refuses something that is not a list at all', () => {
    expect(validateBlocks({ type: 'hero' })[0]?.code).toBe('NOT_A_LIST');
  });

  it('accepts a well-formed page', () => {
    const problems = validateBlocks([
      { type: 'hero', params: { heading: 'Welcome', ctaHref: 'https://example.com' } },
      { type: 'heading', params: { text: 'Services', level: '2' } },
      { type: 'list', params: { items: ['One', 'Two'] } },
      { type: 'quote', params: { text: 'They were quick.', attribution: 'Asha' } },
      { type: 'whatsapp_cta', params: { phone: '+91 98450 12345' } },
    ]);
    expect(problems).toEqual([]);
  });

  /**
   * The asymmetry this registry is built on. Saving a block this release cannot draw is refused;
   * **rendering** one is tolerated, because a rollback to an older release's snapshot must not
   * blank a live site. Refusing on write and tolerating on read is the only pair that survives a
   * rollback, and this is the write half.
   */
  it('refuses a type it does not know, and names it', () => {
    const problems = validateBlocks([{ type: 'pricing_table_v2', params: {} }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('UNKNOWN_TYPE');
    expect(problems[0]?.field).toBe('blocks[0].type');
    expect(problems[0]?.message).toMatch(/pricing_table_v2/);
  });

  it('asks somebody to choose when the type is simply empty', () => {
    // "There is nothing called “”" is the message a validator gives somebody who has not filled the
    // field in yet, and the automation editor already paid for it once.
    const problems = validateBlocks([{ type: '', params: {} }]);
    expect(problems[0]?.message).toMatch(/Choose what kind of block/);
  });

  it('addresses a problem at the row it belongs to', () => {
    const problems = validateBlocks([
      { type: 'hero', params: { heading: 'Fine' } },
      { type: 'hero', params: {} },
    ]);
    // Printed against the row it names, not as a summary: the mapping editor paid for the
    // summary-only version of this.
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('blocks[1].params.heading');
  });

  it('treats whitespace as absent for a required field', () => {
    expect(validateBlocks([{ type: 'hero', params: { heading: '   ' } }])[0]?.code).toBe(
      'REQUIRED',
    );
  });

  it('does not require what is optional', () => {
    expect(validateBlocks([{ type: 'hero', params: { heading: 'Only this' } }])).toEqual([]);
  });

  it('enforces the maximum length', () => {
    const problems = validateBlocks([{ type: 'hero', params: { heading: 'x'.repeat(121) } }]);
    expect(problems[0]?.code).toBe('TOO_LONG');
    expect(problems[0]?.message).toMatch(/120 characters/);
  });

  it('refuses a select value that is not one of the options', () => {
    expect(validateBlocks([{ type: 'heading', params: { text: 'T', level: '9' } }])[0]?.code).toBe(
      'INVALID',
    );
  });

  it('refuses a list that is not a list of strings', () => {
    expect(validateBlocks([{ type: 'list', params: { items: 'One\nTwo' } }])[0]?.code).toBe(
      'NOT_A_LIST',
    );
    expect(validateBlocks([{ type: 'list', params: { items: [1, 2] } }])[0]?.code).toBe(
      'NOT_A_LIST',
    );
  });

  it('refuses a link that executes, and says what a link may start with', () => {
    const problems = validateBlocks([
      { type: 'hero', params: { heading: 'H', ctaHref: 'javascript:alert(1)' } },
    ]);
    expect(problems[0]?.code).toBe('INVALID');
    // The scheme is almost always the thing that is wrong, so the message names the ones allowed
    // rather than saying "invalid" and leaving somebody to retype the same address.
    expect(problems[0]?.message).toMatch(/http:\/\/, https:\/\/, mailto: or tel:/);
  });

  it('reports every problem on a page rather than stopping at the first', () => {
    const problems = validateBlocks([
      { type: 'hero', params: {} },
      { type: 'image', params: { src: 'javascript:alert(1)' } },
      { type: 'nope', params: {} },
    ]);
    // An editor that showed one problem at a time would make fixing a page a sequence of saves.
    expect(problems.map((problem) => problem.field)).toEqual([
      'blocks[0].params.heading',
      'blocks[1].params.src',
      'blocks[2].type',
    ]);
  });
});

describe('isSafeBlockUrl', () => {
  it('accepts the schemes a page legitimately links to', () => {
    for (const url of [
      'https://example.com/x',
      'http://example.com',
      'mailto:hello@example.com',
      'tel:+919845012345',
      '/about',
    ]) {
      expect(isSafeBlockUrl(url), url).toBe(true);
    }
  });

  it('refuses what executes, and a protocol-relative address', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example.com',
      'not a url',
    ]) {
      expect(isSafeBlockUrl(url), url).toBe(false);
    }
  });
});
