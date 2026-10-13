import { Controller, Get } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { TodayService } from './today.service.js';

/**
 * The executive workspace (`FR-TSK-7`) — `GET /my/today`.
 *
 * Under `/my/` rather than `/today`, because the path says whose it is: there is no parameter that
 * makes this somebody else's screen, and a route that reads as a global noun invites one.
 *
 * **`task:read` is the gate, and the other two sections degrade rather than refuse.** The screen is
 * mostly a follow-up queue, so somebody who cannot read tasks has no business here; but a role that
 * withholds `lead:read` or `sla:read` should still get the queue, with those sections marked
 * unavailable. A 403 on the whole screen because one of five sections is not theirs would make the
 * product's landing page unreachable for a perfectly reasonable configuration — and `@RequirePermission`
 * takes one permission for exactly this reason: the finer-grained answer belongs in the service,
 * which can give a partial one.
 */
@Controller('my')
export class TodayController {
  constructor(private readonly today: TodayService) {}

  @Get('today')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async get() {
    return this.today.today();
  }
}
