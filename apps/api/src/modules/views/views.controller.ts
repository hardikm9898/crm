import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { ViewsService } from './views.service.js';
import {
  createViewSchema,
  listViewsSchema,
  updateViewSchema,
  type ListViewsQuery,
} from './views.dto.js';

/**
 * Saved views.
 *
 * All of it is `lead:read`, including creating one: a view is a saved question about leads, and
 * anybody who can see leads can save the way they look at them. The one thing that needs more is
 * changing a view **other people use**, which `ViewsService` checks against `settings:manage` —
 * that check depends on the row, so it cannot be a decorator.
 */
@Controller('views')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  /** Everything filterable, with the operators each field supports. */
  @Get('fields')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async fields(@Query(new ZodBody(listViewsSchema)) query: ListViewsQuery) {
    return this.views.fields(query.entityType);
  }

  @Get()
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async list(@Query(new ZodBody(listViewsSchema)) query: ListViewsQuery) {
    return this.views.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async findOne(@Param('id') id: string) {
    return this.views.findOne(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async create(@Body(zodBody(createViewSchema)) body: unknown) {
    return withMessage(
      await this.views.create(body as Parameters<ViewsService['create']>[0]),
      'View saved',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async update(@Param('id') id: string, @Body(zodBody(updateViewSchema)) body: unknown) {
    return withMessage(
      await this.views.update(id, body as Parameters<ViewsService['update']>[1]),
      'View updated',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async remove(@Param('id') id: string) {
    return withMessage(await this.views.remove(id), 'View deleted');
  }
}
