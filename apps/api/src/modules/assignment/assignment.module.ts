import { Module } from '@nestjs/common';
import { AssignmentController } from './assignment.controller.js';
import { AssignmentEngineService } from './assignment-engine.service.js';
import { AssignmentService } from './assignment.service.js';
import { EligibilityService } from './eligibility.service.js';

/**
 * The assignment engine. The engine and the eligibility check are exported because lead creation
 * runs them inside the transaction that inserts the lead — an assignment that happened a moment
 * later would leave a window where the lead belonged to nobody.
 */
@Module({
  controllers: [AssignmentController],
  providers: [AssignmentEngineService, AssignmentService, EligibilityService],
  exports: [AssignmentEngineService, EligibilityService, AssignmentService],
})
export class AssignmentModule {}
