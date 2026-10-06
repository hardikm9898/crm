import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { CustomersService } from './customers.service.js';
import {
  createCustomerSchema,
  customerTimelineSchema,
  listCustomersSchema,
  updateCustomerSchema,
  type CreateCustomerInput,
  type CustomerTimelineQuery,
  type ListCustomersQuery,
  type UpdateCustomerInput,
} from './customers.dto.js';

/**
 * Customers.
 *
 * `customer:read` for the reads, `customer:manage` for the writes — two permissions rather than
 * four, because a business that lets somebody edit a customer does not separately decide whether
 * they may create one, and a role matrix with four rows nobody can distinguish is a role matrix
 * nobody configures correctly.
 *
 * Conversion lives on the **lead** (`POST /leads/:id/convert`): it is a lead transition that
 * happens to produce a customer, and a client holding a lead should not have to know a second
 * resource exists to finish the sale.
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  async list(@Query(new ZodBody(listCustomersSchema)) query: ListCustomersQuery) {
    return this.customers.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMER_MANAGE)
  async create(@Body(zodBody(createCustomerSchema)) body: unknown) {
    return withMessage(
      await this.customers.create(body as CreateCustomerInput),
      'Customer created',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  async findOne(@Param('id') id: string) {
    return this.customers.findOne(id);
  }

  /** The whole journey — the lead's history and the customer's, in one list (`FR-DEAL-4`). */
  @Get(':id/timeline')
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  async timeline(
    @Param('id') id: string,
    @Query(new ZodBody(customerTimelineSchema)) query: CustomerTimelineQuery,
  ) {
    return this.customers.journey(id, query);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateCustomerSchema)) body: unknown) {
    return withMessage(
      await this.customers.update(id, body as UpdateCustomerInput),
      'Customer updated',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(
      await this.customers.remove(id),
      'Customer deleted. Nothing about their history is gone — restore them from the recycle bin',
    );
  }

  @Post(':id/restore')
  @RequirePermission(PERMISSIONS.CUSTOMER_MANAGE)
  async restore(@Param('id') id: string) {
    return withMessage(await this.customers.restore(id), 'Customer restored');
  }
}
