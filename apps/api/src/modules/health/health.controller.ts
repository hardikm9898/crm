import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { raw } from '../../infra/http/envelope.interceptor.js';
import { HealthService } from './health.service.js';

/**
 * Probe endpoints. `/health/live` and `/health/ready` return bare bodies because load
 * balancers and orchestrators read the status code, not our envelope.
 *
 * `/health/deep` is deliberately unauthenticated only until the auth module lands in
 * step 2, at which point it moves behind platform authentication — it exposes
 * operational internals, not tenant data.
 */
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
      throw new ServiceUnavailableException({ message: 'Dependencies unavailable', ...report });
    }
    return raw(report);
  }

  @Get('deep')
  async deep() {
    return this.health.deep();
  }
}
