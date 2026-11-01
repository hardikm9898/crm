'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Badge, Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { describeKeyUse, keyStanding, type ApiKeyRecord } from '@/lib/ingestion';
import {
  SCOPE_GROUPS,
  SCOPE_LABELS,
  WITHHELD_FROM_KEYS,
  describeKeyUsage,
  type ApiKeyScope,
  type ApiKeyUsage,
} from '@/lib/api-surface';
import { createApiKey, revokeApiKey, rotateApiKey, updateApiKey } from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The pair, shown exactly once (`FR-CAP-7`).
 *
 * Rendered from `ActionState.data` rather than from the server tree, because the API will not
 * answer the secret again — a card that re-rendered on refresh would have nothing to show, and a
 * screen that could show it twice would be a screen an attacker with a session could read. The copy
 * boxes are `readOnly` inputs rather than text: a credential somebody has to select by hand is one
 * that arrives in a config file with a space on the end.
 */
function ShownOnceSecret({ keyId, secret, name }: { keyId: string; secret: string; name: string }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/8 px-3 py-3"
      data-secret-once
    >
      <p className="text-sm font-medium">
        Copy these now — the secret for “{name}” is not shown again.
      </p>
      <Field label="Key id (X-Api-Key)" hint="Not a secret. It identifies the key in our logs.">
        <input readOnly value={keyId} className={controlClassName} data-key-id />
      </Field>
      <Field
        label="Secret (signs each request)"
        hint="Store it where your integration reads its configuration. If it leaks, rotate — rotating is the honest answer to “I lost it” too."
      >
        <input readOnly value={secret} className={controlClassName} data-key-secret />
      </Field>
      <p className="text-xs text-[var(--color-text-muted)]">
        Lost it? Rotate the key. We keep the secret encrypted because verifying a signature needs
        it, and no endpoint will read it back to you.
      </p>
    </div>
  );
}

/**
 * The scope picker.
 *
 * It offers only the scopes **this** person holds, which is the same rule the one-click custom
 * field follows: a tick box that is certain to be refused is worse than one that is not there, and
 * the API refuses a key a permission its creator does not have. What is missing is explained in a
 * sentence underneath rather than left as an absence somebody has to notice.
 */
function ScopePicker({
  grantable,
  granted,
  error,
}: {
  grantable: readonly ApiKeyScope[];
  granted: readonly string[];
  error?: string;
}) {
  const offered = new Set(grantable);
  return (
    <fieldset className="flex flex-col gap-3" data-scope-picker>
      <legend className="text-sm font-medium">What may it do?</legend>
      {SCOPE_GROUPS.map((group) => {
        const scopes = group.scopes.filter((scope) => offered.has(scope));
        if (scopes.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-1">
            <p className="text-xs font-medium" data-scope-group={group.label}>
              {group.label}
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">{group.hint}</p>
            {scopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={
                    granted.length > 0 ? granted.includes(scope) : scope === 'ingest:write'
                  }
                />
                <span>
                  {SCOPE_LABELS[scope]}{' '}
                  <code className="text-xs text-[var(--color-text-muted)]">{scope}</code>
                </span>
              </label>
            ))}
          </div>
        );
      })}
      <p className="text-xs text-[var(--color-text-muted)]" data-scopes-withheld>
        {WITHHELD_FROM_KEYS}
      </p>
      {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
    </fieldset>
  );
}

export function NewApiKeyForm({ grantable }: { grantable: readonly ApiKeyScope[] }) {
  const [state, action, pending] = useActionState(createApiKey, IDLE);
  const granted =
    state.status === 'error' ? (state.values?.['scopes'] ?? '').split(',').filter(Boolean) : [];

  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && state.data?.['secret'] && (
        <ShownOnceSecret
          keyId={state.data['keyId'] ?? ''}
          secret={state.data['secret']}
          name={state.data['name'] ?? 'this key'}
        />
      )}

      <Field
        label="What is it for?"
        hint="The name appears beside every payload it sends — “Website”, “Zapier”, “Agency”."
        {...(errorOf(state, 'name') ? { error: errorOf(state, 'name') } : {})}
      >
        <input
          name="name"
          className={controlClassName}
          defaultValue={valueOf(state, 'name', '')}
          placeholder="Website"
        />
      </Field>

      <ScopePicker
        grantable={grantable}
        granted={granted}
        {...(errorOf(state, 'scopes') ? { error: errorOf(state, 'scopes') } : {})}
      />

      <Field
        label="Only from these addresses"
        hint="Optional. One address or range per line, like 203.0.113.7 or 203.0.113.0/24. Leave empty to accept any address."
        {...(errorOf(state, 'ipAllowlist') ? { error: errorOf(state, 'ipAllowlist') } : {})}
      >
        <textarea
          name="ipAllowlist"
          rows={2}
          className={controlClassName}
          defaultValue={valueOf(state, 'ipAllowlist', '')}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Requests a minute"
          hint="Optional. Leave empty for the workspace default of 120."
          {...(errorOf(state, 'rateLimitPerMin')
            ? { error: errorOf(state, 'rateLimitPerMin') }
            : {})}
        >
          <input
            name="rateLimitPerMin"
            inputMode="numeric"
            className={controlClassName}
            defaultValue={valueOf(state, 'rateLimitPerMin', '')}
            placeholder="120"
          />
        </Field>
        <Field
          label="Stops working on"
          hint="Optional. Useful for an agency’s key."
          {...(errorOf(state, 'expiresAt') ? { error: errorOf(state, 'expiresAt') } : {})}
        >
          <input
            type="date"
            name="expiresAt"
            className={controlClassName}
            defaultValue={valueOf(state, 'expiresAt', '')}
          />
        </Field>
      </div>

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Creating…' : 'Create key'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One key, with the two things anybody does to one.
 *
 * The name is printed as **text** above its editor, not only as an input value: a settings list
 * whose values live only in inputs is unreadable at a glance and unassertable by a browser check —
 * the lesson the payment-method rows paid for.
 */
export function ApiKeyRow({ apiKey, usage }: { apiKey: ApiKeyRecord; usage?: ApiKeyUsage }) {
  const [rotateState, rotate, rotating] = useActionState(rotateApiKey, IDLE);
  const [revokeState, revoke, revoking] = useActionState(revokeApiKey, IDLE);
  const [editState, edit, editing] = useActionState(updateApiKey, IDLE);
  const standing = keyStanding(apiKey);

  return (
    <div
      className="flex flex-col gap-3 border-b border-[var(--color-border)]/60 py-4 last:border-0"
      data-api-key={apiKey.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium" data-api-key-name={apiKey.id}>
            {apiKey.name}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            <code data-api-key-prefix={apiKey.id}>{apiKey.keyPrefix}…</code> ·{' '}
            {describeKeyUse(apiKey)}
          </p>
        </div>
        <Badge tone={standing.tone}>{standing.label}</Badge>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]" data-api-key-usage={apiKey.id}>
        {describeKeyUsage(usage)}
      </p>

      <p className="text-xs text-[var(--color-text-muted)]" data-api-key-scopes={apiKey.id}>
        {apiKey.scopes.join(', ')}
        {apiKey.ipAllowlist.length > 0 ? ` · only from ${apiKey.ipAllowlist.join(', ')}` : ''}
        {apiKey.rateLimitPerMin !== null ? ` · ${apiKey.rateLimitPerMin} requests a minute` : ''}
      </p>

      {rotateState.status === 'error' && <ErrorNotice>{rotateState.message}</ErrorNotice>}
      {revokeState.status === 'error' && <ErrorNotice>{revokeState.message}</ErrorNotice>}
      {editState.status === 'error' && <ErrorNotice>{editState.message}</ErrorNotice>}
      {editState.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]">{editState.message}</p>
      )}
      {rotateState.status === 'success' && rotateState.data?.['secret'] && (
        <ShownOnceSecret
          keyId={rotateState.data['keyId'] ?? ''}
          secret={rotateState.data['secret']}
          name={rotateState.data['name'] ?? apiKey.name}
        />
      )}

      {apiKey.revokedAt === null && (
        <div className="flex flex-wrap items-end gap-3">
          <form action={edit} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={apiKey.id} />
            <Field label="Name">
              <input
                name="name"
                className={controlClassName}
                defaultValue={apiKey.name}
                aria-label={`Name for ${apiKey.name}`}
              />
            </Field>
            <Field label="Only from these addresses">
              <input
                name="ipAllowlist"
                className={controlClassName}
                defaultValue={apiKey.ipAllowlist.join(', ')}
                placeholder="any address"
              />
            </Field>
            <Button type="submit" variant="secondary" pending={editing}>
              Save
            </Button>
          </form>

          <form action={rotate}>
            <input type="hidden" name="id" value={apiKey.id} />
            <Button type="submit" variant="secondary" pending={rotating}>
              {rotating ? 'Rotating…' : 'Rotate secret'}
            </Button>
          </form>

          <form action={revoke}>
            <input type="hidden" name="id" value={apiKey.id} />
            <Button type="submit" variant="danger" pending={revoking}>
              {revoking ? 'Revoking…' : 'Revoke'}
            </Button>
          </form>
        </div>
      )}

      {apiKey.revokedAt !== null && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Revoked. Kept so every payload it sent still says which key sent it.
        </p>
      )}
    </div>
  );
}
