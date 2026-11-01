'use client';

import { useActionState, useState } from 'react';
import { Badge, Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import {
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_STATUS_LABELS,
  TEMPLATE_STATUS_TONES,
  TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  templateVariables,
  type WhatsAppTemplate,
} from '@/lib/whatsapp';
import { archiveTemplate, createTemplate, submitTemplate, syncTemplates } from '../actions';

/**
 * Writing a template (`FR-WA-5`).
 *
 * The variable boxes appear **as you type** `{{1}}` in the body, each with a picker of the fields
 * this workspace can fill it from — because a variable with nothing behind it is a template that
 * looks complete, passes review, and then refuses at send time in front of a customer.
 *
 * The refusal the API writes is printed per field, against the box it names: "variables must run
 * from {{1}} with no gaps" is a sentence somebody can act on, and the summary alone is not.
 */
export function NewTemplateForm({ accountId }: { accountId: string }) {
  const [state, submit, pending] = useActionState(createTemplate, IDLE);
  const echoed = state.status === 'error' ? state.values : undefined;
  const [body, setBody] = useState(echoed?.['body'] ?? '');
  const variables = templateVariables(body);
  const fieldError = (field: string) =>
    state.status === 'error' ? state.fieldErrors?.[field] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-3" data-new-template>
      <input type="hidden" name="accountId" value={accountId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-template-created>
          {state.message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Name
          <input
            name="name"
            required
            defaultValue={echoed?.['name'] ?? ''}
            placeholder="order_update"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          />
          {/* Meta's rule, said before somebody waits a day to be refused by it. */}
          <span className="text-[var(--color-text-muted)]">
            {fieldError('name') ?? 'Lower case, digits and underscores.'}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Language
          <input
            name="language"
            defaultValue={echoed?.['language'] ?? 'en'}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          />
          <span>{fieldError('language') ?? 'A WhatsApp code, like en or en_US.'}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Category
          <select
            name="category"
            key={`category-${echoed?.['category'] ?? 'utility'}`}
            defaultValue={echoed?.['category'] ?? 'utility'}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          >
            {WHATSAPP_TEMPLATE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {TEMPLATE_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Header (optional)
        <input
          name="header"
          defaultValue={echoed?.['header'] ?? ''}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Message
        <textarea
          name="body"
          required
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Hello {{1}}, your visit is confirmed for {{2}}."
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          data-template-body
        />
        <span>
          {fieldError('components.body') ?? 'Use {{1}}, {{2}} for anything that changes.'}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Footer (optional)
        <input
          name="footer"
          defaultValue={echoed?.['footer'] ?? ''}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>

      {variables.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] px-3 py-2">
          <p className="text-xs font-medium">What fills each variable</p>
          {variables.map((index) => (
            <label
              key={index}
              className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"
              data-variable-row={index}
            >
              <span className="w-12">{`{{${index}}}`}</span>
              <select
                name={`variable-${index}`}
                defaultValue={echoed?.[`variable-${index}`] ?? 'lead.firstName'}
                className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)]"
              >
                {TEMPLATE_VARIABLE_SOURCES.map((source) => (
                  <option key={source.key} value={source.key}>
                    {source.label}
                  </option>
                ))}
              </select>
              {fieldError(`variableMap.${index}`) && (
                <span className="text-[var(--color-danger)]">
                  {fieldError(`variableMap.${index}`)}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save as a draft'}
        </Button>
      </div>
    </form>
  );
}

/** One template, with the two things anybody does to one. */
export function TemplateRow({ template }: { template: WhatsAppTemplate }) {
  const [submitState, submit, submitting] = useActionState(submitTemplate, IDLE);
  const [archiveState, archive, archiving] = useActionState(archiveTemplate, IDLE);
  const canSubmit = template.status === 'draft' || template.status === 'rejected';

  return (
    <div
      className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3 last:border-0"
      data-template={template.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          {/* The name as text, not only inside an input: a settings list whose values live in
              inputs is unreadable at a glance and unassertable by a browser check. */}
          <p className="text-sm font-medium" data-template-name={template.id}>
            {template.name}{' '}
            <span className="text-[var(--color-text-muted)]">({template.language})</span>
          </p>
          <p className="text-xs text-[var(--color-text-muted)]" data-template-preview={template.id}>
            {template.preview || 'Its wording lives at WhatsApp.'}
          </p>
        </div>
        <span data-template-status={template.id}>
          <Badge tone={TEMPLATE_STATUS_TONES[template.status]}>
            {TEMPLATE_STATUS_LABELS[template.status]}
          </Badge>
        </span>
      </div>

      {template.rejectionReason !== null && (
        <p className="text-xs text-[var(--color-danger)]" data-template-rejection={template.id}>
          {/* WhatsApp's own words: a paraphrase would lose the thing to change. */}
          {template.rejectionReason}
        </p>
      )}

      {[submitState, archiveState].map((state, index) =>
        state.status === 'error' ? <ErrorNotice key={index}>{state.message}</ErrorNotice> : null,
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canSubmit && (
          <form action={submit} data-submit-template={template.id}>
            <input type="hidden" name="templateId" value={template.id} />
            <Button type="submit" variant="secondary" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send to WhatsApp for review'}
            </Button>
          </form>
        )}
        <form action={archive} data-archive-template={template.id}>
          <input type="hidden" name="templateId" value={template.id} />
          <Button type="submit" variant="quiet" disabled={archiving}>
            {archiving ? 'Archiving…' : 'Archive'}
          </Button>
        </form>
        {!template.sendable && template.blockedReason !== null && (
          <span className="text-xs text-[var(--color-text-muted)]">{template.blockedReason}</span>
        )}
      </div>
    </div>
  );
}

/** "Ask WhatsApp now", for somebody who has just been approved and does not want to wait. */
export function SyncTemplatesForm({ accountId }: { accountId: string }) {
  const [state, submit, pending] = useActionState(syncTemplates, IDLE);
  return (
    <form action={submit} className="flex items-center gap-2" data-sync-templates={accountId}>
      <input type="hidden" name="accountId" value={accountId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <span className="text-xs text-[var(--color-success)]" data-sync-result={accountId}>
          {state.message}
        </span>
      )}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Asking…' : 'Check with WhatsApp'}
      </Button>
    </form>
  );
}
