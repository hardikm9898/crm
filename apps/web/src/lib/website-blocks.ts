import { request } from '@/lib/api';

/**
 * The web app's own copy of the block registry's shape (`FR-WEB-2`).
 *
 * Hand-written here for the reason `lib/automation.ts`, `lib/tasks.ts`, `lib/sla.ts` and
 * `lib/whatsapp.ts` all are: `@leados/shared`'s entry point reaches `node:async_hooks`, and a
 * client component that transitively imports it fails `next build` with "the chunking context does
 * not support external modules" — on whichever page happens to render it, not on the file that
 * imported it. `websites.spec.ts` reconciles this against the real registry, because a spec runs in
 * Node and may import both.
 *
 * **These are shapes, not content.** The block types, their labels and their fields come from
 * `GET /websites/block-catalogue` at runtime, which is what makes "adding a block type needs no
 * editor change" a claim about a running deployment rather than about a rebuild. Nothing in this
 * file lists a block type.
 */

export const BLOCK_PARAM_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'duration',
  'reference',
  'url',
  'string_list',
] as const;
export type BlockParamType = (typeof BLOCK_PARAM_TYPES)[number];

export interface BlockParamField {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly type: BlockParamType;
  readonly required: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly max?: number;
  readonly min?: number;
}

export interface BlockSpec {
  readonly type: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'content' | 'media' | 'action';
  readonly params: readonly BlockParamField[];
}

/** A block as the editor holds it and the API stores it. */
export interface PageBlock {
  readonly type: string;
  readonly params: Record<string, unknown>;
}

export async function loadBlockCatalogue(token: string | null): Promise<BlockSpec[]> {
  // The envelope lifts `items` into `data`, so this is the array.
  return (await request<BlockSpec[]>('/websites/block-catalogue', { token })).data;
}

/** A block the editor can add: its type, and every parameter at its default. */
export function blankBlock(spec: BlockSpec): PageBlock {
  const params: Record<string, unknown> = {};
  for (const field of spec.params) {
    if (field.type === 'boolean') params[field.key] = false;
    else if (field.type === 'string_list') params[field.key] = [];
    else if (field.type === 'select') params[field.key] = field.options?.[0]?.value ?? '';
    else params[field.key] = '';
  }
  return { type: spec.type, params };
}

/**
 * Turns a control's value into the value the API stores.
 *
 * Deliberately not `coerceParam` from `lib/automation`: that one predates `string_list` and would
 * store a list as the string somebody typed, which the API then refuses as `NOT_A_LIST` — a
 * refusal on a field the editor filled in correctly, which is the worst kind. The two could be one
 * function; merging them means touching a shipped editor, and the note in `websites.spec.ts` says
 * so rather than leaving the duplication to be discovered.
 */
export function coerceBlockParam(field: BlockParamField, raw: string | boolean): unknown {
  if (field.type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw !== 'boolean' && field.type === 'string_list') {
    // One item per line, blank lines dropped — which is what the hint on the control promises.
    const items = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return items;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (field.type === 'number' || field.type === 'duration') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return trimmed;
}

/** The value a control shows for a stored param. A list becomes its lines. */
export function controlValue(field: BlockParamField, value: unknown): string {
  if (field.type === 'string_list') {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : '';
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Drops the parameters nobody filled in, so an optional field left blank is absent rather than an
 * empty string.
 *
 * The API treats `''` as absent too, so this is not load-bearing for validation — it is what keeps
 * a published snapshot from carrying a dozen empty keys per block, which a reader of the version
 * history would have to look past.
 */
export function cleanBlocks(blocks: readonly PageBlock[]): PageBlock[] {
  return blocks.map((block) => {
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block.params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      params[key] = value;
    }
    return { type: block.type, params };
  });
}

export function moveBlock(blocks: readonly PageBlock[], from: number, to: number): PageBlock[] {
  if (to < 0 || to >= blocks.length) return [...blocks];
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...blocks];
  next.splice(to, 0, moved);
  return next;
}
