import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { CrmConfigController } from './crm-config.controller.js';
import { CrmConfigService } from './crm-config.service.js';

/**
 * The tenant's CRM vocabulary. Imports the custom-field engine because the configuration bundle a
 * client needs to render a form includes the field definitions.
 */
@Module({
  imports: [CustomFieldsModule],
  controllers: [CrmConfigController],
  providers: [CrmConfigService],
  exports: [CrmConfigService],
})
export class CrmConfigModule {}
