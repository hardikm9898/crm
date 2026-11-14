import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  FORM_HONEYPOT_FIELD,
  customFieldSpec,
  formFieldName,
  formStandardField,
  isHoneypotTripped,
  newId,
  normalizeUtm,
  splitFullName,
  systemPrincipal,
  tenantContext,
  validateFormSubmission,
  withPlatformScope,
  type FormFieldView,
} from '@leados/shared';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { requestStore } from '../../infra/http/request-store.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { FormThrottleService } from './form-throttle.service.js';
import type { SubmitFormInput } from './forms.dto.js';

/**
 * The public side of a capture form (`FR-CAP-2`, `FR-CAP-3`, `FR-CAP-4`).
 *
 * Everything here runs for somebody who has never signed in, on a page the product does not
 * control, and it is the only place in the API where **the tenant is resolved from a value in the
 * URL**. Five decisions follow from that, and each has a wrong answer that looks reasonable:
 *
 *  * **The tenant comes from the form's `public_key`, read under `withPlatformScope`, and every
 *    write then happens inside `tenantContext.run(systemPrincipal(...))`.** The lookup has to cross
 *    tenants because there is no session to say which workspace this is; the writes must not, or
 *    `TimelineService` and the scoping extension have nothing to work with — the trap the quotation
 *    expiry sweep paid for.
 *  * **The submission row is written before the capture is attempted.** `FR-CAP-3` asks that every
 *    capture persist its payload "independent of whether lead creation succeeded", and a row
 *    written afterwards is exactly the row that is missing when it did not. So: insert `received`,
 *    attempt, then update with the outcome.
 *  * **A bot is answered as though it succeeded.** The honeypot's whole value is that nothing tells
 *    the filler it was caught; a 400 teaches a spam tool to stop filling the hidden field.
 *  * **Validation answers field errors, in the words of the form.** The person typing has no idea
 *    what a lead source is, so "Phone number is needed." beside the box, never a constraint name.
 *  * **An unknown answer is kept, never rejected.** `FR-CAP-5`: ingestion accepts extra fields and
 *    surfaces them rather than failing. The raw payload is stored whole and the unmapped keys are
 *    reported back to the admin on the submission.
 */
@Injectable()
export class PublicFormsService {
  constructor(
    private readonly db: DbService,
    private readonly leads: LeadsService,
    private readonly fields: FieldRegistryService,
    private readonly throttle: FormThrottleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * What the renderer needs to draw the form, for a stranger.
   *
   * Deliberately thin: the workspace's name, the form's own copy, and the fields. No ids a
   * signed-in screen would show, no counts, nothing about the pipeline or the assignment rule —
   * this response is readable by anybody with the URL, and every extra field in it is something a
   * competitor learns about how the business runs.
   */
  async definition(publicKey: string) {
    const form = await this.loadByKey(publicKey);
    const views = await this.fieldViews(form);
    return {
      name: form.name,
      organizationName: form.organizationName,
      type: form.type,
      settings: form.settings,
      honeypotField: FORM_HONEYPOT_FIELD,
      steps: Math.max(1, ...views.map((field) => field.stepIndex + 1)),
      fields: views.map((field) => ({
        name: field.name,
        label: field.label,
        kind: field.kind,
        required: field.required,
        stepIndex: field.stepIndex,
        placeholder: field.placeholder ?? null,
        helpText: field.helpText ?? null,
        maxLength: field.maxLength ?? null,
        options: field.options ?? null,
      })),
    };
  }

  /** A submission from the public. */
  async submit(publicKey: string, input: SubmitFormInput) {
    const form = await this.loadByKey(publicKey);
    const request = requestStore.get();
    const ipHash = this.hashIp(request?.ip);

    // Before anything is written: a flood on one form must not become a flood of rows, and the
    // counter is per form *and* per address, for the reason the login throttle has two — one form
    // being hammered and one address trying every form are different attacks.
    await this.throttle.assertAllowed(form.id, ipHash);

    const answers = input.answers;
    const views = await this.fieldViews(form);
    const submissionId = newId();

    // `FR-CAP-3`: the row exists before the capture is attempted, in its own transaction, so the
    // submission that breaks the pipeline is still something an operator can read and replay.
    await this.inTenant(form.organizationId, async () => {
      await this.db.client.formSubmission.create({
        data: {
          id: submissionId,
          organizationId: form.organizationId,
          formId: form.id,
          rawPayload: answers as never,
          utm: normalizeUtm(input.utm) as never,
          sessionId: input.sessionId ?? null,
          visitorId: input.visitorId ?? null,
          ipHash,
          userAgent: request?.userAgent ?? null,
          pageUrl: input.pageUrl ?? null,
          referrer: input.referrer ?? null,
          status: 'received',
        },
      });
    });

    if (isHoneypotTripped(answers)) {
      // Recorded as refused, and answered as though it worked: the one case where telling the
      // truth to the caller makes the defence useless.
      await this.settle(form.organizationId, submissionId, {
        status: 'rejected',
        error: 'Honeypot field was filled in, which a person never does.',
      });
      this.logger.info({ formId: form.id }, 'form submission refused: honeypot');
      return this.thankYou(form);
    }

    const errors = validateFormSubmission(views, answers);
    if (errors.length > 0) {
      await this.settle(form.organizationId, submissionId, {
        status: 'rejected',
        error: errors.map((error) => `${error.field}: ${error.message}`).join('; '),
      });
      throw AppError.validation('Some answers need correcting', errors);
    }

    try {
      const capture = await this.inTenant(form.organizationId, async () =>
        this.leads.create(await this.captureInput(form, views, answers, input)),
      );
      const attached = 'attachedToExisting' in capture && capture.attachedToExisting === true;
      await this.settle(form.organizationId, submissionId, {
        status: attached ? 'duplicate' : 'processed',
        leadId: capture.id,
      });
      await this.countSubmission(form.organizationId, form.id);
      this.logger.info(
        { formId: form.id, leadId: capture.id, attached },
        'form submission captured',
      );
      return this.thankYou(form);
    } catch (error) {
      // A refusal the capture path wrote for a person — a duplicate rule set to `reject`, a plan
      // limit reached — is recorded as the refusal it is and passed on. Anything else is ours, and
      // the submission row is the only reason it is recoverable.
      const refused = error instanceof AppError && error.status < 500;
      await this.settle(form.organizationId, submissionId, {
        status: refused ? 'rejected' : 'error',
        error: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error',
      });
      if (refused) throw error;
      this.logger.error(
        { formId: form.id, submissionId, err: error },
        'form submission failed after the payload was stored',
      );
      throw new AppError(
        'INTERNAL_ERROR',
        'We could not record that just now. Your details were saved and somebody will be in touch.',
        500,
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The form behind a public key, across tenants.
   *
   * `withPlatformScope` because there is no session to scope by; the reason string is what makes
   * that auditable. Inactive and deleted forms answer **404**, the same answer a key that never
   * existed gets: a deactivated form must not be distinguishable from a made-up URL, or the key
   * becomes an oracle for "which workspaces exist".
   */
  private async loadByKey(publicKey: string) {
    const row = await withPlatformScope('public form lookup by its own key', async () =>
      this.db.client.form.findFirst({
        where: { publicKey, isActive: true, deletedAt: null },
        include: {
          organization: { select: { id: true, name: true, defaultPhoneCountry: true } },
          fields: { orderBy: [{ stepIndex: 'asc' }, { sortOrder: 'asc' }] },
        },
      }),
    );
    if (!row) throw AppError.notFound('Form');
    return {
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      name: row.name,
      type: row.type as string,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      pipelineId: row.pipelineId,
      leadSourceId: row.leadSourceId,
      fields: row.fields,
    };
  }

  /** Runs `fn` as the workspace itself: every write under this does, by design. */
  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      systemPrincipal(organizationId, requestStore.requestId() ?? newId()),
      fn,
    );
  }

  /**
   * The form's fields as the renderer and the validator see them.
   *
   * A custom field's kind, options and required-ness come from its **definition**, which is read
   * inside the tenant's context — the definition is the workspace's own row, and the form only
   * overrides its label, placeholder and (optionally) its choices.
   */
  private async fieldViews(form: {
    organizationId: string;
    fields: readonly {
      id: string;
      standardFieldKey: string | null;
      customFieldDefinitionId: string | null;
      label: string;
      placeholder: string | null;
      helpText: string | null;
      isRequired: boolean;
      stepIndex: number;
      options: unknown;
    }[];
  }): Promise<FormFieldView[]> {
    const definitions = await this.inTenant(form.organizationId, async () =>
      this.fields.definitionsFor('lead'),
    );
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));

    const views: FormFieldView[] = [];
    for (const field of form.fields) {
      const name = formFieldName(field);
      const overrides = Array.isArray(field.options)
        ? (field.options as { value: string; label: string }[])
        : null;

      if (field.standardFieldKey !== null) {
        const spec = formStandardField(field.standardFieldKey);
        // A key the product no longer offers is skipped rather than guessed at: rendering an input
        // whose answer has nowhere to go would lose what somebody typed.
        if (!spec) continue;
        views.push({
          id: field.id,
          name,
          label: field.label,
          kind: spec.kind,
          required: field.isRequired,
          stepIndex: field.stepIndex,
          placeholder: field.placeholder,
          helpText: field.helpText,
          ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
        });
        continue;
      }

      const definition = field.customFieldDefinitionId
        ? byId.get(field.customFieldDefinitionId)
        : undefined;
      // Deactivated or deleted since the form was built. Same reasoning as above.
      if (!definition) continue;
      const spec = customFieldSpec(definition.type);
      const options =
        overrides ??
        definition.options
          .filter((option) => option.isActive)
          .map((option) => ({ value: option.value, label: option.label }));
      views.push({
        id: field.id,
        name,
        label: field.label,
        kind: kindForCustomField(definition.type),
        // A definition that is required is required wherever it is asked, including here.
        required: field.isRequired || definition.isRequired,
        stepIndex: field.stepIndex,
        placeholder: field.placeholder ?? definition.placeholder,
        helpText: field.helpText ?? definition.helpText,
        ...(spec?.requiresOptions || options.length > 0 ? { options } : {}),
      });
    }
    return views;
  }

  /**
   * The answers, as the shared capture path's input (`FR-CAP-4`).
   *
   * Everything a form can set goes through `LeadsService.create` — duplicate detection, scoring,
   * assignment, the SLA clock, the timeline and the events — because one ingestion path is the
   * requirement, and a second one here would be a second set of rules nobody remembers to update.
   */
  private async captureInput(
    form: {
      id: string;
      name: string;
      organizationId: string;
      pipelineId: string | null;
      leadSourceId: string | null;
    },
    views: readonly FormFieldView[],
    answers: Readonly<Record<string, unknown>>,
    input: SubmitFormInput,
  ) {
    const lead: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    const consent: Record<string, boolean> = {};
    // Label and value, in the order the form asks them, for the timeline entry: a free-text
    // message has no column in this schema and the lead's history is where it belongs.
    const recorded: { label: string; value: string }[] = [];

    const definitions = await this.inTenant(form.organizationId, async () =>
      this.fields.definitionsFor('lead'),
    );
    const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

    for (const view of views) {
      const raw = answers[view.name];
      if (raw === undefined || raw === null || raw === '') continue;

      if (view.name.startsWith('standard:')) {
        const key = view.name.slice('standard:'.length);
        const spec = formStandardField(key);
        if (!spec) continue;
        if (spec.target === 'consent' && spec.consentKey) {
          const ticked = raw === true || raw === 'true' || raw === 'on' || raw === '1';
          consent[spec.consentKey] = ticked;
          recorded.push({ label: view.label, value: ticked ? 'Yes' : 'No' });
          continue;
        }
        if (spec.target === 'message') {
          recorded.push({ label: view.label, value: String(raw).trim().slice(0, 2000) });
          continue;
        }
        if (spec.leadField === 'valueMinor') {
          // Asked in whole rupees, stored in minor units — the same convention the rest of the
          // product uses, and the reason the label says "Budget" and the column does not.
          const major = Number(String(raw).replace(/[,\s]/g, ''));
          if (Number.isFinite(major) && major >= 0) {
            lead['valueMinor'] = Math.round(major * 100);
            recorded.push({ label: view.label, value: String(major) });
          }
          continue;
        }
        if (spec.leadField === 'fullName') {
          // `splitFullName` from the shared package, which the import has used since Phase 2: the
          // surname is the **last** word. This code's first draft took the first word as the given
          // name and the rest as the surname, so "Priya Sharma Nair" was split one way through a
          // form and another way through a spreadsheet — the same person, two names, nothing
          // failing.
          const split = splitFullName(String(raw));
          lead['firstName'] = split.firstName;
          if (split.lastName) lead['lastName'] = split.lastName;
          recorded.push({ label: view.label, value: String(raw).trim() });
          continue;
        }
        if (spec.leadField) {
          lead[spec.leadField] = String(raw).trim();
          recorded.push({ label: view.label, value: String(raw).trim() });
        }
        continue;
      }

      const definitionId = view.name.slice('custom:'.length);
      const definition = definitionById.get(definitionId);
      if (!definition) continue;
      custom[definition.key] = raw;
      recorded.push({
        label: view.label,
        value: Array.isArray(raw) ? raw.map(String).join(', ') : String(raw),
      });
    }

    // Anything the page sent that is not a field on this form. Kept (it is in `raw_payload`
    // already) and reported, which is what `FR-CAP-5` asks for; the admin's one-click "create a
    // custom field from this" arrives with the public API in the next step.
    const known = new Set(views.map((view) => view.name));
    const unmapped = Object.keys(answers).filter(
      (key) => !known.has(key) && key !== FORM_HONEYPOT_FIELD,
    );
    if (unmapped.length > 0) {
      this.logger.info({ formId: form.id, unmapped }, 'form submission had unmapped answers');
    }

    return {
      ...lead,
      ...(Object.keys(custom).length > 0 ? { customValues: custom } : {}),
      ...(Object.keys(consent).length > 0 ? { consent } : {}),
      ...(form.leadSourceId ? { leadSourceId: form.leadSourceId } : {}),
      ...(form.pipelineId ? { pipelineId: form.pipelineId } : {}),
      createdVia: 'form' as const,
      utm: normalizeUtm(input.utm),
      ...(input.pageUrl ? { landingPageUrl: input.pageUrl } : {}),
      // Internal capture context: not reachable over `POST /leads`, which is what stops a client
      // fabricating a form submission and the attribution that comes with it.
      formId: form.id,
      formName: form.name,
      formAnswers: recorded,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.visitorId ? { visitorId: input.visitorId } : {}),
      // Three facts `FR-WEB-6` names that this function stored on `form_submissions` and then
      // dropped before the lead. `referrer` was read from the request and discarded; `visitorId`
      // was passed to the capture and written nowhere; `device` did not exist. All three are
      // attribution, and attribution that is only in the submission row is attribution no report
      // can reach.
      ...(input.referrer ? { referrer: input.referrer } : {}),
      ...(input.device ? { device: input.device } : {}),
    } as never;
  }

  /** The outcome of a submission, written as an update to the row that already exists. */
  private async settle(
    organizationId: string,
    submissionId: string,
    outcome: {
      status: 'processed' | 'duplicate' | 'rejected' | 'error';
      leadId?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.formSubmission.update({
        where: { id: submissionId },
        data: {
          status: outcome.status,
          ...(outcome.leadId ? { leadId: outcome.leadId } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
    });
  }

  /** The counter the list screen reads, so it never has to count rows. */
  private async countSubmission(organizationId: string, formId: string): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.form.update({
        where: { id: formId },
        data: { submissionCount: { increment: 1 }, lastSubmissionAt: new Date() },
      });
    });
  }

  /** What the visitor is told, and where they are sent. */
  private thankYou(form: { settings: Record<string, unknown> }) {
    const message =
      typeof form.settings['thankYouMessage'] === 'string'
        ? (form.settings['thankYouMessage'] as string)
        : 'Thank you — we have your details and will be in touch shortly.';
    const redirectUrl =
      typeof form.settings['redirectUrl'] === 'string'
        ? (form.settings['redirectUrl'] as string)
        : null;
    return { received: true, message, redirectUrl };
  }

  /**
   * A keyed hash of the address, never the address.
   *
   * Enough to count submissions from one place inside a window and to recognise a flood; not a
   * record of where a member of the public was sitting, which is nobody's business and would make
   * every form submission a personal-data decision (docs/security.md §9). Keyed with the
   * deployment's master key so the hashes cannot be reversed with a list of the IPv4 space.
   */
  private hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHmac('sha256', this.config.ENCRYPTION_MASTER_KEY)
      .update(ip)
      .digest('base64url')
      .slice(0, 32);
  }
}

/** How a custom field's type is drawn on a public form. */
function kindForCustomField(type: string): FormFieldView['kind'] {
  switch (type) {
    case 'textarea':
      return 'textarea';
    case 'number':
    case 'decimal':
    case 'currency':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'select':
    case 'radio':
      return 'select';
    case 'multiselect':
    case 'checkbox_group':
      return 'multiselect';
    case 'email':
      return 'email';
    case 'phone':
      return 'phone';
    case 'url':
      return 'url';
    case 'date':
    case 'datetime':
      return 'date';
    case 'rating':
      return 'rating';
    default:
      return 'text';
  }
}
