import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { OversightService } from './oversight.service.js';
import { oversightQuerySchema, type OversightQuery } from './oversight.dto.js';

/**
 * Manager oversight — `GET /oversight`.
 *
 * **One route, not one per role.** `docs/api-architecture.md` sketched
 * `GET /dashboard/{owner|manager|executive|…}`; a path named after a role is what rule 4 forbids,
 * and the breadth of the answer is already decided by the caller's `report:read` scope — a branch
 * manager sees their branch and the owner sees the workspace, from the same endpoint. The same
 * arrangement `/sla/board` settled in step 2.
 *
 * `report:read` was already in the catalogue and already granted to the manager, marketing-manager
 * and auditor templates, so there is no new permission and no data migration here — which is worth
 * saying out loud, because every previous step that added one needed both.
 */
@Controller('oversight')
export class OversightController {
  constructor(private readonly oversight: OversightService) {}

  @Get()
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async board(@Query(new ZodBody(oversightQuerySchema)) query: OversightQuery) {
    return this.oversight.board(query);
  }
}
