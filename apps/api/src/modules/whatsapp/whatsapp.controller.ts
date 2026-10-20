import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Headers,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { CannedRepliesService } from './canned-replies.service.js';
import { ConversationNotesService } from './conversation-notes.service.js';
import { ConversationOwnershipService } from './conversation-ownership.service.js';
import { ConversationsService } from './conversations.service.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { WhatsAppMediaService } from './whatsapp-media.service.js';
import { WhatsAppSendService } from './whatsapp-send.service.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import { WhatsAppUsageService } from './whatsapp-usage.service.js';
import {
  assignConversationSchema,
  attachmentQuerySchema,
  closeConversationSchema,
  connectWabaSchema,
  createCannedReplySchema,
  createNoteSchema,
  createTemplateSchema,
  listConversationsSchema,
  listMessagesSchema,
  listTemplatesSchema,
  previewTemplateSchema,
  setTagsSchema,
  snoozeConversationSchema,
  syncTemplatesSchema,
  transferConversationSchema,
  updateCannedReplySchema,
  usageQuerySchema,
  sendMessageSchema,
  setDefaultAgentSchema,
  updateTemplateSchema,
  type AssignConversationInput,
  type AttachmentQuery,
  type CloseConversationInput,
  type ConnectWabaInput,
  type CreateCannedReplyInput,
  type CreateNoteInput,
  type CreateTemplateInput,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type ListTemplatesQuery,
  type PreviewTemplateQuery,
  type SendMessageInput,
  type SetDefaultAgentInput,
  type SetTagsInput,
  type SnoozeConversationInput,
  type SyncTemplatesInput,
  type TransferConversationInput,
  type UpdateCannedReplyInput,
  type UsageQuery,
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
    private readonly ownership: ConversationOwnershipService,
    private readonly notes: ConversationNotesService,
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
   * Takes the soft ownership lock, or refreshes it (`FR-WA-7`).
   *
   * `conversation:reply`, not `conversation:assign`: the lock is "I am typing", which anybody who
   * may answer may say. It is **advisory** — taking one a colleague holds is allowed and comes back
   * with the state, because refusing it means a customer waits until somebody else's five minutes
   * run out. The override is written to the audit log instead.
   */
  @Post(':id/claim')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async claim(@Param('id') id: string) {
    return this.ownership.claim(id);
  }

  /** Gives it up. A colleague's lock is left alone — releasing it would be a lie. */
  @Delete(':id/claim')
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async release(@Param('id') id: string) {
    return this.ownership.release(id);
  }

  /**
   * Hands a conversation to somebody, or back to the pool (`FR-WA-7`).
   *
   * `conversation:assign`, which has been in the catalogue since Phase 1 with nothing reading it.
   */
  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_ASSIGN)
  async assign(
    @Param('id') id: string,
    @Body(zodBody(assignConversationSchema)) body: AssignConversationInput,
  ) {
    return withMessage(
      await this.ownership.assign(id, body.assignedUserId, body.reason ?? null),
      body.assignedUserId === null ? 'Back in the pool.' : 'Assigned.',
    );
  }

  /** A transfer: a recipient and a reason, both required, both audited. */
  @Post(':id/transfer')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_ASSIGN)
  async transfer(
    @Param('id') id: string,
    @Body(zodBody(transferConversationSchema)) body: TransferConversationInput,
  ) {
    return withMessage(
      await this.ownership.transfer(id, body.toUserId, body.note),
      'Transferred. They have been told, with your note.',
    );
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async close(
    @Param('id') id: string,
    @Body(zodBody(closeConversationSchema)) body: CloseConversationInput,
  ) {
    return withMessage(await this.ownership.close(id, body.note ?? null), 'Closed.');
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async reopen(@Param('id') id: string) {
    return withMessage(await this.ownership.reopen(id), 'Open again.');
  }

  /**
   * Puts it aside until an instant.
   *
   * The sweep is what brings it back, which is why this is a time rather than a flag: a snooze that
   * expired without telling anybody is a conversation nobody ever sees again.
   */
  @Post(':id/snooze')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async snooze(
    @Param('id') id: string,
    @Body(zodBody(snoozeConversationSchema)) body: SnoozeConversationInput,
  ) {
    return withMessage(
      await this.ownership.snooze(id, body.until),
      'Put aside. It will come back and you will be told.',
    );
  }

  /** The internal notes on a conversation. `conversation:read`, like the conversation itself. */
  @Get(':id/notes')
  @RequirePermission(PERMISSIONS.CONVERSATION_READ)
  async notesList(@Param('id') id: string) {
    return this.notes.list(id);
  }

  /**
   * Writes one, and tells everybody it names (`FR-WA-7`'s @mentions).
   *
   * `conversation:reply` rather than `conversation:read`: a note is a thing somebody adds to the
   * record, and the permission that lets you write to a conversation is the one that should let you
   * write about it.
   */
  @Post(':id/notes')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async noteCreate(
    @Param('id') id: string,
    @Body(zodBody(createNoteSchema)) body: CreateNoteInput,
  ) {
    return withMessage(
      await this.notes.create(id, body.body, body.mentionedUserIds ?? []),
      body.mentionedUserIds && body.mentionedUserIds.length > 0
        ? 'Noted. The people you mentioned have been told.'
        : 'Noted.',
    );
  }

  /**
   * Replaces a conversation's tags (`FR-WA-7`).
   *
   * `PUT`, because it is the whole set: two endpoints for one field is how a screen and an API end
   * up disagreeing about what is on a row. The values are lower-cased and hyphenated on the way in,
   * so a filter on `site-visit` cannot miss a conversation somebody typed `Site Visit` on.
   */
  @Put(':id/tags')
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async setTags(@Param('id') id: string, @Body(zodBody(setTagsSchema)) body: SetTagsInput) {
    return withMessage(await this.ownership.setTags(id, body.tags), 'Tags saved.');
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

/**
 * Canned replies (`FR-WA-7`).
 *
 * Behind `conversation:reply` rather than `whatsapp:manage`: a canned reply is an agent's own
 * shorthand for something they say often, not the business's reviewed wording — that is a template,
 * and templates are behind `whatsapp:manage` for exactly that reason. A **shared** reply can be
 * edited by anybody who may reply, because a typo in the wording everybody sends should not be
 * something only one person can correct; a **private** one is its owner's.
 */
@Controller('canned-replies')
export class CannedRepliesController {
  constructor(private readonly replies: CannedRepliesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async list() {
    return this.replies.list();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async create(@Body(zodBody(createCannedReplySchema)) body: CreateCannedReplyInput) {
    return withMessage(
      await this.replies.create(body),
      `Saved. Type ${body.shortcut.startsWith('/') ? body.shortcut : `/${body.shortcut}`} in the composer to use it.`,
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateCannedReplySchema)) body: UpdateCannedReplyInput,
  ) {
    return withMessage(await this.replies.update(id, body), 'Saved.');
  }

  /** Archives it. Never deletes: a reply that has been sent has messages pointing at it. */
  @Delete(':id')
  @RequirePermission(PERMISSIONS.CONVERSATION_REPLY)
  async archive(@Param('id') id: string) {
    return withMessage(await this.replies.archive(id), 'Removed from the picker.');
  }
}

/**
 * What WhatsApp cost this workspace (`FR-BIL-4`).
 *
 * Behind `billing:read`, not `whatsapp:manage`: this is an invoice question, and the person who
 * reconciles an invoice is not necessarily the person who connects a number. Counts only — Meta's
 * prices are per-country and change, and a rate card in this codebase would be wrong within a
 * quarter and wrong silently on somebody's bill.
 */
@Controller('whatsapp/usage')
export class WhatsAppUsageController {
  constructor(private readonly usage: WhatsAppUsageService) {}

  @Get()
  @RequirePermission(PERMISSIONS.BILLING_READ)
  async summary(@Query(new ZodBody(usageQuerySchema)) query: UsageQuery) {
    // This month by default, because that is the period an invoice covers and the only reason
    // anybody opens this screen.
    const now = new Date();
    const from = query.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return this.usage.summary({ from, to });
  }
}
