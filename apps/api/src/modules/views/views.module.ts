import { Module } from '@nestjs/common';
import { FilterCompilerService } from './filter-compiler.service.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

/**
 * Saved views and the filter compiler.
 *
 * Both are exported because lead search runs them: `POST /leads/search` compiles an ad-hoc filter
 * or loads a view and compiles that, through the same code path — two paths would drift, and the
 * one that drifted would be the saved view, which is the one a business relies on daily.
 */
@Module({
  controllers: [ViewsController],
  providers: [ViewsService, FilterCompilerService],
  exports: [ViewsService, FilterCompilerService],
})
export class ViewsModule {}
