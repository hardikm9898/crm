/**
 * The timeline's type registry (docs/database-design.md §6.5, ADR-0009).
 *
 * A **code constant, not a database enum**. Adding a type is adding an entry here plus a renderer in
 * the UI registry — no migration (`FR-TL-3`). The database column is a plain string precisely so that
 * a lead created before a type existed still renders, and an event emitted by an older release still
 * writes.
 *
 * Lives in shared because three very different consumers need the same list: the domain services
 * that write activities, the job processors that write them from events, and the tests that assert a
 * feature wrote to the timeline at all (rule 6 — a feature that skips the timeline is unfinished).
 */

export const ACTIVITY_TYPES = {
  // lead lifecycle
  LEAD_CREATED: 'lead.created',
  LEAD_SOURCE_CAPTURED: 'lead.source_captured',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_REASSIGNED: 'lead.reassigned',
  LEAD_UNASSIGNED: 'lead.unassigned',
  LEAD_STATUS_CHANGED: 'lead.status_changed',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  LEAD_SCORE_CHANGED: 'lead.score_changed',
  LEAD_FIELD_UPDATED: 'lead.field_updated',
  LEAD_TAGGED: 'lead.tagged',
  LEAD_UNTAGGED: 'lead.untagged',
  LEAD_MERGED: 'lead.merged',
  LEAD_DUPLICATE_DETECTED: 'lead.duplicate_detected',
  LEAD_CONVERTED: 'lead.converted',
  LEAD_LOST: 'lead.lost',
  LEAD_REOPENED: 'lead.reopened',
  LEAD_RECYCLED: 'lead.recycled',
  LEAD_DELETED: 'lead.deleted',
  LEAD_RESTORED: 'lead.restored',
  // tasks (Phase 3)
  TASK_CREATED: 'task.created',
  TASK_COMPLETED: 'task.completed',
  TASK_RESCHEDULED: 'task.rescheduled',
  TASK_CANCELLED: 'task.cancelled',
  TASK_OVERDUE: 'task.overdue',
  // conversations and channels (Phases 4–5)
  CALL_LOGGED: 'call.logged',
  CALL_MISSED: 'call.missed',
  WHATSAPP_SENT: 'whatsapp.sent',
  WHATSAPP_RECEIVED: 'whatsapp.received',
  WHATSAPP_FAILED: 'whatsapp.failed',
  WHATSAPP_TEMPLATE_SENT: 'whatsapp.template_sent',
  WHATSAPP_READ: 'whatsapp.read',
  EMAIL_SENT: 'email.sent',
  EMAIL_OPENED: 'email.opened',
  EMAIL_CLICKED: 'email.clicked',
  EMAIL_BOUNCED: 'email.bounced',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_TRANSFERRED: 'conversation.transferred',
  CONVERSATION_CLOSED: 'conversation.closed',
  CONVERSATION_REOPENED: 'conversation.reopened',
  // collaboration
  NOTE_ADDED: 'note.added',
  MENTION_CREATED: 'mention.created',
  DOCUMENT_UPLOADED: 'document.uploaded',
  // commercial (Phase 2 later steps)
  QUOTATION_SENT: 'quotation.sent',
  DEAL_CREATED: 'deal.created',
  DEAL_WON: 'deal.won',
  DEAL_LOST: 'deal.lost',
  PAYMENT_RECEIVED: 'payment.received',
  // website and marketing (Phases 7–9)
  WEBSITE_SESSION: 'website.session',
  WEBSITE_PAGE_VIEW: 'website.page_view',
  WEBSITE_PRODUCT_VIEW: 'website.product_view',
  WEBSITE_CTA_CLICK: 'website.cta_click',
  WEBSITE_WHATSAPP_CLICK: 'website.whatsapp_click',
  WEBSITE_CHECKOUT_STARTED: 'website.checkout_started',
  WEBSITE_PURCHASE: 'website.purchase',
  MARKETING_TOUCHPOINT_ADDED: 'marketing.touchpoint_added',
  // automation (Phase 6)
  AUTOMATION_ENROLLED: 'automation.enrolled',
  AUTOMATION_ACTION_EXECUTED: 'automation.action_executed',
  AUTOMATION_SKIPPED: 'automation.skipped',
  AUTOMATION_FAILED: 'automation.failed',
  AUTOMATION_EXITED: 'automation.exited',
  // service levels and consent
  SLA_AT_RISK: 'sla.at_risk',
  SLA_BREACHED: 'sla.breached',
  CONSENT_GRANTED: 'consent.granted',
  CONSENT_REVOKED: 'consent.revoked',
  // AI (Phase 11)
  AI_SUMMARY_GENERATED: 'ai.summary_generated',
  AI_SUGGESTION_GENERATED: 'ai.suggestion_generated',
} as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];

const ALL_ACTIVITY_TYPES: readonly string[] = Object.values(ACTIVITY_TYPES);

export function isKnownActivityType(value: string): value is ActivityType {
  return ALL_ACTIVITY_TYPES.includes(value);
}

/**
 * The modules a type belongs to, derived from its prefix rather than a second list that could
 * disagree with the first. Used to group a timeline and to filter it by area.
 */
export function activityModule(type: string): string {
  return type.split('.')[0] ?? 'unknown';
}

export const ACTIVITY_MODULES: readonly string[] = [
  ...new Set(ALL_ACTIVITY_TYPES.map(activityModule)),
];

/**
 * Whether an activity is visible to everyone who can read the subject, or only to colleagues.
 *
 * `internal` exists for the things a business says to itself — an automation's reasoning, a private
 * note — and matters the moment any of this becomes visible to a customer (a shared timeline, an
 * exported journey).
 */
export const ACTIVITY_VISIBILITY = ['all', 'internal'] as const;
export type ActivityVisibility = (typeof ACTIVITY_VISIBILITY)[number];
