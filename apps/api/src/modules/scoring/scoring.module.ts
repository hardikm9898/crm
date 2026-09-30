import { Module } from '@nestjs/common';
import { ScoringController } from './scoring.controller.js';
import { ScoringEngineService } from './scoring-engine.service.js';
import { ScoringService } from './scoring.service.js';
import { LeadScoreProcessor, ScoreDecaySweepProcessor } from './scoring.processor.js';

/**
 * Scoring. `ScoringEngineService` is exported because the leads module serves the score breakdown
 * and the recalculate action on `/leads/:id`, which is where a person looks for them.
 */
@Module({
  controllers: [ScoringController],
  providers: [ScoringService, ScoringEngineService, LeadScoreProcessor, ScoreDecaySweepProcessor],
  exports: [ScoringEngineService, LeadScoreProcessor, ScoreDecaySweepProcessor],
})
export class ScoringModule {}
