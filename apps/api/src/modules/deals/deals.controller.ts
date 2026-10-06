import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { DealsService } from './deals.service.js';
import { ProductsService } from './products.service.js';
import {
  createDealSchema,
  createProductSchema,
  dealBoardSchema,
  dealTimelineSchema,
  listDealsSchema,
  listProductsSchema,
  loseDealSchema,
  moveDealSchema,
  setDealItemsSchema,
  updateDealSchema,
  updateProductSchema,
  winDealSchema,
  type CreateDealInput,
  type CreateProductInput,
  type DealBoardQuery,
  type DealTimelineQuery,
  type ListDealsQuery,
  type ListProductsQuery,
  type LoseDealInput,
  type MoveDealInput,
  type SetDealItemsInput,
  type UpdateDealInput,
  type UpdateProductInput,
  type WinDealInput,
} from './deals.dto.js';

/**
 * Deals (`FR-DEAL-1`).
 *
 * `deal:read` for the reads, `deal:manage` for the writes. Winning and losing are their own
 * endpoints rather than fields on the update, for the same reason a lead's status is: each has its
 * own preconditions, its own timeline entry on two subjects, and its own event — and a general PATCH
 * that happened to include `wonAt` could check none of them.
 */
@Controller('deals')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async list(@Query(new ZodBody(listDealsSchema)) query: ListDealsQuery) {
    return this.deals.list(query);
  }

  /** The board, one page per column, with each column's value and weighted value. */
  @Get('board')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async board(@Query(new ZodBody(dealBoardSchema)) query: DealBoardQuery) {
    return this.deals.board(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async create(@Body(zodBody(createDealSchema)) body: unknown) {
    return withMessage(await this.deals.create(body as CreateDealInput), 'Deal created');
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async findOne(@Param('id') id: string) {
    return this.deals.findOne(id);
  }

  @Get(':id/timeline')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async timeline(
    @Param('id') id: string,
    @Query(new ZodBody(dealTimelineSchema)) query: DealTimelineQuery,
  ) {
    return this.deals.journey(id, query);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateDealSchema)) body: unknown) {
    return withMessage(await this.deals.update(id, body as UpdateDealInput), 'Deal updated');
  }

  /** `PUT`: a line-items editor submits the table it has, not a sequence of adds and removes. */
  @Put(':id/items')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async setItems(@Param('id') id: string, @Body(zodBody(setDealItemsSchema)) body: unknown) {
    return withMessage(
      await this.deals.setItems(id, body as SetDealItemsInput),
      'Line items saved. The deal’s value is their total',
    );
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async move(@Param('id') id: string, @Body(zodBody(moveDealSchema)) body: unknown) {
    return withMessage(await this.deals.move(id, body as MoveDealInput), 'Deal moved');
  }

  @Post(':id/win')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async win(@Param('id') id: string, @Body(zodBody(winDealSchema)) body: unknown) {
    return withMessage(await this.deals.win(id, body as WinDealInput), 'Marked won');
  }

  @Post(':id/lose')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async lose(@Param('id') id: string, @Body(zodBody(loseDealSchema)) body: unknown) {
    return withMessage(await this.deals.lose(id, body as LoseDealInput), 'Marked lost');
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async reopen(@Param('id') id: string) {
    return withMessage(
      await this.deals.reopen(id),
      'Reopened. The won or lost entry stays on the timeline — it happened',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(
      await this.deals.remove(id),
      'Deal deleted. Restore it from the recycle bin',
    );
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async restore(@Param('id') id: string) {
    return withMessage(await this.deals.restore(id), 'Deal restored');
  }
}

/**
 * The product catalogue.
 *
 * Reading is `deal:read` — a sales executive writing a quotation has to be able to pick a product.
 * Writing is **`settings:manage`**: a price list is a workspace decision, and somebody quoting from
 * it should not be able to change it.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async list(@Query(new ZodBody(listProductsSchema)) query: ListProductsQuery) {
    return this.products.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async create(@Body(zodBody(createProductSchema)) body: unknown) {
    return withMessage(await this.products.create(body as CreateProductInput), 'Product created');
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateProductSchema)) body: unknown) {
    return withMessage(
      await this.products.update(id, body as UpdateProductInput),
      'Product updated. Deals already quoted keep the price they were quoted at',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.products.remove(id), 'Product deleted');
  }
}
