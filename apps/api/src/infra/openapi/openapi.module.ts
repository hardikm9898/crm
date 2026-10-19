import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module.js';
import { OpenApiController } from './openapi.controller.js';
import { OpenApiService } from './openapi.service.js';

/**
 * The published API contract and its documentation (`FR-API-3`).
 *
 * Imports `AuthzModule` for `RouteAuditService`: the document is built from the same enumeration
 * of the routing table that fails startup when a route declares no authorization, so "every route
 * is documented" and "every route is authorized" are one fact rather than two.
 */
@Module({
  imports: [AuthzModule],
  controllers: [OpenApiController],
  providers: [OpenApiService],
  exports: [OpenApiService],
})
export class OpenApiModule {}
