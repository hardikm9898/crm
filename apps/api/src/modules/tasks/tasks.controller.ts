import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { TasksService } from './tasks.service.js';
import { TaskConfigService } from './task-config.service.js';
import {
  cancelTaskSchema,
  completeTaskSchema,
  createRescheduleReasonSchema,
  createTaskOutcomeSchema,
  createTaskSchema,
  createTaskTypeSchema,
  listTasksSchema,
  rescheduleTaskSchema,
  taskSummarySchema,
  updateRescheduleReasonSchema,
  updateTaskOutcomeSchema,
  updateTaskSchema,
  updateTaskTypeSchema,
  type CancelTaskInput,
  type CompleteTaskInput,
  type CreateRescheduleReasonInput,
  type CreateTaskOutcomeInput,
  type CreateTaskTypeInput,
  type ListTasksQuery,
  type RescheduleTaskInput,
  type TaskSummaryQuery,
  type UpdateRescheduleReasonInput,
  type UpdateTaskOutcomeInput,
  type UpdateTaskInput,
  type UpdateTaskTypeInput,
} from './tasks.dto.js';

/**
 * Tasks and follow-ups (`FR-TSK-1..7`).
 *
 * Complete, reschedule and cancel are their own endpoints rather than a `status` on the PATCH,
 * exactly as payments does it: each has its own preconditions (an outcome, a reason, a note the
 * reason demands), its own timeline entry on up to three subjects, its own event, and its own
 * effect on the lead's next action — and a PATCH that happened to carry `status` could check none
 * of them. `PATCH` is for correcting a title somebody mistyped.
 *
 * `GET /tasks/config` is readable with `task:read` rather than `settings:manage`: the task form
 * needs the types, the outcomes and the reasons to render its dropdowns, and a sales executive has
 * no business holding a settings permission to create a follow-up.
 */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly config: TaskConfigService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TASK_READ)
  async list(@Query(new ZodBody(listTasksSchema)) query: ListTasksQuery) {
    return this.tasks.list(query);
  }

  /** The Today counters (`FR-TSK-7`), aggregated over the whole filter rather than the page. */
  @Get('summary')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async summary(@Query(new ZodBody(taskSummarySchema)) query: TaskSummaryQuery) {
    return this.tasks.summary(query);
  }

  /** Everything the task form needs: types, outcomes and reschedule reasons in one request. */
  @Get('config')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async configBundle() {
    return this.config.bundle();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async create(@Body(zodBody(createTaskSchema)) body: unknown) {
    const task = await this.tasks.create(body as never);
    return withMessage(task, 'Follow-up scheduled');
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async findOne(@Param('id') id: string) {
    return this.tasks.findOne(id);
  }

  @Get(':id/reschedules')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async reschedules(@Param('id') id: string) {
    return this.tasks.reschedules(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateTaskSchema)) body: unknown) {
    return withMessage(await this.tasks.update(id, body as UpdateTaskInput), 'Task saved');
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async complete(@Param('id') id: string, @Body(zodBody(completeTaskSchema)) body: unknown) {
    const task = await this.tasks.complete(id, body as CompleteTaskInput);
    return withMessage(task, 'Task completed');
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async reschedule(@Param('id') id: string, @Body(zodBody(rescheduleTaskSchema)) body: unknown) {
    return withMessage(
      await this.tasks.reschedule(id, body as RescheduleTaskInput),
      'Follow-up moved',
    );
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async cancel(@Param('id') id: string, @Body(zodBody(cancelTaskSchema)) body: unknown) {
    return withMessage(await this.tasks.cancel(id, body as CancelTaskInput), 'Task cancelled');
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.tasks.remove(id), 'Task deleted');
  }
}

/**
 * The tenant's follow-up vocabulary (rule 4).
 *
 * Readable with `task:read` so the form can offer the dropdowns; writable with `settings:manage`
 * like every other piece of workspace configuration.
 */
@Controller('settings')
export class TaskConfigController {
  constructor(private readonly config: TaskConfigService) {}

  @Get('task-types')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async listTypes(@Query('includeInactive') includeInactive?: string) {
    return this.config.listTypes(includeInactive === 'true');
  }

  @Post('task-types')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createType(@Body(zodBody(createTaskTypeSchema)) body: unknown) {
    return withMessage(
      await this.config.createType(body as CreateTaskTypeInput),
      'Task type added',
    );
  }

  @Patch('task-types/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateType(@Param('id') id: string, @Body(zodBody(updateTaskTypeSchema)) body: unknown) {
    return withMessage(
      await this.config.updateType(id, body as UpdateTaskTypeInput),
      'Task type saved',
    );
  }

  @Delete('task-types/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async removeType(@Param('id') id: string) {
    return withMessage(await this.config.deleteType(id), 'Task type removed');
  }

  @Get('task-outcomes')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async listOutcomes(@Query('includeInactive') includeInactive?: string) {
    return this.config.listOutcomes(includeInactive === 'true');
  }

  @Post('task-outcomes')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createOutcome(@Body(zodBody(createTaskOutcomeSchema)) body: unknown) {
    return withMessage(
      await this.config.createOutcome(body as CreateTaskOutcomeInput),
      'Outcome added',
    );
  }

  @Patch('task-outcomes/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateOutcome(
    @Param('id') id: string,
    @Body(zodBody(updateTaskOutcomeSchema)) body: unknown,
  ) {
    return withMessage(
      await this.config.updateOutcome(id, body as UpdateTaskOutcomeInput),
      'Outcome saved',
    );
  }

  @Delete('task-outcomes/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async removeOutcome(@Param('id') id: string) {
    return withMessage(await this.config.deleteOutcome(id), 'Outcome removed');
  }

  @Get('reschedule-reasons')
  @RequirePermission(PERMISSIONS.TASK_READ)
  async listReasons(@Query('includeInactive') includeInactive?: string) {
    return this.config.listReasons(includeInactive === 'true');
  }

  @Post('reschedule-reasons')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createReason(@Body(zodBody(createRescheduleReasonSchema)) body: unknown) {
    return withMessage(
      await this.config.createReason(body as CreateRescheduleReasonInput),
      'Reason added',
    );
  }

  @Patch('reschedule-reasons/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateReason(
    @Param('id') id: string,
    @Body(zodBody(updateRescheduleReasonSchema)) body: unknown,
  ) {
    return withMessage(
      await this.config.updateReason(id, body as UpdateRescheduleReasonInput),
      'Reason saved',
    );
  }

  @Delete('reschedule-reasons/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async removeReason(@Param('id') id: string) {
    return withMessage(await this.config.deleteReason(id), 'Reason removed');
  }
}
