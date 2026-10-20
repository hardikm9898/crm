import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Headers,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ConversationsService } from './conversations.service.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { WhatsAppMediaService } from './whatsapp-media.service.js';
import { WhatsAppSendService } from './whatsapp-send.service.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import {
  attachmentQuerySchema,
  connectWabaSchema,
  createTemplateSchema,
  listConversationsSchema,
  listMessagesSchema,
  listTemplatesSchema,
  previewTemplateSchema,
  syncTemplatesSchema,
  sendMessageSchema,
  setDefaultAgentSchema,
  updateTemplateSchema,
  type AttachmentQuery,
  type ConnectWabaInput,
  type CreateTemplateInput,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type ListTemplatesQuery,
  type PreviewTemplateQuery,
  type SendMessageInput,
  type SetDefaultAgentInput,
  type SyncTemplatesInput,
  type UpdateTemplateInput,
} from './whatsapp.dto.js';

/**
 * The inbox, read (`FR-WA-7`, `FR-WA-8`).
 *
 * Behind `conversation:read`, which supports a scope — so a branch-scoped agent sees their branch's
 * conversations and an own-scoped one sees theirs, decided by `DataScopeService` rather than by a
 * filter written here.
 *
 * Sending arrived with step 2. Assignment, transfer, close, reopen and notes are still absent —
 * the shared inbox's own step — and a route that pretended to do one of them would be worse than
 * its absence.
 */
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    // `send_` because a property may not share its name with a method on the same class: the method
    // would shadow it on `this` and every `this.send.send(...)` would call itself. The symptom is a
    // DI-shaped error on a class whose dependencies are fine.
    private readonly send_: WhatsAppSendService,
    private readonly media: WhatsAppMediaService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async list(@Query(new ZodBody(listConversationsSchema)) query: ListConversationsQuery) {
    return this.conversations.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async findOne(@Param('id') id: string) {
    return this.conversations.findOne(id);
  }

  @Get(':id/messages')
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async messages(
    @Param('id') id: string,
    @Query(new ZodBody(listMessagesSchema)) query: ListMessagesQuery,
  ) {
    return this.conversations.messages(id, query);
  }

  /**
   * Marks it read.
   *
   * `conversation:read` rather than `conversation:reply`: reading is what this records, and an
   * agent who may open a conversation may say they have read it. Nothing is sent.
   */
  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async markRead(@Param('id') id: string) {
    return this.conversations.markRead(id);
  }

  /**
   * Sends a reply (`FR-WA-1`, `FR-WA-9`).
   *
   * `202`-shaped in meaning: what comes back is `queued`, because the send is a queue hop — a
   * message somebody typed must not be lost to a provider timeout. The status advances under it in
   * the thread as Meta's receipts arrive.
   */
  @Post(':id/messages')
  @HttpCode(202)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async send(@Param('id') id: string, @Body(zodBody(sendMessageSchema)) body: SendMessageInput) {
    return withMessage(
      await this.send_.send(id, body),
      'On its way. The thread will show when WhatsApp has it.',
    );
  }

  /** Tries a failed message again, on the same row (`FR-WA-9`'s "retryable"). */
  @Post(':id/messages/:messageId/retry')
  @HttpCode(202)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async retry(@Param('id') id: string, @Param('messageId') messageId: string) {
    return withMessage(await this.send_.retry(id, messageId), 'Trying again.');
  }

  /**
   * Sends a file (`FR-WA-3`).
   *
   * The body **is** the bytes — one file and nothing else, so the name and the caption travel in
   * the query string and no multipart parser is needed. `MediaUploadInstaller` is what gives this
   * one path a sixteen-megabyte limit, and what refuses those content types everywhere else before
   * a byte is read.
   *
   * Two steps in one request, in this order on purpose: the file is stored by **us** first, and
   * only then is the message queued — so a provider refusal is a failed message with a retry
   * button beside the file somebody chose, not a lost upload.
   */
  @Post(':id/attachments')
  @HttpCode(202)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async attach(
    @Param('id') id: string,
    @Query(new ZodBody(attachmentQuerySchema)) query: AttachmentQuery,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
  ) {
    // Not refused here: a body check before the service would answer 400 on a request for
    // somebody else's conversation, which is an oracle and a refusal the route never earned.
    // `attach` checks the conversation first and the bytes second.
    const upload = await this.media.attach(id, {
      bytes: Buffer.isBuffer(body) ? body : null,
      // The file's own type, as the browser sent it: `typeForMime` is what turns it into a WhatsApp
      // kind, and a photo posted as `application/octet-stream` is honestly a document.
      mimeType: (contentType ?? '').split(';')[0]?.trim() || 'application/octet-stream',
      fileName: query.fileName,
      caption: query.caption ?? null,
    });
    return withMessage(
      await this.send_.send(id, { kind: 'media', upload }),
      'On its way. The thread will show when WhatsApp has it.',
    );
  }

  /**
   * The bytes of one message's attachment.
   *
   * Straight through the reply, like the export download: a file is not an envelope. `inline` for a
   * photo, because the thread shows it where it is, and `attachment` for a document so the browser
   * saves it — with `nosniff` either way, since a file a stranger sent us must never be interpreted
   * as HTML on our own origin.
   */
  @Get(':id/messages/:messageId/media')
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async attachment(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.media.read(id, messageId);
    await reply
      .header('content-type', file.mimeType)
      .header(
        'content-disposition',
        `${file.inline ? 'inline' : 'attachment'}; filename="${file.fileName.replace(/["\\]/g, '')}"`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(file.bytes);
  }
}

/**
 * The WhatsApp connection (`FR-WA-2`).
 *
 * Behind `whatsapp:manage`, which has been in the catalogue since Phase 1 with nothing reading it.
 * The credential itself belongs to the integration framework — this is the WABA and its numbers,
 * which is the shape a conversation needs.
 */
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly accounts: WhatsAppAccountsService) {}

  @Get('accounts')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async list() {
    return this.accounts.list();
  }

  /**
   * Verifies the connection's WABA and stores it with its numbers.
   *
   * Idempotent: pressing it again after adding a number in Meta is how a workspace refreshes the
   * list, which is the honest answer to "where did my new number go".
   */
  @Post('accounts')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async connect(@Body(zodBody(connectWabaSchema)) body: ConnectWabaInput) {
    return withMessage(
      await this.accounts.connect(body.connectionId),
      'Connected. Your numbers are listed below — the callback URL is on the integration.',
    );
  }

  @Patch('numbers/:id')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async setDefaultAgent(
    @Param('id') id: string,
    @Body(zodBody(setDefaultAgentSchema)) body: SetDefaultAgentInput,
  ) {
    return this.accounts.setDefaultAgent(id, body.userId);
  }
}

/**
 * Message templates (`FR-WA-5`).
 *
 * Behind `whatsapp:manage` rather than `conversation:reply`: a template is the business's own
 * wording, submitted to Meta for review, and changing one changes what every agent sends. Sending
 * one is a reply and takes the reply permission, which is the line between the two.
 */
@Controller('whatsapp/templates')
export class WhatsAppTemplatesController {
  constructor(private readonly templates: WhatsAppTemplatesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async list(@Query(new ZodBody(listTemplatesSchema)) query: ListTemplatesQuery) {
    return this.templates.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async findOne(@Param('id') id: string) {
    return this.templates.findOne(id);
  }

  /**
   * What this template will say to this person.
   *
   * A `GET`, and read-only: rendering a page must never run a mutation, and a preview that was a
   * POST would be a state transition driven by the browser's reload button.
   */
  @Get(':id/preview')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async preview(
    @Param('id') id: string,
    @Query(new ZodBody(previewTemplateSchema)) query: PreviewTemplateQuery,
  ) {
    return this.templates.preview(id, query.leadId ?? null);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async create(@Body(zodBody(createTemplateSchema)) body: CreateTemplateInput) {
    return withMessage(
      await this.templates.create(body),
      'Saved as a draft. Submit it when the wording is right — WhatsApp reviews it before it can be sent.',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateTemplateSchema)) body: UpdateTemplateInput) {
    return this.templates.update(id, body);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(
      await this.templates.remove(id),
      'Archived. Messages already sent with it keep reading correctly.',
    );
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async submit(@Param('id') id: string) {
    return withMessage(
      await this.templates.submit(id),
      'Sent to WhatsApp for review. They usually answer within a day.',
    );
  }

  /**
   * Reconciles one account's templates against Meta.
   *
   * A POST because it talks to somebody else's server and writes what it learns; the scheduled
   * sweep does the same thing every six hours, and this is the button for the person who has just
   * been approved and does not want to wait.
   */
  @Post('sync')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE)
  async sync(@Body(zodBody(syncTemplatesSchema)) body: SyncTemplatesInput) {
    const result = await this.templates.sync(body.accountId);
    return withMessage(
      result,
      result.updated === 0 && result.adopted === 0
        ? 'Nothing has changed at WhatsApp.'
        : `Updated ${result.updated} and found ${result.adopted} new.`,
    );
  }
}
