import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { IntegrationsService } from './integrations.service.js';
import {
  connectIntegrationSchema,
  listHealthChecksSchema,
  listIntegrationsSchema,
  previewMappingSchema,
  updateIntegrationSchema,
  type ConnectIntegrationInput,
  type ListHealthChecksQuery,
  type ListIntegrationsQuery,
  type PreviewMappingInput,
  type UpdateIntegrationInput,
} from './integrations.dto.js';

/**
 * Connected providers (Phase 4's integration framework).
 *
 * All of it behind `integration:manage`, and there is deliberately **no read-only view**: a
 * connection carries a workspace's credential, its field mapping decides where every captured lead
 * lands, and its health history is the operational detail of a credential. Somebody who may read
 * those may change them — the same argument the outbound webhook surface makes, and the reason
 * neither permission is one an API key can be granted. A credential that could mint credentials is
 * a privilege escalation left in somebody else's config file.
 *
 * There is no `DELETE`: a disconnect is soft, because `inbound_payloads` references the connection
 * that brought each lead in and a hard delete would either orphan that history or make a mistaken
 * connection permanent.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * What can be connected, and what already is.
   *
   * Declared **before** `:id`, or `/integrations/providers` is read as a connection id and answers
   * 404 from the global UUID pipe.
   */
  @Get('providers')
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async providers() {
    return this.integrations.catalogue();
  }

  @Get('health')
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async health(@Query(new ZodBody(listHealthChecksSchema)) query: ListHealthChecksQuery) {
    return this.integrations.healthChecks(query);
  }

  @Get()
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async list(@Query(new ZodBody(listIntegrationsSchema)) query: ListIntegrationsQuery) {
    return this.integrations.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async findOne(@Param('id') id: string) {
    return this.integrations.findOne(id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async connect(@Body(zodBody(connectIntegrationSchema)) body: ConnectIntegrationInput) {
    return withMessage(
      await this.integrations.connect(body),
      'Connected. If a secret is shown, copy it now — it is not shown again.',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateIntegrationSchema)) body: UpdateIntegrationInput,
  ) {
    return this.integrations.update(id, body);
  }

  /** Probe it now. Refuses, with what to do instead, for a provider there is nothing to ask. */
  @Post(':id/check')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async check(@Param('id') id: string) {
    return this.integrations.check(id);
  }

  /** What a payload would become, through the mapping and the capture's own normalisation. */
  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async preview(
    @Param('id') id: string,
    @Body(zodBody(previewMappingSchema)) body: PreviewMappingInput,
  ) {
    return this.integrations.previewMapping(id, body);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async rotateSecret(@Param('id') id: string) {
    return withMessage(
      await this.integrations.rotateSecret(id),
      'Copy the new secret now — it is not shown again, and the old one has stopped working.',
    );
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async disconnect(@Param('id') id: string) {
    return withMessage(
      await this.integrations.disconnect(id),
      'Disconnected. What it brought in is kept.',
    );
  }
}
