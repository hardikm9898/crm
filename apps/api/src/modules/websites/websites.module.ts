import { Module } from '@nestjs/common';
import { WebsitesController } from './websites.controller.js';
import { WebsitesService } from './websites.service.js';

/**
 * Phase 7 step 1. Nothing else was in this directory before this file, which is worth stating:
 * writing a module file over an existing one removed `POST /webhooks/email` from the app once, with
 * no error and no failing unit test — a module file is a registry, and overwriting a registry loses
 * whatever it registered.
 */
@Module({
  controllers: [WebsitesController],
  providers: [WebsitesService],
  exports: [WebsitesService],
})
export class WebsitesModule {}
