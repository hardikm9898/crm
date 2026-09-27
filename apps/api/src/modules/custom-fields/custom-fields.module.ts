import { Module } from '@nestjs/common';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { FieldRegistryService } from './field-registry.service.js';

/**
 * The custom-field engine. `FieldRegistryService` is exported because every entity that carries
 * custom values validates against it — leads today, customers and deals next.
 */
@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService, FieldRegistryService],
  exports: [FieldRegistryService, CustomFieldsService],
})
export class CustomFieldsModule {}
