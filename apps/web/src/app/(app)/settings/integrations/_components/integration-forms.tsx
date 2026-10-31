'use client';

import { useActionState, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Badge, Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import {
  FIELD_LABELS,
  MAPPABLE_LEAD_FIELDS,
  MAPPING_TRANSFORMS,
  STATUS_CLASSES,
  STATUS_LABELS,
  TRANSFORM_LABELS,
  describeActivity,
  describeCheck,
  inboundInstruction,
  needsReconnect,
  signingSnippet,
  type ConnectionRecord,
  type FieldMapping,
  type ProviderOption,
} from '@/lib/integrations';
import {
  checkIntegration,
  connectIntegration,
  disconnectIntegration,
  rotateConnectionSecret,
  saveMapping,
  updateIntegration,
} from '../actions';

/** The echoed mapping, or null when there is nothing to restore. Never throws on a bad echo. */
function parseMapping(value: string | undefined): FieldMapping[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as FieldMapping[]) : null;
  } catch {
    return null;
  }
}

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The secret, shown exactly once.
 *
 * From `ActionState.data` rather than the server tree, because no endpoint will answer it again.
 * The inbound URL is beside it, because the two are useless apart: a sender needs the address and
 * the secret in the same copy-and-paste.
 */
function ShownOnceSecret({
  secret,
  url,
  name,
  provider,
}: {
  secret: string;
  url: string | null;
  name: string;
  provider: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/8 px-3 py-3"
      data-secret-once
    >
      <p className="text-sm font-medium">Copy this now — it is not shown again.</p>
      <Field
        label={`Secret for ${name}`}
        hint={
          provider === 'google_ads_leads'
            ? 'Paste this into the lead form’s webhook settings in Google Ads as the key. Every delivery carries it back, and we check it.'
            : 'The sending system hashes it with a timestamp and the raw body, and sends the result as X-Signature.'
        }
      >
        <input readOnly value={secret} className={controlClassName} data-connection-secret />
      </Field>
      {url !== null && (
        <Field label="Post leads to" hint={inboundInstruction(provider)}>
          <input readOnly value={url} className={controlClassName} data-connection-url />
        </Field>
      )}
      <p className="text-xs text-[var(--color-text-muted)]">
        Lost it? Rotate the secret. We keep it encrypted because checking a signature needs it, and
        no screen reads it back to you.
      </p>
    </div>
  );
}

/**
 * One mapping row: their field name, ours, and what happens to the value on the way.
 *
 * The refusal for *this* row is printed under it. The API answers one sentence per bad entry —
 * "two fields both write to phone, the one lower down would quietly win" is the problem a schema
 * cannot see — and a screen that showed only the summary ("That field mapping cannot be used")
 * would discard exactly the sentence somebody can act on. That is the `ERROR_COPY` lesson, one
 * layer in: a refusal the API wrote for a person is the one thing not to paraphrase.
 */
function MappingRow({ row, index, error }: { row: FieldMapping; index: number; error?: string }) {
  return (
    <div className="flex flex-col gap-1" data-mapping-row={index}>
      <div className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr]">
        <input
          name="mapSource"
          className={controlClassName}
          defaultValue={row.source}
          placeholder="contact.full_name"
          aria-label={`What they send, row ${index + 1}`}
        />
        <input
          name="mapTarget"
          className={controlClassName}
          defaultValue={row.target}
          placeholder="name"
          list="leados-fields"
          aria-label={`What it becomes, row ${index + 1}`}
        />
        <select
          name="mapTransform"
          className={controlClassName}
          defaultValue={row.transform ?? 'none'}
          aria-label={`What to do to the value, row ${index + 1}`}
        >
          {MAPPING_TRANSFORMS.map((transform) => (
            <option key={transform} value={transform}>
              {TRANSFORM_LABELS[transform]}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <span className="text-xs text-[var(--color-danger)]" data-mapping-error={index}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The mapping editor.
 *
 * The number of rows is client state because adding one must not lose what is in the others, and a
 * saved mapping comes back from the server tree. The target box is a free input with a `datalist`
 * rather than a `<select>`: `custom.<key>` is a target the registry cannot enumerate, and it is the
 * commonest reason somebody opens this editor.
 */
export function MappingEditor({ connection }: { connection: ConnectionRecord }) {
  const [state, action, pending] = useActionState(saveMapping, IDLE);
  const [extra, setExtra] = useState(0);
  /**
   * On a refusal the rows come from the **echo**, not from the server tree.
   *
   * A server action re-renders the server tree and the client form remounts, so without this a
   * refused save comes back with the stored mapping and the work is lost — the same defect
   * `submittedValues` exists for, in a form whose fields repeat.
   */
  const echoed = state.status === 'error' ? parseMapping(state.values?.['mapping']) : null;
  const rows: FieldMapping[] = echoed ?? [
    ...connection.fieldMappings,
    ...Array.from({ length: extra }, () => ({ source: '', target: '' })),
  ];

  return (
    <form action={action} className="flex flex-col gap-3" data-mapping-form={connection.id}>
      <input type="hidden" name="connectionId" value={connection.id} />
      <datalist id="leados-fields">
        {MAPPABLE_LEAD_FIELDS.map((field) => (
          <option key={field} value={field}>
            {FIELD_LABELS[field]}
          </option>
        ))}
      </datalist>

      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-mapping-saved>
          {state.message}
        </p>
      )}

      <div className="grid gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)] sm:grid-cols-[2fr_2fr_1fr]">
        <span>What they send</span>
        <span>What it becomes</span>
        <span>To the value</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Nothing mapped yet. Add a row for each field the other system sends.
        </p>
      ) : (
        rows.map((row, index) => (
          <MappingRow
            key={`${row.source}-${row.target}-${index}`}
            row={row}
            index={index}
            {...(errorOf(state, `fieldMappings.${index}`)
              ? { error: errorOf(state, `fieldMappings.${index}`) }
              : {})}
          />
        ))
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setExtra((count) => count + 1)}>
          Add a field
        </Button>
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save the mapping'}
        </Button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        A field nothing maps is still kept with the payload, so you can turn it into a field of your
        own from the integration log. Use <code>custom.your_key</code> to write one you already
        have.
      </p>
    </form>
  );
}

/** Connect a provider. The form is rendered from the registry, so a new provider needs no new UI. */
export function ConnectForm({
  providers,
  apiBase,
}: {
  providers: ProviderOption[];
  apiBase: string;
}) {
  const [state, action, pending] = useActionState(connectIntegration, IDLE);
  const available = providers.filter((provider) => provider.connection === null);
  const echoed = valueOf(state, 'provider', available[0]?.key ?? '');
  const [chosen, setChosen] = useState(echoed);
  const provider = available.find((entry) => entry.key === chosen) ?? available[0];

  if (available.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Everything we can connect is connected. Disconnect one to replace it.
      </p>
    );
  }

  // Narrowed once, because `data` exists only on the success branch of `ActionState`.
  const success = state.status === 'success' ? state : null;
  const secret = success?.data?.['secret'] ?? '';

  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {secret !== '' && (
        <ShownOnceSecret
          secret={secret}
          url={
            success?.data?.['connectionId']
              ? `${apiBase.replace(/\/$/, '')}/api/v1/wh/${success.data['provider']}/${success.data['connectionId']}`
              : null
          }
          name={success?.data?.['name'] ?? 'this connection'}
          provider={success?.data?.['provider'] ?? ''}
        />
      )}
      {state.status === 'success' && secret === '' && (
        <p className="text-xs text-[var(--color-success)]" data-connect-success>
          {state.message}
        </p>
      )}

      <Field label="What are you connecting?">
        <select
          name="provider"
          className={controlClassName}
          // Remounted exactly when the echo changes, and left alone while somebody is choosing: a
          // controlled `value` loses the choice on a refused submission, because React re-creates
          // the options in the same commit and the DOM keeps `selectedIndex: 0`.
          key={`provider-${echoed}`}
          defaultValue={echoed}
          onChange={(event) => setChosen(event.target.value)}
        >
          {available.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>

      {provider && (
        <p className="text-sm text-[var(--color-text-muted)]" data-provider-summary={provider.key}>
          {provider.summary}
        </p>
      )}

      <Field
        label="What shall we call it?"
        hint="Appears on every lead and every log line it produces."
        {...(errorOf(state, 'name') ? { error: errorOf(state, 'name') } : {})}
      >
        <input
          name="name"
          className={controlClassName}
          defaultValue={valueOf(state, 'name', provider?.label ?? '')}
        />
      </Field>

      {(provider?.credentialFields ?? []).length > 0 ? (
        (provider?.credentialFields ?? []).map((field) => (
          <Field
            key={field.key}
            label={field.required ? field.label : `${field.label} (optional)`}
            {...(field.hint ? { hint: field.hint } : {})}
            {...(errorOf(state, `credentials.${field.key}`)
              ? { error: errorOf(state, `credentials.${field.key}`) }
              : {})}
          >
            {/*
              Never echoed back on a refusal, unlike every other field on this form. A secret
              restored into an input is a secret in the page's HTML on a screen somebody may be
              sharing, and retyping one is a smaller cost than that.
            */}
            <input
              name={`credentials.${field.key}`}
              className={controlClassName}
              autoComplete="off"
              data-credential-field={field.key}
            />
          </Field>
        ))
      ) : (
        <p className="rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          We generate the secret for this one and show it to you once. The sending system proves
          each delivery with it.
        </p>
      )}

      {(provider?.settings ?? []).map((setting) => (
        <Field
          key={setting.key}
          label={setting.required ? setting.label : `${setting.label} (optional)`}
          {...(setting.hint ? { hint: setting.hint } : {})}
          {...(errorOf(state, `settings.${setting.key}`)
            ? { error: errorOf(state, `settings.${setting.key}`) }
            : {})}
        >
          <input
            name={`settings.${setting.key}`}
            className={controlClassName}
            defaultValue={valueOf(state, `settings.${setting.key}`, '')}
          />
        </Field>
      ))}

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Connecting…' : `Connect ${provider?.label ?? ''}`}
        </Button>
      </div>
    </form>
  );
}

/**
 * One connection, with everything anybody does to one.
 *
 * The name and the standing are printed as **text**, not only as an input value: a settings list
 * whose values live only in inputs is unreadable at a glance and unassertable by a browser check —
 * the lesson the payment-method rows paid for.
 */
export function ConnectionRow({
  connection,
  provider,
  apiBase,
}: {
  connection: ConnectionRecord;
  provider: ProviderOption | undefined;
  apiBase: string;
}) {
  const [editState, edit, editing] = useActionState(updateIntegration, IDLE);
  const [checkState, check, checking] = useActionState(checkIntegration, IDLE);
  const [rotateState, rotate, rotating] = useActionState(rotateConnectionSecret, IDLE);
  const [offState, disconnect, disconnecting] = useActionState(disconnectIntegration, IDLE);
  const inbound = `${apiBase.replace(/\/$/, '')}/api/v1/wh/${connection.provider}/${connection.id}`;

  return (
    <div
      className="flex flex-col gap-3 border-b border-[var(--color-border)]/60 py-4 last:border-0"
      data-connection={connection.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium" data-connection-name={connection.id}>
            {connection.name}
          </p>
          <p
            className="text-xs text-[var(--color-text-muted)]"
            data-connection-activity={connection.id}
          >
            {connection.providerLabel} · {connection.statusSummary} {describeActivity(connection)}
          </p>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASSES[connection.status]}`}
          data-connection-status={connection.id}
        >
          {STATUS_LABELS[connection.status]}
        </span>
      </div>

      {needsReconnect(connection.status) && (
        <p
          className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]"
          data-connection-reconnect={connection.id}
        >
          {connection.lastError ?? 'The credential was refused.'} Paste a new one below to start it
          again.
        </p>
      )}

      {[editState, checkState, rotateState, offState].map((state, index) =>
        state.status === 'error' ? (
          <ErrorNotice key={`error-${index}`}>{state.message}</ErrorNotice>
        ) : null,
      )}
      {checkState.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-check-result={connection.id}>
          {checkState.message}
        </p>
      )}
      {rotateState.status === 'success' && rotateState.data?.['secret'] && (
        <ShownOnceSecret
          secret={rotateState.data['secret']}
          url={inbound}
          name={connection.name}
          provider={connection.provider}
        />
      )}

      {connection.recentChecks.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">
            The last {connection.recentChecks.length} checks
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--color-text-muted)]">
            {connection.recentChecks.map((entry, index) => (
              <li key={`${entry.checkedAt}-${index}`} data-connection-check={connection.id}>
                {describeCheck(entry)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {provider !== undefined && provider.inboundVerification !== 'none' && (
        <Field label="They post leads to" hint={inboundInstruction(connection.provider)}>
          <input
            readOnly
            value={inbound}
            className={controlClassName}
            data-inbound-url={connection.id}
          />
        </Field>
      )}

      <form action={edit} className="grid gap-2 sm:grid-cols-[2fr_2fr_auto]">
        <input type="hidden" name="connectionId" value={connection.id} />
        <input
          name="name"
          className={controlClassName}
          defaultValue={connection.name}
          aria-label="What it is called"
        />
        {(provider?.credentialFields ?? []).length > 0 ? (
          <div className="flex flex-col gap-2">
            {(provider?.credentialFields ?? []).map((field) => (
              <input
                key={field.key}
                name={`credentials.${field.key}`}
                className={controlClassName}
                placeholder={`New ${field.label.toLowerCase()} (leave all blank to keep these)`}
                autoComplete="off"
                aria-label={`New ${field.label}`}
              />
            ))}
          </div>
        ) : (
          <span className="text-xs text-[var(--color-text-muted)]">
            Its secret is ours to generate — rotate it rather than replacing it.
          </span>
        )}
        <Button type="submit" variant="secondary" pending={editing}>
          {editing ? 'Saving…' : 'Save'}
        </Button>
      </form>

      <div className="flex flex-wrap gap-2">
        {provider?.probeable === true && (
          <form action={check}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <Button type="submit" variant="secondary" pending={checking}>
              {checking ? 'Checking…' : 'Check it now'}
            </Button>
          </form>
        )}
        {provider?.credentialFields.length === 0 && (
          <form action={rotate}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <Button type="submit" variant="secondary" pending={rotating}>
              {rotating ? 'Rotating…' : 'Rotate the secret'}
            </Button>
          </form>
        )}
        <form action={disconnect}>
          <input type="hidden" name="connectionId" value={connection.id} />
          <Button type="submit" variant="danger" pending={disconnecting}>
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </form>
      </div>

      {provider?.mappable === true && <MappingEditor connection={connection} />}

      {provider?.inboundVerification === 'hmac_header' &&
        provider.credentialFields.length === 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">
              How the sending system signs a request
            </summary>
            <pre
              className="mt-1 overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
              data-signing-snippet={connection.id}
            >
              {signingSnippet(inbound)}
            </pre>
          </details>
        )}
    </div>
  );
}

/** The catalogue card for something not connected yet. A badge, so "available" is not a button. */
export function ProviderCard({ provider }: { provider: ProviderOption }) {
  return (
    <div className="flex flex-col gap-1 py-3" data-provider={provider.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{provider.label}</p>
        <Badge tone={provider.connection ? 'success' : 'neutral'}>
          {provider.connection ? 'Connected' : 'Available'}
        </Badge>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{provider.summary}</p>
    </div>
  );
}
