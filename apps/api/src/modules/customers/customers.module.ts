import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/**
 * Customers and conversion.
 *
 * Imports the custom-field engine because every write validates `customValues` against the
 * tenant's `customer` definitions — the same engine the lead uses, against a different entity type,
 * which is the whole point of having built it as a registry rather than as lead columns.
 *
 * Deliberately does **not** import `LeadsModule`: conversion reads the lead and writes its status
 * history directly, inside the same transaction as the customer insert, and routing that through
 * `LeadsService.changeStatus` would mean two transactions and a window in which a customer exists
 * for a lead that is still open. `LeadsModule` imports *this* module instead, for the convert route.
 */
@Module({
  imports: [CustomFieldsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
