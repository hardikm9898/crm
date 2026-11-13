import type { ParamField } from './automation.js';

/**
 * The block registry: what a page can be built from (`FR-WEB-2`).
 *
 * **Phase 6's registry argument applies and its conclusion does not**, which is the whole design of
 * this step. An automation action costs no frontend release because the editor renders its
 * parameters from a schema — and that half is true here too, which is why this file exists. But a
 * block type also costs a **renderer**, because a block is a layout and a schema cannot describe
 * one. So the honest claim is: adding a block type costs one declaration here and one renderer in
 * `apps/web`, and **zero editor code**.
 *
 * The other direction is checked by the compiler rather than at boot, which is a departure from the
 * automation registry worth stating. Automation resolves handlers dynamically inside the API, so
 * only a runtime check can reconcile them. The renderers here are one static object keyed
 * `Record<BlockType, …>`: a declared type with no renderer and a renderer nothing declares are both
 * **type errors**, caught by `pnpm typecheck` before anything runs. A boot check would be a weaker
 * version of a guarantee the build already gives.
 *
 * **Validation and rendering are deliberately asymmetric.** `validateBlocks` refuses an unknown
 * type, because nothing should be able to save a block this release cannot draw. The renderer
 * **tolerates** one, because a rollback to an older release's snapshot must not blank a live site.
 * Refusing on write and tolerating on read is not an inconsistency; it is the only pair that
 * survives a rollback.
 */

/** The block vocabulary. Prefixed, because `@leados/shared` is one barrel and `BLOCK_TYPES` is the
 * kind of generic name that turns the whole package into a `TS2308` the day something else wants it. */
export const WEBSITE_BLOCK_TYPES = [
  'heading',
  'text',
  'hero',
  'image',
  'list',
  'whatsapp_cta',
  'quote',
] as const;
export type WebsiteBlockType = (typeof WEBSITE_BLOCK_TYPES)[number];

export interface WebsiteBlockSpec {
  readonly type: WebsiteBlockType;
  readonly label: string;
  readonly hint: string;
  /** Groups the editor's "add a block" menu. Presentation, not behaviour. */
  readonly group: 'content' | 'media' | 'action';
  readonly params: readonly ParamField[];
}

/**
 * Every block type, with the fields an editor renders for it.
 *
 * The `key`s here are the keys the renderers read, and `website-blocks.spec.ts` is what keeps those
 * two in step — a declaration naming `heading` against a renderer reading `title` is a block whose
 * editor saves into a field nothing draws, which looks exactly like a renderer that is broken.
 */
export const WEBSITE_BLOCKS: readonly WebsiteBlockSpec[] = [
  {
    type: 'hero',
    label: 'Hero',
    hint: 'The first thing a visitor reads, with one call to action.',
    group: 'content',
    params: [
      { key: 'heading', label: 'Heading', type: 'text', required: true, max: 120 },
      { key: 'subheading', label: 'Subheading', type: 'textarea', required: false, max: 400 },
      { key: 'ctaLabel', label: 'Button label', type: 'text', required: false, max: 40 },
      {
        key: 'ctaHref',
        label: 'Button link',
        hint: 'A web address, an email (mailto:) or a phone number (tel:).',
        type: 'url',
        required: false,
        max: 500,
      },
    ],
  },
  {
    type: 'heading',
    label: 'Heading',
    hint: 'A section title.',
    group: 'content',
    params: [
      { key: 'text', label: 'Text', type: 'text', required: true, max: 120 },
      {
        key: 'level',
        label: 'Size',
        type: 'select',
        required: false,
        options: [
          { value: '1', label: 'Largest' },
          { value: '2', label: 'Large' },
          { value: '3', label: 'Medium' },
        ],
      },
    ],
  },
  {
    type: 'text',
    label: 'Paragraphs',
    hint: 'Blank lines separate paragraphs.',
    group: 'content',
    params: [{ key: 'body', label: 'Text', type: 'textarea', required: true, max: 4000 }],
  },
  {
    type: 'quote',
    label: 'Quote',
    hint: 'A testimonial, in the customer’s own words.',
    group: 'content',
    params: [
      { key: 'text', label: 'Quote', type: 'textarea', required: true, max: 600 },
      { key: 'attribution', label: 'Who said it', type: 'text', required: false, max: 120 },
    ],
  },
  {
    type: 'list',
    label: 'List',
    hint: 'One item per line.',
    group: 'content',
    params: [{ key: 'items', label: 'Items', type: 'string_list', required: true, max: 40 }],
  },
  {
    type: 'image',
    label: 'Image',
    hint: 'A picture, by its web address.',
    group: 'media',
    params: [
      { key: 'src', label: 'Image address', type: 'url', required: true, max: 500 },
      {
        key: 'alt',
        label: 'Description',
        hint: 'What the picture shows, for somebody who cannot see it. Leave empty if it is decorative.',
        type: 'text',
        required: false,
        max: 200,
      },
    ],
  },
  {
    type: 'whatsapp_cta',
    label: 'WhatsApp button',
    hint: 'Opens a WhatsApp chat with this number.',
    group: 'action',
    params: [
      {
        key: 'phone',
        label: 'Number',
        hint: 'With the country code, e.g. +91 98450 12345.',
        type: 'text',
        required: true,
        max: 24,
      },
      { key: 'label', label: 'Button label', type: 'text', required: false, max: 40 },
    ],
  },
];

const BY_TYPE = new Map(WEBSITE_BLOCKS.map((spec) => [spec.type, spec]));

export function websiteBlock(type: string): WebsiteBlockSpec | undefined {
  return BY_TYPE.get(type as WebsiteBlockType);
}

export function isWebsiteBlockType(type: unknown): type is WebsiteBlockType {
  return typeof type === 'string' && BY_TYPE.has(type as WebsiteBlockType);
}

/** A problem, addressed at the row it belongs to so a screen can print it there. */
export interface BlockProblem {
  readonly field: string;
  readonly code: 'UNKNOWN_TYPE' | 'REQUIRED' | 'TOO_LONG' | 'NOT_A_LIST' | 'INVALID';
  readonly message: string;
}

const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Whether a URL is one a page may link to.
 *
 * The same rule the renderer applies, stated once: `apps/web` has its own copy for the reason every
 * `lib/*` module in that app does — importing this package from a client component fails
 * `next build` — and `websites.spec.ts` there reconciles the two.
 */
export function isSafeBlockUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/')) return true;
  try {
    return SAFE_URL_SCHEMES.includes(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/**
 * Checks a page's blocks against the registry.
 *
 * Returns problems addressed as `blocks[2].params.heading`, so a screen prints each one against the
 * field it names rather than as a summary. The mapping editor paid for the summary-only version of
 * this once: "that field mapping cannot be used" with the sentence somebody could act on discarded.
 */
export function validateBlocks(blocks: unknown): BlockProblem[] {
  if (!Array.isArray(blocks)) {
    return [{ field: 'blocks', code: 'NOT_A_LIST', message: 'A page’s blocks must be a list.' }];
  }
  const problems: BlockProblem[] = [];

  blocks.forEach((raw, index) => {
    const at = `blocks[${index}]`;
    const block = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      type?: unknown;
      params?: unknown;
    };
    const spec = typeof block.type === 'string' ? websiteBlock(block.type) : undefined;
    if (!spec) {
      // Refused on write even though the renderer tolerates it on read: nothing should be able to
      // save a block this release cannot draw, while a snapshot from a newer release must still
      // render after a rollback.
      problems.push({
        field: `${at}.type`,
        code: 'UNKNOWN_TYPE',
        message:
          typeof block.type === 'string' && block.type.length > 0
            ? `There is no block called “${block.type}”.`
            : 'Choose what kind of block this is.',
      });
      return;
    }

    const params = (
      typeof block.params === 'object' && block.params !== null ? block.params : {}
    ) as Record<string, unknown>;

    for (const field of spec.params) {
      const value = params[field.key];
      const where = `${at}.params.${field.key}`;
      const absent =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim().length === 0) ||
        (Array.isArray(value) && value.length === 0);

      if (absent) {
        if (field.required) {
          problems.push({
            field: where,
            code: 'REQUIRED',
            message: `${field.label} is needed.`,
          });
        }
        continue;
      }

      if (field.type === 'string_list') {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          problems.push({
            field: where,
            code: 'NOT_A_LIST',
            message: `${field.label} must be a list of lines.`,
          });
          continue;
        }
        if (field.max !== undefined && value.length > field.max) {
          problems.push({
            field: where,
            code: 'TOO_LONG',
            message: `${field.label} can have at most ${field.max} items.`,
          });
        }
        continue;
      }

      if (field.type === 'select') {
        const allowed = (field.options ?? []).map((option) => option.value);
        if (!allowed.includes(String(value))) {
          problems.push({
            field: where,
            code: 'INVALID',
            message: `Choose one of the available options for ${field.label.toLowerCase()}.`,
          });
        }
        continue;
      }

      if (typeof value !== 'string') {
        problems.push({
          field: where,
          code: 'INVALID',
          message: `${field.label} must be text.`,
        });
        continue;
      }

      if (field.max !== undefined && value.length > field.max) {
        problems.push({
          field: where,
          code: 'TOO_LONG',
          message: `${field.label} can be at most ${field.max} characters.`,
        });
        continue;
      }

      if (field.type === 'url' && !isSafeBlockUrl(value)) {
        problems.push({
          field: where,
          code: 'INVALID',
          // Named rather than hinted: a refusal that says "invalid" leaves somebody retyping the
          // same address, and the thing actually wrong is almost always the scheme.
          message:
            'That link must start with http://, https://, mailto: or tel:, or be a path on this site like /about.',
        });
      }
    }
  });

  return problems;
}
