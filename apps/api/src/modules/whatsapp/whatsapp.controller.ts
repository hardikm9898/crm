import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ConversationsService } from './conversations.service.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import {
  connectWabaSchema,
  listConversationsSchema,
  listMessagesSchema,
  setDefaultAgentSchema,
  type ConnectWabaInput,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type SetDefaultAgentInput,
} from './whatsapp.dto.js';

/**
 * The inbox, read (`FR-WA-7`, `FR-WA-8`).
 *
 * Behind `conversation:read`, which supports a scope — so a branch-scoped agent sees their branch's
 * conversations and an own-scoped one sees theirs, decided by `DataScopeService` rather than by a
 * filter written here.
 *
 * There is no `POST /conversations/{id}/messages` yet: sending is the next step, and a route that
 * accepted a message nothing could deliver would be worse than its absence. The same goes for
 * assignment, transfer, close and notes — the shared inbox's own step. What exists is what this
 * step can honestly answer: the list, one conversation with its lead context, its messages, and
 * marking it read.
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

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
