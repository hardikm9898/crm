/**
 * The tenant-model registry: the single list that decides which models the
 * scoping extension guards (docs/security.md §3, layer 2).
 *
 * Adding a tenant-scoped model to the schema without adding it here would leave it
 * unguarded, so `assertTenantRegistryComplete()` cross-checks the registry against
 * the generated Prisma metadata and the integration suite fails the build if a
 * model carrying `organizationId` is missing. The list cannot silently drift.
 */

/** Models whose every row belongs to exactly one organization. */
export const TENANT_MODELS = [
  'Organization',
  'Branch',
  'Team',
  'TeamMember',
  'Membership',
  'Role',
  'RolePermission',
  'UserRole',
  'Invitation',
  'WorkingHours',
  'Holiday',
  'UserAvailability',
  'Subscription',
  'EntitlementOverride',
  'UsageCounter',
  'AuditLog',
  'OutboxEvent',
  'Notification',
  'NotificationPreference',
  // Phase 2 — CRM core
  'CustomFieldSection',
  'CustomFieldDefinition',
  'CustomFieldOption',
  'LeadStatus',
  'LeadSource',
  'LostReason',
  'Tag',
  'LeadTag',
  'Pipeline',
  'PipelineStage',
  'Lead',
  'LeadTouchpoint',
  'LeadAssignment',
  'LeadStatusHistory',
  'LeadStageHistory',
  'Activity',
  // Phase 2, step 2 — duplicates and assignment
  'DuplicateRule',
  'LeadDuplicate',
  'LeadMerge',
  'AssignmentRule',
  'AssignmentRuleCondition',
  'AssignmentPoolMember',
  'RoundRobinState',
  // Phase 2, step 3 — scoring and saved views
  'ScoringRule',
  'ScoreBand',
  'LeadScoreEvent',
  'SavedView',
  // Phase 2, step 5 — files, import and export
  'Document',
  'ImportJob',
  'ImportRow',
  'ExportJob',
] as const;

export type TenantModel = (typeof TENANT_MODELS)[number];

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS);

/**
 * Platform models, deliberately unscoped. Every entry here is a decision:
 * these tables hold no tenant rows, so tenant routes must never read them
 * directly (`Permission` and `Feature` are catalogues; `User`/`Session` are the
 * global identity layer whose tenant-facing projection is `Membership`).
 */
export const PLATFORM_MODELS = [
  'Plan',
  'Feature',
  'PlanFeature',
  'PlatformSetting',
  'PlatformUser',
  'Permission',
  'User',
  'Session',
  'PasswordReset',
  'EmailVerification',
  'MfaRecoveryCode',
  'JobFailure',
  'SchedulerHeartbeat',
] as const;

export function isTenantModel(model: string | undefined): model is TenantModel {
  return model !== undefined && TENANT_MODEL_SET.has(model);
}

/**
 * `Organization` is scoped by its own primary key rather than an
 * `organizationId` column — the filter differs, the guarantee does not.
 */
export function tenantColumnFor(model: TenantModel): 'id' | 'organizationId' {
  return model === 'Organization' ? 'id' : 'organizationId';
}
