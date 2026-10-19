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
  'NotificationSetting',
  'Call',
  'CallOutcome',
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
  'Customer',
  'Product',
  'Deal',
  'DealItem',
  'NumberSeries',
  'Quotation',
  'QuotationItem',
  'PaymentMethod',
  'Payment',
  // Phase 3, step 1 — tasks and follow-ups
  'TaskType',
  'TaskOutcome',
  'RescheduleReason',
  'Task',
  'TaskReschedule',
  'TaskReminder',
  // Phase 3, step 2 — SLA
  'SlaPolicy',
  'SlaClock',
  'Escalation',
  // Phase 4, step 1 — capture forms
  'Form',
  'FormField',
  'FormSubmission',
  // Phase 4, step 2 — the public lead API. `InboundPayload` carries a NOT NULL
  // `organization_id` on purpose: a request whose key resolves to no workspace is refused before a
  // row is written, so there are no unattributed rows for the scoping extension to hide (ADR-0030).
  'ApiKey',
  'InboundPayload',
  'IngestionError',
  'IdempotencyKey',
  // Phase 4, step 3 — outbound webhooks. `WebhookAttempt` carries `organization_id` even though
  // its parent delivery already does: without it the row would be outside the registry, and the
  // scoping extension cannot narrow what it cannot see.
  'WebhookEndpoint',
  'WebhookDelivery',
  'WebhookAttempt',
  // Phase 4, step 4 — the key-authenticated REST surface. `ApiLog` is the integration's request
  // log, one row per request a key made, and it is tenant-scoped for the same reason
  // `inbound_payloads` is: a request whose key resolves to no workspace has no workspace to file it
  // under, so it is never written here at all rather than written with a null.
  'ApiLog',
  // Phase 4, step 6 — the integration framework. All three are tenant-scoped: a connection is a
  // workspace's credential, and a cursor or a health check belongs to the connection that made it.
  'IntegrationConnection',
  'SyncCursor',
  'IntegrationHealthCheck',
  // Phase 4, step 7 — the inbound idempotency ledger. Tenant-scoped: an event is a fact about one
  // workspace's advertising, and the unique that makes it a ledger is per workspace too.
  'ProviderEvent',
  // Phase 5, step 1 — WhatsApp. A WABA and its numbers belong to the workspace that connected
  // them; a conversation and its messages belong to the workspace whose number they arrived at.
  'WhatsAppAccount',
  'WhatsAppNumber',
  'Conversation',
  'Message',
  // Phase 5, step 2 — sending. A template is a workspace's own wording, and a status receipt is a
  // fact about one of its messages.
  'WhatsAppTemplate',
  'MessageStatusEvent',
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
  'IndustryTemplate',
  'User',
  'Session',
  'PasswordReset',
  'EmailVerification',
  'MfaRecoveryCode',
  'JobFailure',
  'SchedulerHeartbeat',
  /**
   * Phase 3, step 7 — email. Platform, deliberately: a verification or a reset is about a *user*,
   * who may belong to several workspaces or to none, and a suppression is a fact about a mailbox
   * rather than about one workspace's relationship with it. A nullable `organization_id` would
   * have put them half in the tenant registry, where the scoping extension hides exactly the rows
   * that have no workspace (ADR-0028).
   */
  'EmailMessage',
  'EmailSuppression',
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
