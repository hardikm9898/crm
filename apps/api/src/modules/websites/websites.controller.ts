import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody } from '../../infra/http/zod-validation.pipe.js';
import { WebsitesService } from './websites.service.js';
import {
  createPageSchema,
  createWebsiteSchema,
  listWebsitesSchema,
  rollbackSchema,
  updatePageSchema,
  updateWebsiteSchema,
  type CreatePageInput,
  type CreateWebsiteInput,
  type ListWebsitesQuery,
  type RollbackInput,
  type UpdatePageInput,
  type UpdateWebsiteInput,
} from './websites.dto.js';

/**
 * Websites (`FR-WEB-1`, `FR-WEB-2`, `FR-WEB-5`).
 *
 * Two permissions rather than one, unlike automation: `website:read` exists because a website has
 * plenty worth reading without changing — what is live, what the draft says, which version is
 * serving — and `auditor` is a role whose whole purpose is that. Publishing is **not** split out
 * from `website:manage`: a role that may rewrite every word of a live page's draft but not press
 * the button protects nothing, because the next publish by anyone ships their text.
 *
 * Both keys are new in this step, so the migration beside it grants them to the `is_system` roles
 * of workspaces that already exist — adding a key to the catalogue reaches new workspaces and
 * nothing else, and `PrincipalService` then caches grants for five minutes.
 */
@Controller('websites')
export class WebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.WEBSITE_READ)
  async list(@Query(zodBody(listWebsitesSchema)) query: unknown) {
    return this.websites.list(query as ListWebsitesQuery);
  }

  @Post()
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async create(@Body(zodBody(createWebsiteSchema)) body: unknown) {
    return withMessage(
      await this.websites.create(body as CreateWebsiteInput),
      'Site created as a draft — publish it when it is ready',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.WEBSITE_READ)
  async findOne(@Param('id') id: string) {
    return this.websites.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateWebsiteSchema)) body: unknown) {
    return withMessage(
      await this.websites.update(id, body as UpdateWebsiteInput),
      'Saved. The live site is unchanged until you publish.',
    );
  }

  @Get(':id/pages')
  @RequirePermission(PERMISSIONS.WEBSITE_READ)
  async pages(@Param('id') id: string) {
    return this.websites.pages(id);
  }

  @Post(':id/pages')
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async createPage(@Param('id') id: string, @Body(zodBody(createPageSchema)) body: unknown) {
    return this.websites.createPage(id, body as CreatePageInput);
  }

  @Patch(':id/pages/:pageId')
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async updatePage(
    @Param('id') id: string,
    @Param('pageId') pageId: string,
    @Body(zodBody(updatePageSchema)) body: unknown,
  ) {
    return this.websites.updatePage(id, pageId, body as UpdatePageInput);
  }

  @Delete(':id/pages/:pageId')
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async deletePage(@Param('id') id: string, @Param('pageId') pageId: string) {
    return this.websites.deletePage(id, pageId);
  }

  @Get(':id/versions')
  @RequirePermission(PERMISSIONS.WEBSITE_READ)
  async versions(@Param('id') id: string) {
    return this.websites.versions(id);
  }

  /** What a visitor would be served. The published snapshot, never the draft. */
  @Get(':id/served')
  @RequirePermission(PERMISSIONS.WEBSITE_READ)
  async served(@Param('id') id: string) {
    return this.websites.servedSnapshot(id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async publish(@Param('id') id: string) {
    return withMessage(await this.websites.publish(id), 'Published and live');
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async unpublish(@Param('id') id: string) {
    return withMessage(
      await this.websites.unpublish(id),
      'Taken offline. Your pages are kept, and publishing again is one click.',
    );
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WEBSITE_MANAGE)
  async rollback(@Param('id') id: string, @Body(zodBody(rollbackSchema)) body: unknown) {
    const input = body as RollbackInput;
    return withMessage(
      await this.websites.rollback(id, input.versionId),
      'Rolled back. That version is live again as a new version.',
    );
  }
}
