import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DealsController, ProductsController } from './deals.controller.js';
import { DealsService } from './deals.service.js';
import { ProductsService } from './products.service.js';

/**
 * Deals, products and line items.
 *
 * Imports the custom-field engine for the `deal` entity type — the third entity to use the registry,
 * which is the point of having built it as one. Reads leads and customers directly rather than
 * through their modules: a deal needs a party's branch, team and owner to inherit ownership, and
 * importing both modules to read three columns would couple the money surface to the whole of the
 * lead surface.
 */
@Module({
  imports: [CustomFieldsModule],
  controllers: [DealsController, ProductsController],
  providers: [DealsService, ProductsService],
  exports: [DealsService],
})
export class DealsModule {}
