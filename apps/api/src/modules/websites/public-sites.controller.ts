import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/guards/public.decorator.js';
import { PublicSitesService } from './public-sites.service.js';

/**
 * The one endpoint a visitor's browser reaches, through the renderer (`FR-WEB-5`).
 *
 * `@Public()` and declared rather than defaulted, which is why a route that forgets to say so
 * fails at boot. The subdomain in the path is the tenant resolution and nothing else is needed:
 * see `public-sites.service.ts` for why that forces a `withPlatformScope` read.
 *
 * There is no throttle on it, unlike the public form endpoints, and that is deliberate: a form
 * submission writes, while this only reads a snapshot that is identical for every caller. The
 * renderer caches it with ISR and a CDN sits in front of that in production, so the load this
 * route sees is one request per site per revalidation rather than one per visitor. A limiter here
 * would be rate-limiting our own cache.
 */
@Public()
@Controller('public/sites')
export class PublicSitesController {
  constructor(private readonly sites: PublicSitesService) {}

  @Get(':subdomain')
  async snapshot(@Param('subdomain') subdomain: string) {
    return this.sites.snapshotFor(subdomain);
  }
}
