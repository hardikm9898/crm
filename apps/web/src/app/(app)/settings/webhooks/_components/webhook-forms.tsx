'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Badge, Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import {
  EVENT_GROUPS,
  EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  describeEndpointActivity,
  endpointStanding,
  type WebhookEndpointRecord,
  type WebhookEventType,
} from '@/lib/webhooks';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  retryWebhookDelivery,
  rotateWebhookSecret,
  sendWebhookTest,
  setWebhookEndpointActive,
  updateWebhookEndpoint,
} from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * The signing secret, shown exactly once.
 *
 * From `ActionState.data` rather than the server tree, because no endpoint will answer it again —
 * the same arrangement the API keys screen uses, and for the same reason: a screen that could show
 * a credential twice is one an attacker with a session could read.
 */
function ShownOnceSecret({ secret, url }: { secret: string; url: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/8 px-3 py-3"
      data-secret-once
    >
      <p className="text-sm font-medium">Copy this now — it is not shown again.</p>
      <Field
        label={`Signing secret for ${url}`}
        hint="Your server hashes it with the timestamp and the raw body to check each delivery is really from us."
      >
        <input readOnly value={secret} className={controlClassName} data-webhook-secret />
      </Field>
      <p className="text-xs text-[var(--color-text-muted)]">
        Lost it? Rotate the secret. We keep it encrypted because signing needs it, and no endpoint
        reads it back to you.
      </p>
    </div>
  );
}

/** The event picker, grouped so twenty-five tick boxes are something a person can read. */
function EventPicker({ chosen }: { chosen: readonly string[] }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Which events?</legend>
      {EVENT_GROUPS.map((group) => {
        const types = WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith(group.prefix));
        if (types.length === 0) return null;
        return (
          <div key={group.heading} className="flex flex-col gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {group.heading}
            </p>
            {types.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="eventTypes"
                  value={type}
                  defaultChecked={chosen.includes(type)}
                />
                <span>
                  {EVENT_LABELS[type as WebhookEventType]}{' '}
                  <code className="text-xs text-[var(--color-text-muted)]">{type}</code>
                </span>
              </label>
            ))}
          </div>
        );
      })}
    </fieldset>
  );
}

export function NewWebhookEndpointForm() {
  const [state, action, pending] = useActionState(createWebhookEndpoint, IDLE);
  const echoed =
    state.status === 'error' ? (state.values?.['eventTypes'] ?? '').split(',').filter(Boolean) : [];
  // A new endpoint starts on the event most integrations want, so the commonest case is one tick.
  const chosen = echoed.length > 0 ? echoed : ['lead.created'];

  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && state.data?.['secret'] && (
        <ShownOnceSecret secret={state.data['secret']} url={state.data['url'] ?? 'this endpoint'} />
      )}

      <Field
        label="Where should we post?"
        hint="An https:// address on your own server. Every delivery is signed, and we never follow a redirect."
        {...(errorOf(state, 'url') ? { error: errorOf(state, 'url') } : {})}
      >
        <input
          name="url"
          className={controlClassName}
          defaultValue={valueOf(state, 'url', '')}
          placeholder="https://example.com/hooks/leados"
        />
      </Field>

      <Field label="What is it for?" hint="Optional. Appears beside every delivery it receives.">
        <input
          name="description"
          className={controlClassName}
          defaultValue={valueOf(state, 'description', '')}
          placeholder="Our order system"
        />
      </Field>

      <EventPicker chosen={chosen} />
      {errorOf(state, 'eventTypes') && (
        <span className="text-xs text-[var(--color-danger)]">{errorOf(state, 'eventTypes')}</span>
      )}

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Adding…' : 'Add endpoint'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One endpoint, with everything anybody does to one.
 *
 * The URL is printed as **text** above its editor, not only as an input value: a settings list
 * whose values live only in inputs is unreadable at a glance and unassertable by a browser check —
 * the lesson the payment-method rows paid for.
 */
export function WebhookEndpointRow({ endpoint }: { endpoint: WebhookEndpointRecord }) {
  const [editState, edit, editing] = useActionState(updateWebhookEndpoint, IDLE);
  const [activeState, setActive, switching] = useActionState(setWebhookEndpointActive, IDLE);
  const [rotateState, rotate, rotating] = useActionState(rotateWebhookSecret, IDLE);
  const [testState, sendTest, testing] = useActionState(sendWebhookTest, IDLE);
  const [deleteState, remove, deleting] = useActionState(deleteWebhookEndpoint, IDLE);
  const standing = endpointStanding(endpoint);

  return (
    <div
      className="flex flex-col gap-3 border-b border-[var(--color-border)]/60 py-4 last:border-0"
      data-endpoint={endpoint.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium" data-endpoint-url={endpoint.id}>
            {endpoint.url}
          </p>
          <p
            className="text-xs text-[var(--color-text-muted)]"
            data-endpoint-activity={endpoint.id}
          >
            {endpoint.description ? `${endpoint.description} · ` : ''}
            {describeEndpointActivity(endpoint)}
          </p>
        </div>
        <Badge tone={standing.tone}>{standing.label}</Badge>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]" data-endpoint-events={endpoint.id}>
        {endpoint.eventTypes.length} {endpoint.eventTypes.length === 1 ? 'event' : 'events'}:{' '}
        {endpoint.eventTypes.join(', ')}
      </p>

      {endpoint.disabledReason !== null && !endpoint.isActive && (
        <p
          className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]"
          data-endpoint-disabled={endpoint.id}
        >
          {endpoint.disabledReason}
        </p>
      )}

      {[editState, activeState, rotateState, testState, deleteState].map((state, index) =>
        state.status === 'error' ? (
          <ErrorNotice key={`error-${index}`}>{state.message}</ErrorNotice>
        ) : null,
      )}
      {testState.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]">{testState.message}</p>
      )}
      {rotateState.status === 'success' && rotateState.data?.['secret'] && (
        <ShownOnceSecret
          secret={rotateState.data['secret']}
          url={rotateState.data['url'] ?? endpoint.url}
        />
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-[var(--color-text-muted)]">
          Change the address or the events
        </summary>
        <form action={edit} className="mt-2 flex flex-col gap-3">
          <input type="hidden" name="id" value={endpoint.id} />
          <Field label="Address">
            <input
              name="url"
              className={controlClassName}
              defaultValue={endpoint.url}
              aria-label={`Address for ${endpoint.url}`}
            />
          </Field>
          <Field label="What it is for">
            <input
              name="description"
              className={controlClassName}
              defaultValue={endpoint.description ?? ''}
            />
          </Field>
          <EventPicker chosen={endpoint.eventTypes} />
          <div>
            <Button type="submit" variant="secondary" pending={editing}>
              Save
            </Button>
          </div>
        </form>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <form action={sendTest}>
          <input type="hidden" name="id" value={endpoint.id} />
          <Button type="submit" variant="secondary" pending={testing}>
            {testing ? 'Sending…' : 'Send a test'}
          </Button>
        </form>

        <form action={rotate}>
          <input type="hidden" name="id" value={endpoint.id} />
          <Button type="submit" variant="secondary" pending={rotating}>
            {rotating ? 'Rotating…' : 'Rotate secret'}
          </Button>
        </form>

        <form action={setActive}>
          <input type="hidden" name="id" value={endpoint.id} />
          <input type="hidden" name="isActive" value={endpoint.isActive ? 'false' : 'true'} />
          <Button type="submit" variant="secondary" pending={switching}>
            {endpoint.isActive ? 'Switch off' : 'Switch back on'}
          </Button>
        </form>

        <form action={remove}>
          <input type="hidden" name="id" value={endpoint.id} />
          <Button type="submit" variant="danger" pending={deleting}>
            Delete
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Sending one delivery again.
 *
 * No success message: the retry revalidates the screen and the row re-renders with its new state
 * and its new attempt count, which is where the outcome belongs. A refusal keeps the row, so its
 * notice stays beside it.
 */
export function RetryDeliveryButton({ deliveryId }: { deliveryId: string }) {
  const [state, action, pending] = useActionState(retryWebhookDelivery, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={deliveryId} />
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Sending…' : 'Send again'}
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}
