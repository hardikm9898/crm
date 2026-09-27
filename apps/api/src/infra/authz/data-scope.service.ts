import { Injectable } from '@nestjs/common';
import { AppError, tenantContext, type DataScope } from '@leados/shared';

/**
 * Turns a permission's data scope into a query predicate (FR-IAM-4, docs/security.md §4).
 *
 * The point of doing this in one place is that "a manager sees their branch" becomes a SQL
 * predicate rather than an `if` in a controller. Scope resolution that lives in handlers
 * gets forgotten in exactly the places it matters.
 *
 * The returned filter is deliberately *structural* rather than Prisma-specific: it names the
 * owning user, team and branch columns for an entity, and the repository composes it. That
 * keeps this service usable by leads, tasks, conversations and deals in Phase 2+ without a
 * rewrite each time.
 */

export interface ScopeColumns {
  /** Column holding the owning user, e.g. `assignedUserId`. */
  readonly userColumn?: string;
  readonly teamColumn?: string;
  readonly branchColumn?: string;
}

export type ScopeFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'where'; readonly where: Record<string, unknown> };

@Injectable()
export class DataScopeService {
  /**
   * @param permission The permission whose grant decides the breadth.
   * @param columns    Which columns express ownership for this entity.
   */
  filterFor(permission: string, columns: ScopeColumns): ScopeFilter {
    const principal = tenantContext.require(`dataScope:${permission}`);
    if (!principal.permissions.has(permission)) throw AppError.permissionDenied(permission);

    const scope = principal.scopes.get(permission) ?? 'own';
    const userId = principal.actorId;

    switch (scope) {
      case 'organization':
        // Tenant scoping is still applied by the data layer; this only widens within a tenant.
        return { kind: 'all' };

      case 'branch': {
        if (!columns.branchColumn) return { kind: 'all' };
        if (principal.branchIds.length === 0) {
          // Branch-scoped but assigned to no branch: narrow to own rather than widen to all.
          return this.ownFilter(columns, userId);
        }
        return {
          kind: 'where',
          where: { [columns.branchColumn]: { in: [...principal.branchIds] } },
        };
      }

      case 'team': {
        if (!columns.teamColumn) return this.ownFilter(columns, userId);
        if (principal.teamIds.length === 0) return this.ownFilter(columns, userId);
        const clauses: Record<string, unknown>[] = [
          { [columns.teamColumn]: { in: [...principal.teamIds] } },
        ];
        // Rows they own personally but which carry no team must stay visible.
        if (columns.userColumn && userId) clauses.push({ [columns.userColumn]: userId });
        return { kind: 'where', where: { OR: clauses } };
      }

      case 'own':
      default:
        return this.ownFilter(columns, userId);
    }
  }

  /**
   * Whether the caller may act on one specific row. Used for single-resource routes, where a
   * list predicate is not enough: knowing an id must never be sufficient authority.
   */
  canAct(
    permission: string,
    row: { userId?: string | null; teamId?: string | null; branchId?: string | null },
  ): boolean {
    const principal = tenantContext.require(`dataScope:${permission}`);
    if (!principal.permissions.has(permission)) return false;

    switch (principal.scopes.get(permission) ?? 'own') {
      case 'organization':
        return true;
      case 'branch':
        return row.branchId !== null && row.branchId !== undefined
          ? principal.branchIds.includes(row.branchId)
          : row.userId === principal.actorId;
      case 'team':
        if (row.teamId && principal.teamIds.includes(row.teamId)) return true;
        return row.userId === principal.actorId;
      case 'own':
      default:
        return row.userId === principal.actorId;
    }
  }

  scopeOf(permission: string): DataScope {
    const principal = tenantContext.require(`dataScope:${permission}`);
    return principal.scopes.get(permission) ?? 'own';
  }

  private ownFilter(columns: ScopeColumns, userId: string | undefined): ScopeFilter {
    if (!columns.userColumn || !userId) {
      // Nothing expresses ownership for this entity, so "own" can match nothing. Returning
      // an empty result is the safe reading; returning everything would be a silent widening.
      return { kind: 'none' };
    }
    return { kind: 'where', where: { [columns.userColumn]: userId } };
  }
}

/** Merges a scope filter into a Prisma `where`, or signals that nothing can match. */
export function applyScopeFilter<T extends Record<string, unknown>>(
  where: T,
  filter: ScopeFilter,
): T | null {
  if (filter.kind === 'all') return where;
  if (filter.kind === 'none') return null;
  return { ...where, ...filter.where };
}
