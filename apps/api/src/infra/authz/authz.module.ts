import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DataScopeService } from './data-scope.service.js';
import { PermissionGuard } from './permission.guard.js';
import { RouteAuditService } from './route-audit.service.js';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [DataScopeService, PermissionGuard, RouteAuditService],
  exports: [DataScopeService, PermissionGuard, RouteAuditService],
})
export class AuthzModule {}
