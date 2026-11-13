'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { WebsiteDetail, WebsitePageRow, WebsiteVersionRow } from '@/lib/websites';
import {
  createPage,
  createWebsite,
  deletePage,
  makeHome,
  publishSite,
  rollbackSite,
  saveTheme,
  unpublishSite,
} from '../actions';

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

function Result({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'error' && state.message !== undefined) {
    return <ErrorNotice>{state.message}</ErrorNotice>;
  }
  if (state.status === 'success' && state.message !== undefined) {
    return (
      <p className="text-sm text-[var(--color-success)]" role="status">
        {state.message}
      </p>
    );
  }
  return null;
}

export function NewWebsiteForm() {
  const [state, action, pending] = useActionState(createWebsite, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Name" error={errorAt(state, 'name')}>
          <input
            name="name"
            required
            maxLength={200}
            // Echoed back on a refusal, so a rejected submission does not mean retyping. A server
            // action re-renders the server tree and remounts the form, which empties every
            // uncontrolled input unless the submission comes back.
            defaultValue={echoed(state, 'name') ?? ''}
            className={controlClassName}
          />
        </Field>
        <Field
          label="Address"
          hint="Letters, numbers and hyphens. This is where the site will be served."
          error={errorAt(state, 'subdomain')}
        >
          <input
            name="subdomain"
            required
            maxLength={120}
            defaultValue={echoed(state, 'subdomain') ?? ''}
            className={controlClassName}
          />
        </Field>
      </div>
      <Result state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create site'}
        </Button>
      </div>
    </form>
  );
}

export function ThemeForm({ site }: { site: WebsiteDetail }) {
  const [state, action, pending] = useActionState(saveTheme, IDLE);
  const theme = site.theme as Record<string, string | undefined>;
  const fields: { name: string; label: string; key: string; hint?: string }[] = [
    { name: 'background', label: 'Background', key: 'background' },
    { name: 'textColour', label: 'Text', key: 'text' },
    { name: 'muted', label: 'Secondary text', key: 'muted' },
    { name: 'accent', label: 'Accent', key: 'accent', hint: 'Buttons and links.' },
    { name: 'accentContrast', label: 'Text on accent', key: 'accentContrast' },
    { name: 'font', label: 'Font', key: 'font', hint: 'A CSS font stack, e.g. Georgia, serif.' },
  ];
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="websiteId" value={site.id} />
      <Field label="Site name" error={errorAt(state, 'name')}>
        <input
          name="name"
          defaultValue={echoed(state, 'name') ?? site.name}
          className={controlClassName}
          maxLength={200}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <Field key={field.name} label={field.label} hint={field.hint}>
            <input
              name={field.name}
              defaultValue={echoed(state, field.name) ?? theme[field.key] ?? ''}
              className={controlClassName}
              maxLength={120}
              placeholder="Leave empty for the default"
            />
          </Field>
        ))}
      </div>
      <Result state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save theme'}
        </Button>
      </div>
    </form>
  );
}

export function NewPageForm({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(createPage, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="websiteId" value={websiteId} />
      <Field
        label="Address"
        hint="Like /about or /services/interiors."
        error={errorAt(state, 'path')}
      >
        <input
          name="path"
          required
          defaultValue={echoed(state, 'path') ?? ''}
          className={controlClassName}
        />
      </Field>
      <Field label="Title" error={errorAt(state, 'title')}>
        <input
          name="title"
          required
          defaultValue={echoed(state, 'title') ?? ''}
          className={controlClassName}
          maxLength={200}
        />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add page'}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function PageActions({ websiteId, page }: { websiteId: string; page: WebsitePageRow }) {
  const [homeState, homeAction, homePending] = useActionState(makeHome, IDLE);
  const [deleteState, deleteAction, deletePending] = useActionState(deletePage, IDLE);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!page.isHome && (
        <form action={homeAction}>
          <input type="hidden" name="websiteId" value={websiteId} />
          <input type="hidden" name="pageId" value={page.id} />
          <Button type="submit" variant="secondary" disabled={homePending}>
            Make home page
          </Button>
        </form>
      )}
      {!page.isHome && (
        <form action={deleteAction}>
          <input type="hidden" name="websiteId" value={websiteId} />
          <input type="hidden" name="pageId" value={page.id} />
          <Button type="submit" variant="danger" disabled={deletePending}>
            Remove page
          </Button>
        </form>
      )}
      <Result state={homeState} />
      <Result state={deleteState} />
    </div>
  );
}

export function PublishControls({
  site,
  versions,
}: {
  site: WebsiteDetail;
  versions: readonly WebsiteVersionRow[];
}) {
  const [publishState, publishAction, publishPending] = useActionState(publishSite, IDLE);
  const [offlineState, offlineAction, offlinePending] = useActionState(unpublishSite, IDLE);
  const [rollbackState, rollbackAction, rollbackPending] = useActionState(rollbackSite, IDLE);
  const servedId = site.publishedVersionId;
  const restorable = versions.filter((version) => version.id !== servedId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <form action={publishAction}>
          <input type="hidden" name="websiteId" value={site.id} />
          <Button type="submit" disabled={publishPending}>
            {publishPending
              ? 'Publishing…'
              : site.status === 'published'
                ? 'Publish changes'
                : 'Publish'}
          </Button>
        </form>
        {site.status === 'published' && (
          <form action={offlineAction}>
            <input type="hidden" name="websiteId" value={site.id} />
            <Button type="submit" variant="secondary" disabled={offlinePending}>
              Take offline
            </Button>
          </form>
        )}
      </div>
      <Result state={publishState} />
      <Result state={offlineState} />

      {restorable.length > 0 && (
        <form action={rollbackAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="websiteId" value={site.id} />
          <Field label="Roll back to" hint="This publishes that version again as a new version.">
            <select name="versionId" className={controlClassName} defaultValue={restorable[0]?.id}>
              {restorable.map((version) => (
                <option key={version.id} value={version.id}>
                  Version {version.version}
                  {version.restoredFromVersionId !== null ? ' (a rollback)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary" disabled={rollbackPending}>
            Roll back
          </Button>
          <Result state={rollbackState} />
        </form>
      )}
    </div>
  );
}
