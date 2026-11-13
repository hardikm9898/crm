'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  blankBlock,
  cleanBlocks,
  coerceBlockParam,
  controlValue,
  moveBlock,
  type BlockParamField,
  type BlockSpec,
  type PageBlock,
} from '@/lib/website-blocks';
import type { WebsitePageRow } from '@/lib/websites';
import { savePage } from '../actions';

/**
 * The message for one field, or `undefined`.
 *
 * `fieldErrors` is a `Record<field, message>` keyed by the API's own `field` — which is why the
 * block validator addresses its problems as `blocks[2].params.heading`: the editor can then point
 * at the input that is wrong instead of printing one sentence at the top. The mapping editor paid
 * for the summary-only version of this once.
 */
function errorAt(state: ActionState, field: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[field] : undefined;
}

/** What was submitted, echoed back so a refused form can re-fill itself. */
function echoed(state: ActionState, field: string): string | undefined {
  return state.status === 'error' ? state.values?.[field] : undefined;
}

/**
 * The block editor (`FR-WEB-2`).
 *
 * **Every control on this screen is rendered from the catalogue**, never from a list in this file.
 * That is the step's exit criterion made structural: adding a block type is one declaration in
 * `packages/shared/src/website-blocks.ts` and one renderer in the published-site route, and this
 * file does not change. Search it for a block type's name and you will not find one.
 *
 * A block type still costs a renderer, because a block is a layout and a schema cannot describe
 * one — which is the half of Phase 6's registry argument that does **not** carry over, and is
 * stated in the registry itself.
 *
 * The page's blocks travel as one hidden JSON field. A form whose fields repeat cannot echo its
 * submission: `submittedValues` keeps one value per name, so a refusal would come back having
 * dropped every block but the last.
 */
export function BlockEditor({
  websiteId,
  page,
  catalogue,
}: {
  websiteId: string;
  page: WebsitePageRow;
  catalogue: readonly BlockSpec[];
}) {
  const [state, action, pending] = useActionState(savePage, IDLE);

  // Seeded from the echo on a refusal, so a rejected save does not lose the work. `state.values`
  // carries the submitted JSON back as one field, which is the entire reason the blocks are one
  // field.
  const echoedBlocks = echoed(state, 'blocks') ?? null;
  const [blocks, setBlocks] = useState<PageBlock[]>(() => {
    if (echoedBlocks !== null) {
      try {
        return JSON.parse(echoedBlocks) as PageBlock[];
      } catch {
        // Fall through to the stored page rather than render nothing.
      }
    }
    return (page.blocks as PageBlock[] | undefined) ?? [];
  });
  const [adding, setAdding] = useState('');

  const setParam = (index: number, field: BlockParamField, raw: string | boolean) => {
    setBlocks((current) =>
      current.map((block, at) =>
        at === index
          ? { ...block, params: { ...block.params, [field.key]: coerceBlockParam(field, raw) } }
          : block,
      ),
    );
  };

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="websiteId" value={websiteId} />
      <input type="hidden" name="pageId" value={page.id} />
      <input type="hidden" name="blocks" value={JSON.stringify(cleanBlocks(blocks))} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Page title" error={errorAt(state, 'title')}>
          <input
            name="title"
            defaultValue={echoed(state, 'title') ?? page.title}
            className={controlClassName}
            maxLength={200}
          />
        </Field>
        <Field label="Status" hint="A page is only published when the site is published too.">
          {/*
            `key` + `defaultValue`, not a controlled `value`: a select whose value only has to
            survive a refusal remounts exactly when the echo changes and is left alone while
            somebody is choosing. The guardrails form paid for the other shape — a reactive select
            is right only when choosing an option should reveal another field, which this does not.
          */}
          <select
            key={`status-${echoed(state, 'status') ?? page.status}`}
            name="status"
            defaultValue={echoed(state, 'status') ?? page.status}
            className={controlClassName}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
        </Field>
      </div>

      {blocks.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">
          This page has nothing on it yet. Add a block below.
        </p>
      )}

      {blocks.map((block, index) => {
        const spec = catalogue.find((entry) => entry.type === block.type);
        return (
          // The marker goes on a wrapper, not on `Card`: that component takes `title`,
          // `description`, `action` and `children` and spreads nothing, so a `data-` attribute
          // passed to it type-checks, renders, and is simply gone — a browser check asserting it
          // would fail on a screen that is correct.
          <div key={index} data-block-row={block.type}>
            <Card title={spec?.label ?? block.type} description={spec?.hint}>
              {spec === undefined ? (
                // A block this release cannot describe. The published site still renders what it can
                // (the renderer skips unknown types and draws the rest), so the editor says what it
                // is rather than dropping it on the next save — which would turn opening a page into
                // a destructive act.
                <p
                  className="text-sm text-[var(--color-text-muted)]"
                  data-unknown-block={block.type}
                >
                  This page has a “{block.type}” block that this version of the product does not
                  know how to edit. It is left exactly as it is, and the published site still shows
                  everything it can draw.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {spec.params.map((field) => (
                    <ParamControl
                      key={field.key}
                      field={field}
                      value={block.params[field.key]}
                      error={errorAt(state, `blocks[${index}].params.${field.key}`)}
                      onChange={(raw) => setParam(index, field, raw)}
                    />
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={index === 0}
                  onClick={() => setBlocks((current) => moveBlock(current, index, index - 1))}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={index === blocks.length - 1}
                  onClick={() => setBlocks((current) => moveBlock(current, index, index + 1))}
                >
                  Move down
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setBlocks((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </Button>
              </div>
              {errorAt(state, `blocks[${index}].type`) !== undefined && (
                <ErrorNotice>{errorAt(state, `blocks[${index}].type`)}</ErrorNotice>
              )}
            </Card>
          </div>
        );
      })}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Add a block">
          <select
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            className={controlClassName}
            data-add-block
          >
            <option value="">Choose a block…</option>
            {/* Grouped from the catalogue's own `group`, so a new group needs no change here. */}
            {[...new Set(catalogue.map((entry) => entry.group))].map((group) => (
              <optgroup key={group} label={group}>
                {catalogue
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={adding === ''}
          onClick={() => {
            const spec = catalogue.find((entry) => entry.type === adding);
            if (spec === undefined) return;
            setBlocks((current) => [...current, blankBlock(spec)]);
            setAdding('');
          }}
        >
          Add
        </Button>
      </div>

      {state.status === 'error' && state.message !== undefined && (
        <ErrorNotice>{state.message}</ErrorNotice>
      )}
      {state.status === 'success' && state.message !== undefined && (
        <p className="text-sm text-[var(--color-success)]" role="status">
          {state.message}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save page'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One control, chosen by the field's declared type.
 *
 * `lib/automation.ts` has a near-identical switch for the workflow editor. They are not merged
 * yet, deliberately: that one renders `reference` as a list fetched per kind, which no block uses,
 * and merging would mean reworking a shipped editor to serve a new one. `websites.spec.ts` records
 * the duplication so it is a known piece of work rather than a discovery.
 */
function ParamControl({
  field,
  value,
  error,
  onChange,
}: {
  field: BlockParamField;
  value: unknown;
  error?: string;
  onChange: (raw: string | boolean) => void;
}) {
  const shown = controlValue(field, value);

  if (field.type === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint} error={error}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </Field>
    );
  }

  if (field.type === 'select') {
    return (
      <Field label={field.label} hint={field.hint} error={error}>
        <select
          value={shown}
          onChange={(event) => onChange(event.target.value)}
          className={controlClassName}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === 'textarea' || field.type === 'string_list') {
    return (
      <Field
        label={field.label}
        hint={field.hint ?? (field.type === 'string_list' ? 'One per line.' : undefined)}
        error={error}
      >
        <textarea
          value={shown}
          onChange={(event) => onChange(event.target.value)}
          className={controlClassName}
          rows={field.type === 'string_list' ? 4 : 5}
        />
      </Field>
    );
  }

  return (
    <Field label={field.label} hint={field.hint} error={error}>
      <input
        // `url` gets `type="url"` so a phone keyboard offers the right keys, and nothing more: the
        // browser's own validation is not the guard. `isSafeBlockUrl` in the API is, because a
        // scheme allowlist is the thing that matters and a browser does not know ours.
        type={
          field.type === 'number' || field.type === 'duration'
            ? 'number'
            : field.type === 'url'
              ? 'url'
              : 'text'
        }
        value={shown}
        onChange={(event) => onChange(event.target.value)}
        className={controlClassName}
        {...(field.max !== undefined && field.type !== 'number' ? { maxLength: field.max } : {})}
      />
    </Field>
  );
}
