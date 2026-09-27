import { Module } from '@nestjs/common';
import { OrganizationProvisioningService } from './organization-provisioning.service.js';

/**
 * Provisioning is a separate module from the organization *settings* surface on purpose.
 *
 * Signup (in `AuthModule`) needs provisioning; the settings surface needs `PrincipalService` from
 * `AuthModule` in order to invalidate cached grants when branches or teams change. Keeping both in
 * one module makes those two needs a dependency cycle, which Nest reports at boot as
 * "Cannot access 'AuthModule' before initialization".
 */
@Module({
  providers: [OrganizationProvisioningService],
  exports: [OrganizationProvisioningService],
})
export class OrganizationProvisioningModule {}
