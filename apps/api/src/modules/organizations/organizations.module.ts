import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { OrganizationProvisioningService } from './organization-provisioning.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { IndustryTemplatesService } from './industry-templates.service.js';

/**
 * The organization's own settings, branches and teams, the provisioning used at signup, and the
 * industry templates onboarding installs.
 *
 * Imports `CustomFieldsModule` for one thing: applying a template rewrites the field registry, and
 * the registry is cached — so the cache has to be dropped in the same breath, or the lead form keeps
 * offering the previous industry's questions for five minutes.
 */
@Module({
  imports: [AuthModule, CustomFieldsModule],
  controllers: [OrganizationsController],
  providers: [OrganizationProvisioningService, OrganizationsService, IndustryTemplatesService],
  exports: [OrganizationProvisioningService, OrganizationsService],
})
export class OrganizationsModule {}
