import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  newId,
  renderTemplate,
  sendingAllowed,
  templateBlockedReason,
  templateIsSendable,
  tenantContext,
  type MessageType,
  type TemplateComponents,
  type WhatsAppTemplateStatus,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { presentMessage } from './whatsapp-presenters.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';

/** What somebody is asking us to send. */
export type OutboundRequest =
  | { readonly kind: 'text'; readonly body: string }
  | {
      readonly kind: 'template';
      readonly templateId: string;
      /** Overrides for variables the lead cannot supply. Keyed by the variable's number. */
      readonly variables?: Readonly<Record<string, string>>;
    };

/**
 * Sending a WhatsApp message (`FR-WA-1`, `FR-WA-4`, `FR-WA-9`).
 *
 * The three decisions in this file:
 *
 *  * **The window is checked here, once, by the one function that owns the rule.** Free-form text
 *    needs an open 24-hour window; a template does not. `sendingAllowed` is what the composer calls
 *    to decide whether to offer a text box, so the screen and the write path cannot disagree —
 *    which is the difference between "the button was greyed out" and "the send was refused after I
 *    pressed it".
 *  * **The row is written before the send, and the send is a job.** A message somebody typed is
 *    never lost to a provider timeout: it exists as `queued` the moment they press send, the queue
 *    is what talks to Meta, and `FR-WA-9`'s "never silent" is a status on that row rather than a
 *    toast that disappeared. Per-number rate limiting lives in the processor for the same reason.
 *  * **A template's variables are resolved and refused *before* the row is written.** A send with a
 *    blank variable is the one failure that reaches a customer as "Hi  , your order…", so a missing
 *    value is a 422 naming the variable rather than a message Meta will happily deliver.
 */
@Injectable()
export class WhatsAppSendService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly templates: WhatsAppTemplatesService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Queues one outbound message and answers with the row as the thread will show it.
   *
   * `202`-shaped: what comes back is `queued`, because nothing has reached Meta yet. The screen
   * shows it in the thread immediately — which is what everybody expects of a chat — and the status
   * advances under it as the receipts arrive.
   */
  async send(conversationId: string, request: OutboundRequest) {
    const principal = tenantContext.require('whatsapp.send');
    const conversation = await this.conversationForReply(conversationId);

    if (conversation.number === null || !conversation.number.isActive) {
      throw AppError.businessRule(
        'The number this conversation arrived at is no longer connected, so nothing can be sent from it.',
      );
    }
    if (conversation.contactE164 === null) {
      throw AppError.businessRule('This conversation has no number to reply to.');
    }

    const decision = sendingAllowed({
      windowExpiresAt: conversation.windowExpiresAt,
      kind: request.kind,
    });
    if (!decision.allowed) {
      // 422 with the API's own sentence, which the screen prints rather than paraphrases.
      throw AppError.businessRule(decision.message);
    }

    const prepared =
      request.kind === 'text'
        ? await this.prepareText(request.body)
        : await this.prepareTemplate(conversation, request);

    const messageId = newId();
    const now = new Date();
    await this.db.client.message.create({
      data: {
        id: messageId,
        organizationId: principal.organizationId,
        conversationId: conversation.id,
        direction: 'outbound',
        type: prepared.type,
        body: prepared.body,
        payload: prepared.payload as never,
        provider: 'whatsapp_cloud',
        // No provider id yet, which is exactly why the unique on it is partial.
        providerMessageId: null,
        senderUserId: principal.actorId,
        status: 'queued',
        ...(prepared.templateId === null ? {} : { templateId: prepared.templateId }),
        createdAt: now,
      },
    });

    // The thread's order, immediately: a message that appears only once Meta has accepted it makes
    // the agent wonder whether they pressed the button.
    await this.db.client.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now },
    });

    await this.queues.enqueue(
      QUEUES.MAINTENANCE,
      JOBS.WHATSAPP_SEND_MESSAGE,
      { organizationId: principal.organizationId, aggregateId: messageId },
      // The message's own id: the same message cannot be queued twice, and a different one still
      // can. BullMQ refuses a ':' in a custom id.
      { jobId: `whatsapp-send-${messageId}` },
    );

    this.logger.info(
      { conversationId: conversation.id, messageId, kind: request.kind },
      'a whatsapp message was queued',
    );
    return this.present(messageId);
  }

  /**
   * Tries a failed message again (`FR-WA-9`'s "retryable").
   *
   * The same row rather than a new one: the thread already shows it, the agent already knows it
   * exists, and a second row would read as the customer having been messaged twice. The attempt
   * count is what makes a retry visible, and the job id carries it because BullMQ would otherwise
   * refuse the second enqueue of an id it has already seen.
   */
  async retry(conversationId: string, messageId: string) {
    const principal = tenantContext.require('whatsapp.retry');
    await this.conversationForReply(conversationId);
    const message = await this.db.client.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, status: true, direction: true, sendAttempts: true, createdAt: true },
    });
    if (!message) throw AppError.notFound('Message');
    if (message.direction !== 'outbound') {
      throw AppError.businessRule('That is a message they sent you, so there is nothing to retry.');
    }
    if (message.status !== 'failed') {
      throw AppError.businessRule(
        message.status === 'queued'
          ? 'That message is still on its way.'
          : 'That message has already been sent.',
      );
    }

    await this.db.client.message.updateMany({
      where: { id: messageId },
      data: { status: 'queued', errorCode: null, errorMessage: null, failedAt: null },
    });
    await this.queues.enqueue(
      QUEUES.MAINTENANCE,
      JOBS.WHATSAPP_SEND_MESSAGE,
      { organizationId: principal.organizationId, aggregateId: messageId },
      { jobId: `whatsapp-send-${messageId}-${message.sendAttempts + 1}` },
    );
    return this.present(messageId);
  }

  /** The conversation, through the **reply** scope rather than the read one. */
  private async conversationForReply(id: string) {
    const filter = this.scopes.filterFor('conversation:reply', { userColumn: 'assignedUserId' });
    const scoped = applyScopeFilter({ id }, filter);
    if (scoped === null) throw AppError.notFound('Conversation');
    const row = await this.db.client.conversation.findFirst({
      where: scoped,
      select: {
        id: true,
        contactE164: true,
        windowExpiresAt: true,
        leadId: true,
        channelAccountId: true,
        number: { select: { id: true, phoneNumberId: true, isActive: true, accountId: true } },
      },
    });
    if (!row) throw AppError.notFound('Conversation');
    return row;
  }

  private async prepareText(body: string): Promise<PreparedMessage> {
    const text = body.trim();
    if (text === '') throw AppError.validation('There is nothing to send', [
      { field: 'body', code: 'EMPTY_MESSAGE', message: 'Write something first.' },
    ]);
    return {
      type: 'text',
      body: text,
      templateId: null,
      payload: { kind: 'text', text },
    };
  }

  /**
   * A template, resolved against this conversation's lead.
   *
   * Refused rather than sent blank when a variable cannot be filled, and refused when the template
   * is not approved — with Meta's own standing in the sentence, because "that template cannot be
   * used" tells nobody whether to wait or to edit it.
   */
  private async prepareTemplate(
    conversation: { id: string; leadId: string | null },
    request: { templateId: string; variables?: Readonly<Record<string, string>> },
  ): Promise<PreparedMessage> {
    const template = await this.db.client.whatsAppTemplate.findFirst({
      where: { id: request.templateId, deletedAt: null },
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        status: true,
        components: true,
        variableMap: true,
      },
    });
    if (!template) throw AppError.notFound('Template');
    const status = template.status as WhatsAppTemplateStatus;
    if (!templateIsSendable(status)) {
      throw AppError.businessRule(templateBlockedReason(status) ?? 'That template cannot be sent.');
    }

    const components = template.components as unknown as TemplateComponents;
    const resolved = await this.templates.resolveVariables(
      template.variableMap as Record<string, string>,
      conversation.leadId,
      request.variables ?? {},
    );
    const rendered = renderTemplate(components, resolved);
    if (rendered.missing.length > 0) {
      throw AppError.validation(
        'That template has variables nothing can fill',
        rendered.missing.map((index) => ({
          field: `variables.${index}`,
          code: 'VARIABLE_MISSING',
          // Named, because the alternative is a customer reading "Hi  , your order is ready".
          message: `{{${index}}} has no value for this person. Type one, or fill in their record first.`,
        })),
      );
    }

    // Marketing is the one category consent governs (`FR-WA-10`): a utility message is something
    // the customer asked for, and refusing a delivery notification because nobody ticked a
    // marketing box would be the wrong rule in the other direction.
    if (template.category === 'marketing' && conversation.leadId !== null) {
      const lead = await this.db.client.lead.findFirst({
        where: { id: conversation.leadId },
        select: { consentWhatsapp: true, fullName: true },
      });
      if (lead !== null && lead.consentWhatsapp !== true) {
        throw AppError.businessRule(
          `${lead.fullName ?? 'This person'} has not agreed to marketing messages on WhatsApp. A utility template, or a reply inside the 24-hour window, can still reach them.`,
        );
      }
    }

    return {
      type: 'template',
      body: rendered.text,
      templateId: template.id,
      payload: {
        kind: 'template',
        name: template.name,
        language: template.language,
        category: template.category,
        parameters: rendered.values,
      },
    };
  }

  /** One message, as the thread shows it — through the presenter the list uses. */
  async present(messageId: string) {
    const row = await this.db.client.message.findFirstOrThrow({
      where: { id: messageId },
      include: { sender: { select: { userId: true, user: { select: { name: true } } } } },
    });
    return presentMessage(row);
  }
}

interface PreparedMessage {
  readonly type: MessageType;
  readonly body: string;
  readonly templateId: string | null;
  readonly payload: Record<string, unknown>;
}
