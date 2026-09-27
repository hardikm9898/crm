import { Controller, Get, HttpCode } from '@nestjs/common';
import { AppError } from '@leados/shared';
import { raw } from '../../infra/http/envelope.interceptor.js';
import { Public } from '../auth/guards/public.decorator.js';
import { HealthService } from './health.service.js';

/**
 * Probe endpoints. `/health/live` and `/health/ready` return bare bodies because load
 * balancers and orchestrators read the status code, not our envelope.
 *
 * `/health/deep` is deliberately unauthenticated only until the auth module lands in
 * step 2, at which point it moves behind platform authentication — it exposes
 * operational internals, not tenant data.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(200)
  live() {
    return raw(this.health.liveness());
  }

  @Get('ready')
  async ready() {
    const report = await this.health.readiness();
    if (report.status === 'down') {
      // The details travel in the error envelope so the response itself says which
      // dependency failed and why.
      throw new AppError('INTEGRATION_UNAVAILABLE', 'Dependencies unavailable', 503, {
        components: report.components,
      });
    }
    return raw(report);
  }

  @Get('deep')
  async deep() {
    return this.health.deep();
  }
}
