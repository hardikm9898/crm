import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrganizationProvisioningService } from './organization-provisioning.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

/**
 * The organization's own settings, branches and teams, plus the provisioning used at signup.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationProvisioningService, OrganizationsService],
  exports: [OrganizationProvisioningService, OrganizationsService],
})
export class OrganizationsModule {}
