import { Injectable } from '@nestjs/common';
import {
  AppError,
  PERMISSIONS,
  isLeadSortField,
  newId,
  tenantContext,
  type FilterField,
  type ViewVisibility,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { FilterCompilerService } from './filter-compiler.service.js';
import type { CreateViewInput, ListViewsQuery, UpdateViewInput } from './views.dto.js';

/**
 * Saved views (`FR-VIEW-3`).
 *
 * A view is somebody's working list — "my overdue follow-ups", "Facebook leads worth over five
 * lakh" — so two things matter more than the CRUD:
 *
 *  * **A stored view is a validated view.** Filters are checked against the tenant's field
 *    catalogue before the row is written. The alternative is a view that fails when it is opened,
 *    which happens on a dashboard, at the moment somebody is trying to start work.
 *  * **Visibility is enforced on read, not on write.** A private view is invisible to everyone but
 *    its owner even if they know its id, because knowing an id is never authority (the same rule
 *    the leads module follows).
 */
@Injectable()
export class ViewsService {
  constructor(
    private readonly db: DbService,
    private readonly compiler: FilterCompilerService,
    private readonly audit: AuditService,
  ) {}

  /** The filterable fields for this tenant, so a filter builder has nothing hardcoded. */
  async fields(entityType = 'lead'): Promise<{
    items: readonly FilterField[];
    pagination: ReturnType<typeof fullPage>;
  }> {
    const catalogue = await this.compiler.catalogue(entityType);
    return { items: catalogue, pagination: fullPage(catalogue.length) };
  }

  /**
   * Every view this caller can see, ordered as a sidebar would show them.
   *
   * System views first (they are the ones a new workspace relies on), then the caller's own, then
   * what their teams and workspace share.
   */
  async list(query: ListViewsQuery) {
    const principal = tenantContext.require('views.list');
    const rows = await this.db.client.savedView.findMany({
      where: {
        entityType: query.entityType,
        deletedAt: null,
        OR: [
          { visibility: 'organization' },
          { visibility: 'private', ownerId: principal.actorId },
          ...(principal.teamIds.length > 0
            ? [{ visibility: 'team', teamId: { in: [...principal.teamIds] } }]
            : []),
        ],
      },
      orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });

    const items = rows.map((row) => this.present(row, principal.actorId ?? null));
    return { items, pagination: fullPage(items.length) };
  }

  async findOne(id: string) {
    const view = await this.requireVisible(id);
    return this.present(view, tenantContext.require('views.findOne').actorId ?? null);
  }

  async create(input: CreateViewInput) {
    const organizationId = tenantContext.organizationId('views.create');
    const principal = tenantContext.require('views.create');
    await this.assertUsable(input.filters, input.entityType, input.columns, input.sort?.field);
    const teamId = await this.resolveTeam(
      input.visibility,
      input.teamId ?? null,
      principal.teamIds,
    );
    if (input.defaultForRoleId) await this.assertRole(input.defaultForRoleId);

    const id = newId();
    await this.db.client.savedView.create({
      data: {
        id,
        organizationId,
        // A private view belongs to whoever made it; a shared one belongs to the workspace, so it
        // survives that person leaving.
        ownerId: input.visibility === 'private' ? principal.actorId : null,
        entityType: input.entityType,
        name: input.name,
        filters: input.filters as never,
        columns: (input.columns ?? []) as never,
        sort: (input.sort ?? {}) as never,
        visibility: input.visibility,
        teamId,
        defaultForRoleId: input.defaultForRoleId ?? null,
      },
    });
    await this.audit.record({
      action: 'saved_view.created',
      resourceType: 'saved_view',
      resourceId: id,
      after: { name: input.name, visibility: input.visibility },
    });
    return { id };
  }

  async update(id: string, input: UpdateViewInput) {
    const view = await this.requireVisible(id);
    this.assertCanEdit(view);

    const entityType = view.entityType;
    if (input.filters || input.columns || input.sort) {
      await this.assertUsable(
        input.filters ?? (view.filters as { conditions: unknown[] }),
        entityType,
        input.columns,
        input.sort?.field,
      );
    }
    const principal = tenantContext.require('views.update');
    const visibility = (input.visibility ?? view.visibility) as ViewVisibility;
    const teamId =
      input.visibility !== undefined || input.teamId !== undefined
        ? await this.resolveTeam(visibility, input.teamId ?? view.teamId, principal.teamIds)
        : view.teamId;
    if (input.defaultForRoleId) await this.assertRole(input.defaultForRoleId);

    await this.db.client.savedView.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.filters !== undefined ? { filters: input.filters as never } : {}),
        ...(input.columns !== undefined ? { columns: input.columns as never } : {}),
        ...(input.sort !== undefined ? { sort: input.sort as never } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.visibility !== undefined || input.teamId !== undefined ? { teamId } : {}),
        ...(input.defaultForRoleId !== undefined
          ? { defaultForRoleId: input.defaultForRoleId }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        // Becoming shared hands ownership to the workspace; becoming private takes it back.
        ...(input.visibility === 'private' && view.ownerId === null
          ? { ownerId: principal.actorId }
          : {}),
        ...(input.visibility !== undefined && input.visibility !== 'private'
          ? { ownerId: null }
          : {}),
      },
    });
    await this.audit.record({
      action: 'saved_view.updated',
      resourceType: 'saved_view',
      resourceId: id,
      before: { name: view.name, visibility: view.visibility },
      after: input as Record<string, unknown>,
    });
    return { id };
  }

  async remove(id: string) {
    const view = await this.requireVisible(id);
    this.assertCanEdit(view);
    await this.db.client.savedView.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      action: 'saved_view.deleted',
      resourceType: 'saved_view',
      resourceId: id,
      before: { name: view.name, isSystem: view.isSystem },
    });
    return { id };
  }

  /**
   * The view behind a search, with its visibility checked.
   *
   * Returns the raw row because the caller needs the filter and sort, not the presentation.
   */
  async forSearch(id: string) {
    const view = await this.requireVisible(id);
    return view;
  }

  /** The view a role lands on, when their workspace configured one. */
  async defaultFor(roleIds: readonly string[], entityType = 'lead') {
    if (roleIds.length === 0) return null;
    const view = await this.db.client.savedView.findFirst({
      where: {
        entityType,
        deletedAt: null,
        defaultForRoleId: { in: [...roleIds] },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return view ? this.present(view, tenantContext.get()?.actorId ?? null) : null;
  }

  private async requireVisible(id: string) {
    const principal = tenantContext.require('views.visibility');
    const view = await this.db.client.savedView.findFirst({ where: { id, deletedAt: null } });
    // 404 rather than 403: confirming a private view exists is itself a leak of somebody's work.
    if (!view) throw AppError.notFound('View');
    const visible =
      view.visibility === 'organization' ||
      (view.visibility === 'private' && view.ownerId === principal.actorId) ||
      (view.visibility === 'team' &&
        view.teamId !== null &&
        principal.teamIds.includes(view.teamId));
    if (!visible) throw AppError.notFound('View');
    return view;
  }

  /**
   * Who may change a view.
   *
   * A system view is editable — a business that wants "Hot leads" to mean something else should be
   * able to say so (rule 4) — but a private view is nobody else's to touch, and a shared one needs
   * `settings:manage` rather than merely `lead:read`, because changing it changes everyone's list.
   */
  private assertCanEdit(view: { ownerId: string | null; visibility: string }): void {
    const principal = tenantContext.require('views.edit');
    if (view.visibility === 'private') {
      if (view.ownerId !== principal.actorId) throw AppError.notFound('View');
      return;
    }
    // A shared view is everyone's list, so changing it is a configuration act. `permissionDenied`
    // rather than a 404: the view is visible to them, only not theirs to change.
    if (!principal.permissions.has(PERMISSIONS.SETTINGS_MANAGE)) {
      throw AppError.permissionDenied(PERMISSIONS.SETTINGS_MANAGE);
    }
  }

  private async assertUsable(
    filters: unknown,
    entityType: string,
    columns: readonly string[] | undefined,
    sortField: string | undefined,
  ): Promise<void> {
    // Compiling is the validation: if it compiles against this tenant's catalogue, it will run.
    await this.compiler.compile({ filter: filters, entityType });

    if (sortField && !isLeadSortField(sortField)) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'sort.field',
          code: 'NOT_SORTABLE',
          message: `Sorting by “${sortField}” is not supported — it has no index, and a list that cannot be paged is not a list.`,
        },
      ]);
    }

    if (columns && columns.length > 0) {
      const catalogue = await this.compiler.catalogue(entityType);
      const known = new Set([...catalogue.map((field) => field.field), 'id', 'tags']);
      const unknown = columns.filter((column) => !known.has(column));
      if (unknown.length > 0) {
        throw AppError.validation('Some details need correcting', [
          {
            field: 'columns',
            code: 'UNKNOWN_COLUMN',
            message: `Not a column that can be shown: ${unknown.join(', ')}.`,
          },
        ]);
      }
    }
  }

  /** A team view needs a team, and it must be one the caller is actually on. */
  private async resolveTeam(
    visibility: ViewVisibility,
    teamId: string | null,
    callerTeamIds: readonly string[],
  ): Promise<string | null> {
    if (visibility !== 'team') return null;
    const chosen = teamId ?? callerTeamIds[0] ?? null;
    if (!chosen) {
      throw AppError.validation('Some details need correcting', [
        {
          field: 'teamId',
          code: 'REQUIRED',
          message: 'Sharing with a team needs a team. You are not on one, so choose one.',
        },
      ]);
    }
    const team = await this.db.client.team.findFirst({
      where: { id: chosen, deletedAt: null },
      select: { id: true },
    });
    if (!team) throw AppError.notFound('Team');
    return team.id;
  }

  private async assertRole(roleId: string): Promise<void> {
    const role = await this.db.client.role.findFirst({
      where: { id: roleId, deletedAt: null },
      select: { id: true },
    });
    if (!role) throw AppError.notFound('Role');
  }

  private present(
    view: {
      id: string;
      name: string;
      entityType: string;
      filters: unknown;
      columns: unknown;
      sort: unknown;
      visibility: string;
      ownerId: string | null;
      teamId: string | null;
      defaultForRoleId: string | null;
      isSystem: boolean;
      sortOrder: number;
      updatedAt: Date;
    },
    callerId: string | null,
  ) {
    return {
      id: view.id,
      name: view.name,
      entityType: view.entityType,
      filters: view.filters,
      columns: view.columns,
      sort: view.sort,
      visibility: view.visibility,
      teamId: view.teamId,
      defaultForRoleId: view.defaultForRoleId,
      isSystem: view.isSystem,
      sortOrder: view.sortOrder,
      updatedAt: view.updatedAt,
      /** So a sidebar can show "yours" without a second call. */
      isMine: view.ownerId !== null && view.ownerId === callerId,
    };
  }
}
