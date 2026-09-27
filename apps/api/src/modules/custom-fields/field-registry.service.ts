import { Injectable } from '@nestjs/common';
import {
  tenantContext,
  type CustomFieldDefinitionLike,
  type CustomFieldEntity,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { RedisService } from '../../infra/redis/redis.service.js';

/**
 * The definitions, cached.
 *
 * Every lead write validates against them, so this is on the hottest path in the product. It is also
 * configuration that changes rarely — a good cache — and one that must **not** go stale, because a
 * field created thirty seconds ago being rejected as unknown is exactly the failure the Phase 2 exit
 * criterion forbids. Hence a short TTL *and* explicit invalidation on every write, the same belt and
 * braces `PrincipalService` uses for grants.
 *
 * The cache key is organization-scoped through `RedisService.key()`, so a cached definition set can
 * never be served to another tenant.
 */
const CACHE_TTL_SECONDS = 300;

export interface FieldDefinition extends CustomFieldDefinitionLike {
  readonly id: string;
  readonly entityType: string;
  readonly placeholder: string | null;
  readonly helpText: string | null;
  readonly defaultValue: unknown;
  readonly sectionId: string | null;
  readonly sortOrder: number;
  readonly showInList: boolean;
  readonly isSearchable: boolean;
  readonly isFilterable: boolean;
  readonly isIndexed: boolean;
  readonly isPii: boolean;
  readonly options: readonly {
    readonly id: string;
    readonly value: string;
    readonly label: string;
    readonly colour: string | null;
    readonly sortOrder: number;
    readonly isActive: boolean;
  }[];
}

@Injectable()
export class FieldRegistryService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Active definitions for one entity type, in display order.
   *
   * Inactive definitions are excluded: a deactivated field must stop accepting new values while its
   * existing values remain readable, which is what makes deactivation safe to do.
   */
  async definitionsFor(entityType: CustomFieldEntity): Promise<readonly FieldDefinition[]> {
    const organizationId = tenantContext.organizationId('customFields.definitions');
    const key = this.cacheKey(organizationId, entityType);

    const cached = await this.redis.getJson<FieldDefinition[]>(key);
    if (cached) return cached;

    const rows = await this.db.client.customFieldDefinition.findMany({
      where: { entityType, isActive: true, deletedAt: null },
      include: { options: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] } },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });

    const definitions: FieldDefinition[] = rows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      key: row.key,
      label: row.label,
      type: row.type,
      placeholder: row.placeholder,
      helpText: row.helpText,
      isRequired: row.isRequired,
      defaultValue: row.defaultValue,
      validation: (row.validation ?? {}) as Record<string, unknown>,
      sectionId: row.sectionId,
      sortOrder: row.sortOrder,
      showInList: row.showInList,
      isSearchable: row.isSearchable,
      isFilterable: row.isFilterable,
      isIndexed: row.isIndexed,
      isPii: row.isPii,
      isActive: row.isActive,
      options: row.options.map((option) => ({
        id: option.id,
        value: option.value,
        label: option.label,
        colour: option.colour,
        sortOrder: option.sortOrder,
        isActive: option.isActive,
      })),
    }));

    await this.redis.setJson(key, definitions, CACHE_TTL_SECONDS);
    return definitions;
  }

  /** Called by every write in the field builder. Missing this is a five-minute lie. */
  async invalidate(entityType?: CustomFieldEntity): Promise<void> {
    const organizationId = tenantContext.organizationId('customFields.invalidate');
    const entities: CustomFieldEntity[] = entityType
      ? [entityType]
      : ['lead', 'customer', 'deal', 'task', 'conversation'];
    await Promise.all(
      entities.map(async (entity) => this.redis.del(this.cacheKey(organizationId, entity))),
    );
  }

  /** Invalidates for an organization other than the ambient one — used by provisioning. */
  async invalidateForOrganization(organizationId: string): Promise<void> {
    const entities: CustomFieldEntity[] = ['lead', 'customer', 'deal', 'task', 'conversation'];
    await Promise.all(
      entities.map(async (entity) => this.redis.del(this.cacheKey(organizationId, entity))),
    );
  }

  private cacheKey(organizationId: string, entityType: string): string {
    return this.redis.key(organizationId, 'custom-fields', entityType, 'v1');
  }
}
