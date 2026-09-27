import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IamController } from './iam.controller.js';
import { IamService } from './iam.service.js';

/**
 * Roles, grants and assignment — the module that makes the RBAC design tenant-editable.
 */
@Module({
  imports: [AuthModule],
  controllers: [IamController],
  providers: [IamService],
  exports: [IamService],
})
export class IamModule {}
