import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ApiKeysService } from './api-keys.service.js';
import {
  createApiKeySchema,
  listApiKeysSchema,
  updateApiKeySchema,
  type CreateApiKeyInput,
  type ListApiKeysQuery,
  type UpdateApiKeyInput,
} from './api-keys.dto.js';

/**
 * API keys (`FR-API-2`, `FR-CAP-7`).
 *
 * All of it behind `api_key:manage`, which has been in the catalogue since Phase 1 with nothing
 * reading it: a key that can post leads into the workspace is a credential, and there is no
 * "read-only" view of one worth a separate permission — the list shows prefixes and usage, which
 * is exactly what somebody holding this permission needs and nobody else does.
 */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async list(@Query(new ZodBody(listApiKeysSchema)) query: ListApiKeysQuery) {
    return this.keys.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async findOne(@Param('id') id: string) {
    return this.keys.findOne(id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async create(@Body(zodBody(createApiKeySchema)) body: unknown) {
    const created = await this.keys.create(body as CreateApiKeyInput);
    return withMessage(created, 'Key created — copy the secret now, it is not shown again');
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateApiKeySchema)) body: unknown) {
    return withMessage(await this.keys.update(id, body as UpdateApiKeyInput), 'Key updated');
  }

  @Post(':id/rotate')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async rotate(@Param('id') id: string) {
    const rotated = await this.keys.rotate(id);
    return withMessage(
      rotated,
      'New secret created — copy it now. The previous one stopped working.',
    );
  }

  @Post(':id/revoke')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async revoke(@Param('id') id: string) {
    return withMessage(await this.keys.revoke(id), 'Key revoked');
  }
}
