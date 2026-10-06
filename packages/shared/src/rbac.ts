import type { DataScope } from './tenant-context.js';

/**
 * The permission catalogue and the system role templates.
 *
 * Code checks PERMISSIONS, never role names (FR-IAM-3). Roles are per-organization
 * rows seeded from these templates and freely editable afterwards, so a tenant can
 * rename "Sales Executive" or invent "Telecaller" without any code change.
 *
 * Lives in shared because two very different consumers need the same source of
 * truth: the seeder that writes the catalogue, and the API guards that enforce it.
 */

export const PERMISSIONS = {
  // organization & people
  ORGANIZATION_READ: 'organization:read',
  ORGANIZATION_MANAGE: 'organization:manage',
  BRANCH_MANAGE: 'branch:manage',
  TEAM_MANAGE: 'team:manage',
  USER_READ: 'user:read',
  USER_MANAGE: 'user:manage',
  ROLE_READ: 'role:read',
  ROLE_MANAGE: 'role:manage',
  // configuration
  SETTINGS_READ: 'settings:read',
  SETTINGS_MANAGE: 'settings:manage',
  CUSTOM_FIELD_MANAGE: 'custom_field:manage',
  PIPELINE_MANAGE: 'pipeline:manage',
  AUTOMATION_MANAGE: 'automation:manage',
  INTEGRATION_MANAGE: 'integration:manage',
  // CRM
  LEAD_READ: 'lead:read',
  LEAD_CREATE: 'lead:create',
  LEAD_UPDATE: 'lead:update',
  LEAD_DELETE: 'lead:delete',
  LEAD_ASSIGN: 'lead:assign',
  LEAD_MERGE: 'lead:merge',
  LEAD_IMPORT: 'lead:import',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_MANAGE: 'customer:manage',
  TASK_READ: 'task:read',
  TASK_MANAGE: 'task:manage',
  TASK_MANAGE_OTHERS: 'task:manage_others',
  DEAL_READ: 'deal:read',
  DEAL_MANAGE: 'deal:manage',
  PAYMENT_READ: 'payment:read',
  PAYMENT_RECORD: 'payment:record',
  // communication
  CONVERSATION_READ: 'conversation:read',
  CONVERSATION_REPLY: 'conversation:reply',
  CONVERSATION_ASSIGN: 'conversation:assign',
  WHATSAPP_MANAGE: 'whatsapp:manage',
  TEMPLATE_MANAGE: 'template:manage',
  // insight
  REPORT_READ: 'report:read',
  ANALYTICS_READ: 'analytics:read',
  MARKETING_READ: 'marketing:read',
  MARKETING_MANAGE: 'marketing:manage',
  // data & platform surface
  EXPORT_DATA: 'export:data',
  EXPORT_PII: 'export:pii',
  AUDIT_READ: 'audit:read',
  BILLING_READ: 'billing:read',
  BILLING_MANAGE: 'billing:manage',
  API_KEY_MANAGE: 'api_key:manage',
  WEBHOOK_MANAGE: 'webhook:manage',
  PRIVACY_MANAGE: 'privacy:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  readonly key: Permission;
  readonly module: string;
  readonly description: string;
  /** False for permissions that are inherently organization-wide (billing, settings). */
  readonly supportsScope: boolean;
}

const P = PERMISSIONS;

export const PERMISSION_CATALOGUE: readonly PermissionDefinition[] = [
  {
    key: P.ORGANIZATION_READ,
    module: 'organization',
    description: 'View organization profile',
    supportsScope: false,
  },
  {
    key: P.ORGANIZATION_MANAGE,
    module: 'organization',
    description: 'Edit organization profile and defaults',
    supportsScope: false,
  },
  {
    key: P.BRANCH_MANAGE,
    module: 'organization',
    description: 'Create and edit branches',
    supportsScope: false,
  },
  {
    key: P.TEAM_MANAGE,
    module: 'organization',
    description: 'Create and edit teams and their members',
    supportsScope: false,
  },
  { key: P.USER_READ, module: 'users', description: 'View users', supportsScope: true },
  {
    key: P.USER_MANAGE,
    module: 'users',
    description: 'Invite, edit and disable users',
    supportsScope: false,
  },
  {
    key: P.ROLE_READ,
    module: 'iam',
    description: 'View roles and permissions',
    supportsScope: false,
  },
  {
    key: P.ROLE_MANAGE,
    module: 'iam',
    description: 'Create and edit roles and their grants',
    supportsScope: false,
  },
  {
    key: P.SETTINGS_READ,
    module: 'settings',
    description: 'View configuration',
    supportsScope: false,
  },
  {
    key: P.SETTINGS_MANAGE,
    module: 'settings',
    description: 'Change configuration',
    supportsScope: false,
  },
  {
    key: P.CUSTOM_FIELD_MANAGE,
    module: 'settings',
    description: 'Define custom fields',
    supportsScope: false,
  },
  {
    key: P.PIPELINE_MANAGE,
    module: 'settings',
    description: 'Define pipelines, stages and statuses',
    supportsScope: false,
  },
  {
    key: P.AUTOMATION_MANAGE,
    module: 'automation',
    description: 'Create and publish workflows',
    supportsScope: false,
  },
  {
    key: P.INTEGRATION_MANAGE,
    module: 'integrations',
    description: 'Connect and disconnect integrations',
    supportsScope: false,
  },
  { key: P.LEAD_READ, module: 'leads', description: 'View leads', supportsScope: true },
  { key: P.LEAD_CREATE, module: 'leads', description: 'Create leads', supportsScope: false },
  { key: P.LEAD_UPDATE, module: 'leads', description: 'Edit leads', supportsScope: true },
  {
    key: P.LEAD_DELETE,
    module: 'leads',
    description: 'Delete (soft) and restore leads',
    supportsScope: true,
  },
  {
    key: P.LEAD_ASSIGN,
    module: 'leads',
    description: 'Assign and reassign leads',
    supportsScope: true,
  },
  { key: P.LEAD_MERGE, module: 'leads', description: 'Merge duplicate leads', supportsScope: true },
  {
    key: P.LEAD_IMPORT,
    module: 'leads',
    description: 'Import leads from file',
    supportsScope: false,
  },
  { key: P.CUSTOMER_READ, module: 'customers', description: 'View customers', supportsScope: true },
  {
    key: P.CUSTOMER_MANAGE,
    module: 'customers',
    description: 'Edit customers',
    supportsScope: true,
  },
  {
    key: P.TASK_READ,
    module: 'tasks',
    description: 'View tasks and follow-ups',
    supportsScope: true,
  },
  {
    key: P.TASK_MANAGE,
    module: 'tasks',
    description: 'Create, complete and reschedule own tasks',
    supportsScope: true,
  },
  {
    key: P.TASK_MANAGE_OTHERS,
    module: 'tasks',
    description: "Act on other users' tasks",
    supportsScope: true,
  },
  {
    key: P.DEAL_READ,
    module: 'deals',
    description: 'View deals and quotations',
    supportsScope: true,
  },
  {
    key: P.DEAL_MANAGE,
    module: 'deals',
    description: 'Create and edit deals and quotations',
    supportsScope: true,
  },
  {
    key: P.PAYMENT_READ,
    module: 'payments',
    description: 'View payments received',
    supportsScope: true,
  },
  {
    /**
     * Separate from `deal:manage` deliberately: quoting a price and recording that money arrived
     * are different acts, and in most businesses they are done by different people. A workspace
     * that wants one person to do both grants both — these are rows, not roles.
     */
    key: P.PAYMENT_RECORD,
    module: 'payments',
    description: 'Record, confirm and refund payments',
    supportsScope: true,
  },
  {
    key: P.CONVERSATION_READ,
    module: 'conversations',
    description: 'View conversations',
    supportsScope: true,
  },
  {
    key: P.CONVERSATION_REPLY,
    module: 'conversations',
    description: 'Reply in conversations',
    supportsScope: true,
  },
  {
    key: P.CONVERSATION_ASSIGN,
    module: 'conversations',
    description: 'Assign and transfer conversations',
    supportsScope: true,
  },
  {
    key: P.WHATSAPP_MANAGE,
    module: 'whatsapp',
    description: 'Connect WhatsApp accounts and numbers',
    supportsScope: false,
  },
  {
    key: P.TEMPLATE_MANAGE,
    module: 'whatsapp',
    description: 'Create and submit message templates',
    supportsScope: false,
  },
  { key: P.REPORT_READ, module: 'reports', description: 'View reports', supportsScope: true },
  {
    key: P.ANALYTICS_READ,
    module: 'analytics',
    description: 'View website and product analytics',
    supportsScope: false,
  },
  {
    key: P.MARKETING_READ,
    module: 'marketing',
    description: 'View campaigns and attribution',
    supportsScope: false,
  },
  {
    key: P.MARKETING_MANAGE,
    module: 'marketing',
    description: 'Manage campaigns and segments',
    supportsScope: false,
  },
  { key: P.EXPORT_DATA, module: 'data', description: 'Export data', supportsScope: true },
  {
    key: P.EXPORT_PII,
    module: 'data',
    description: 'Include personal data in exports',
    supportsScope: false,
  },
  { key: P.AUDIT_READ, module: 'audit', description: 'View the audit log', supportsScope: false },
  {
    key: P.BILLING_READ,
    module: 'billing',
    description: 'View subscription and invoices',
    supportsScope: false,
  },
  {
    key: P.BILLING_MANAGE,
    module: 'billing',
    description: 'Change plan and payment details',
    supportsScope: false,
  },
  {
    key: P.API_KEY_MANAGE,
    module: 'api',
    description: 'Create and revoke API keys',
    supportsScope: false,
  },
  {
    key: P.WEBHOOK_MANAGE,
    module: 'api',
    description: 'Manage outbound webhooks',
    supportsScope: false,
  },
  {
    key: P.PRIVACY_MANAGE,
    module: 'privacy',
    description: 'Manage consent, retention and data requests',
    supportsScope: false,
  },
];

export interface RoleTemplate {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly grants: readonly { readonly permission: Permission; readonly scope: DataScope }[];
}

const ALL: DataScope = 'organization';

/** Seeded per organization. `isSystem` roles are editable but not deletable (FR-IAM-5). */
export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: 'owner',
    name: 'Owner',
    description: 'Full access, including billing and deletion',
    grants: PERMISSION_CATALOGUE.map((p) => ({ permission: p.key, scope: ALL })),
  },
  {
    code: 'admin',
    name: 'Administrator',
    description: 'Full operational access; cannot change billing',
    grants: PERMISSION_CATALOGUE.filter(
      (p) => p.key !== P.BILLING_MANAGE && p.key !== P.EXPORT_PII,
    ).map((p) => ({ permission: p.key, scope: ALL })),
  },
  {
    code: 'sales_manager',
    name: 'Sales Manager',
    description: 'Sees and manages their branch; monitors follow-ups and SLA',
    grants: [
      { permission: P.ORGANIZATION_READ, scope: ALL },
      { permission: P.USER_READ, scope: 'branch' },
      { permission: P.TEAM_MANAGE, scope: ALL },
      { permission: P.LEAD_READ, scope: 'branch' },
      { permission: P.LEAD_CREATE, scope: ALL },
      { permission: P.LEAD_UPDATE, scope: 'branch' },
      { permission: P.LEAD_ASSIGN, scope: 'branch' },
      { permission: P.LEAD_MERGE, scope: 'branch' },
      { permission: P.LEAD_IMPORT, scope: ALL },
      { permission: P.CUSTOMER_READ, scope: 'branch' },
      { permission: P.CUSTOMER_MANAGE, scope: 'branch' },
      { permission: P.TASK_READ, scope: 'branch' },
      { permission: P.TASK_MANAGE, scope: 'branch' },
      { permission: P.TASK_MANAGE_OTHERS, scope: 'branch' },
      { permission: P.DEAL_READ, scope: 'branch' },
      { permission: P.DEAL_MANAGE, scope: 'branch' },
      { permission: P.PAYMENT_READ, scope: 'branch' },
      { permission: P.PAYMENT_RECORD, scope: 'branch' },
      { permission: P.CONVERSATION_READ, scope: 'branch' },
      { permission: P.CONVERSATION_REPLY, scope: 'branch' },
      { permission: P.CONVERSATION_ASSIGN, scope: 'branch' },
      { permission: P.REPORT_READ, scope: 'branch' },
      { permission: P.EXPORT_DATA, scope: 'branch' },
    ],
  },
  {
    code: 'sales_executive',
    name: 'Sales Executive',
    description: 'Works their own leads, follow-ups and conversations',
    grants: [
      { permission: P.ORGANIZATION_READ, scope: ALL },
      { permission: P.LEAD_READ, scope: 'own' },
      { permission: P.LEAD_CREATE, scope: ALL },
      { permission: P.LEAD_UPDATE, scope: 'own' },
      { permission: P.CUSTOMER_READ, scope: 'own' },
      { permission: P.CUSTOMER_MANAGE, scope: 'own' },
      { permission: P.TASK_READ, scope: 'own' },
      { permission: P.TASK_MANAGE, scope: 'own' },
      { permission: P.DEAL_READ, scope: 'own' },
      { permission: P.DEAL_MANAGE, scope: 'own' },
      { permission: P.PAYMENT_READ, scope: 'own' },
      // A salesperson who collects the cheque has to be able to record it; a workspace that wants
      // only finance to do that removes this grant, which is a row.
      { permission: P.PAYMENT_RECORD, scope: 'own' },
      { permission: P.CONVERSATION_READ, scope: 'own' },
      { permission: P.CONVERSATION_REPLY, scope: 'own' },
    ],
  },
  {
    code: 'marketing_manager',
    name: 'Marketing Manager',
    description: 'Campaigns, attribution and website analytics',
    grants: [
      { permission: P.ORGANIZATION_READ, scope: ALL },
      { permission: P.LEAD_READ, scope: ALL },
      { permission: P.REPORT_READ, scope: ALL },
      { permission: P.ANALYTICS_READ, scope: ALL },
      { permission: P.MARKETING_READ, scope: ALL },
      { permission: P.MARKETING_MANAGE, scope: ALL },
      { permission: P.TEMPLATE_MANAGE, scope: ALL },
      { permission: P.EXPORT_DATA, scope: ALL },
    ],
  },
  {
    code: 'auditor',
    name: 'Read-only / Auditor',
    description: 'Read access with no ability to change anything',
    grants: [
      { permission: P.ORGANIZATION_READ, scope: ALL },
      { permission: P.USER_READ, scope: ALL },
      { permission: P.ROLE_READ, scope: ALL },
      { permission: P.SETTINGS_READ, scope: ALL },
      { permission: P.LEAD_READ, scope: ALL },
      { permission: P.CUSTOMER_READ, scope: ALL },
      { permission: P.TASK_READ, scope: ALL },
      { permission: P.DEAL_READ, scope: ALL },
      { permission: P.PAYMENT_READ, scope: ALL },
      { permission: P.CONVERSATION_READ, scope: ALL },
      { permission: P.REPORT_READ, scope: ALL },
      { permission: P.AUDIT_READ, scope: ALL },
      { permission: P.BILLING_READ, scope: ALL },
    ],
  },
];

/** Widest scope wins when a user holds the same permission through several roles. */
const SCOPE_RANK: Record<DataScope, number> = { own: 0, team: 1, branch: 2, organization: 3 };

export function widestScope(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export function scopeAtLeast(actual: DataScope, required: DataScope): boolean {
  return SCOPE_RANK[actual] >= SCOPE_RANK[required];
}
