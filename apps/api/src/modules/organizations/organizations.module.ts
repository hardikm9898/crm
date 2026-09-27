import { Module } from '@nestjs/common';
import { OrganizationProvisioningService } from './organization-provisioning.service.js';

/**
 * Only provisioning today, because that is what registration needs. The full
 * organization/branch/team/user surface arrives in Phase 1 step 5.
 */
@Module({
  providers: [OrganizationProvisioningService],
  exports: [OrganizationProvisioningService],
})
export class OrganizationsModule {}
