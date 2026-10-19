import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ApiLogService } from './api-log.service.js';
import { listApiLogsSchema, type ListApiLogsQuery } from './api-logs.dto.js';

/**
 * What this workspace's keys have been doing (`FR-API-1`, `FR-SA-4`).
 *
 * Behind `api_key:manage`, with the keys themselves, rather than behind a permission of its own:
 * the log is about the credentials, and somebody who may create a key is the person who has to
 * find out why one is being refused. It deliberately carries no request or response bodies, so
 * holding this permission does not become a way to read leads.
 */
@Controller('api-logs')
export class ApiLogsController {
  constructor(private readonly logs: ApiLogService) {}

  @Get()
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async list(@Query(new ZodBody(listApiLogsSchema)) query: ListApiLogsQuery) {
    return this.logs.list(query);
  }

  @Get('usage')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async usage() {
    return { items: await this.logs.usageByKey(), pagination: null };
  }
}
