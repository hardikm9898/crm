import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './testing/fixtures.js';

/**
 * THE HAND-WRITTEN SCHEMA OBJECTS SUITE.
 *
 * Everything asserted here exists in the database and **cannot be expressed in
 * `schema.prisma`**: partitioning, composite foreign keys that span three columns, expression and
 * GIN indexes, partial unique indexes, triggers, check constraints. Prisma therefore sees each one
 * as something that is in the database but not in the schema, and `prisma migrate diff` proposes
 * deleting it — which is exactly what happened when this file did not exist. The step-2 migration
 * was generated with six DROPs at the top of it, they were applied, and the guarantee that a lead
 * cannot sit in another pipeline's stage was gone for a day without a single test noticing.
 *
 * So this suite is not about behaviour. It is the answer to "did the last generated migration
 * quietly delete a guarantee", and it must be read whenever a migration is generated.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

async function indexExists(name: string): Promise<boolean> {
  const rows = await h.unscoped.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) AS count FROM pg_indexes WHERE indexname = ${name}`;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function constraintExists(name: string): Promise<boolean> {
  const rows = await h.unscoped.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) AS count FROM pg_constraint WHERE conname = ${name}`;
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Indexes Prisma has no syntax for, and therefore proposes dropping on every diff. */
const REQUIRED_INDEXES = [
  // Search (docs/database-design.md §15).
  'leads_search_vector_gin',
  'leads_custom_values_gin',
  'leads_phone_e164_trgm',
  'leads_full_name_trgm',
  'leads_email_trgm',
  // The support index for the three-column FK below. Dropping it drops the FK with it.
  'pipeline_stages_pipeline_scoped_key',
  // Partial indexes: the questions managers actually ask, and the uniqueness rules that only
  // apply to live rows.
  'leads_no_next_action',
  'leads_unassigned',
  'leads_email_lower',
  'leads_open_per_assignee',
  'lead_statuses_one_default_per_org',
  'pipelines_one_default_per_org_entity',
  'lead_duplicates_open',
  'lead_merges_undoable',
  'lead_merges_one_standing_per_merged_lead',
  // Scoring and saved views.
  'lead_score_events_once_per_source_event',
  'saved_views_owner_name_key',
  'saved_views_shared_name_key',
  'saved_views_one_default_per_role',
  'leads_score_band',
  'leads_decay_candidates',
  // The referencing side of the two self-FKs on `leads`. Postgres does not index it automatically,
  // and without these every delete scans the whole table twice per row.
  'leads_duplicate_of',
  'leads_merged_into',
  // Imports and exports. `documents_expiring` is what the hourly sweep scans; without it the sweep
  // reads every document a workspace has ever stored to find the handful that expired.
  'documents_expiring',
  // Customers. `customers_lead_unique` is partial, which is what makes a lead convert at most once
  // while still allowing any number of customers who were never leads; `customers_merged_into` is
  // the referencing side of the self-FK, the same omission that made lead deletion quadratic.
  'customers_lead_unique',
  'customers_merged_into',
  'customers_search_vector_gin',
  'customers_custom_values_gin',
  'customers_phone_e164_trgm',
  'customers_full_name_trgm',
  'customers_email_trgm',
  'customers_live_created_at',
  // Deals, products and line items (`FR-DEAL-1`).
  'products_sku_key',
  'deals_open_close_date',
  'deals_won',
  'deals_live_created_at',
  'deals_search_vector_gin',
  'deals_custom_values_gin',
  'deals_name_trgm',
  // Quotations (`FR-DEAL-2`). `quotations_current` is the partial index behind every list — the
  // current version of each number — and `quotations_superseded_by` is the referencing side of the
  // version self-FK, the same omission that made lead deletion quadratic.
  'quotations_current',
  'quotations_superseded_by',
  'quotations_awaiting_expiry',
  // Payments. `payments_provider_payment_key` is the idempotency key a provider webhook will need
  // (rule 12), partial because a manually recorded payment has neither column; `payments_received`
  // is what every revenue figure reads.
  'payments_provider_payment_key',
  'payments_received',
  'deals_part_paid',
  // Tasks (`FR-TSK-1..7`). `tasks_open` and `tasks_open_due_date` are the Today view;
  // `tasks_overdue_unreported` and `task_reminders_pending` are what the two sweeps scan, and both
  // are deliberately un-prefixed by `organization_id` or keyed on the sweep's own predicate
  // because they run across tenants. `tasks_follows` and `leads_next_action_task` are the
  // referencing sides of the FKs into `tasks` — the omission that made lead deletion quadratic.
  'tasks_open',
  'tasks_open_due_date',
  'tasks_overdue_unreported',
  'tasks_lead_open',
  'tasks_live_created_at',
  'tasks_follows',
  'leads_next_action_task',
  'task_reminders_pending',
  // SLA (`FR-TSK-8`). `sla_clocks_awaiting_warning` and `sla_clocks_awaiting_breach` are what the
  // five-minute sweep scans across tenants — two partial indexes rather than one on `state`,
  // because "needs warning" and "needs breaching" are different questions. Neither leads with
  // `organization_id`, deliberately: the sweep is platform-wide.
  'sla_clocks_awaiting_warning',
  'sla_clocks_awaiting_breach',
  'sla_clocks_open',
  'escalations_clock',
  'escalations_unacknowledged',
];

/**
 * Constraints that encode a guarantee no application check can give, either because they are
 * composite across three columns or because they are checks.
 */
const REQUIRED_CONSTRAINTS = [
  // "A lead in another pipeline's stage" is unrepresentable. This is the one that was lost.
  'leads_stage_in_pipeline_fk',
  // Value objects.
  'leads_currency_format',
  'leads_value_needs_currency',
  'leads_phone_e164_format',
  'leads_whatsapp_e164_format',
  'leads_full_name_present',
  'leads_score_range',
  // Duplicates and assignment.
  'leads_not_own_duplicate',
  'leads_not_own_merge_target',
  'lead_duplicates_distinct_pair',
  'lead_duplicates_confidence_range',
  'duplicate_rules_match_on_not_empty',
  'duplicate_rules_lookback_positive',
  'lead_merges_distinct_pair',
  'assignment_pool_members_weight_positive',
  'round_robin_state_cursor_non_negative',
  // The self-referential composite FKs on `leads`.
  'leads_duplicate_of_same_org_fk',
  'leads_merged_into_same_org_fk',
  // The composite FK that makes a pool member's membership, not merely their user row, the thing
  // being referenced.
  'assignment_pool_members_membership_same_org_fk',
  // Scoring. The exclusion constraint is the one that cannot be expressed any other way: it makes
  // two overlapping score bands unrepresentable rather than merely refused.
  'score_bands_no_overlap',
  'score_bands_range',
  'scoring_rules_decay_matches_trigger',
  'scoring_rules_decay_shape',
  'lead_score_events_delta_not_zero',
  'lead_score_events_score_after_range',
  'lead_score_events_lead_same_org_fk',
  'lead_score_events_rule_same_org_fk',
  // Saved views.
  'saved_views_visibility',
  'saved_views_team_requires_team',
  'saved_views_private_requires_owner',
  'saved_views_filters_is_object',
  'saved_views_team_same_org_fk',
  'saved_views_role_same_org_fk',
  'saved_views_owner_same_org_fk',
  // Imports and exports (`FR-IO-1`, `FR-IO-3`).
  'documents_size_positive',
  'documents_name_present',
  'documents_key_present',
  'documents_checksum_sha256',
  'documents_scan_status',
  'documents_subject',
  'import_jobs_status',
  'import_jobs_mode',
  'import_jobs_mapping_is_object',
  'import_jobs_delimiter_single',
  'import_jobs_counts_non_negative',
  // The one that makes a progress bar unable to lie: the outcome counts must add up to what was
  // processed, so a run cannot report 9 800 processed with only 9 000 accounted for.
  'import_jobs_outcomes_account_for_processed',
  'import_jobs_processed_within_total',
  'import_jobs_document_same_org_fk',
  'import_rows_status',
  'import_rows_number_positive',
  'import_rows_errors_is_array',
  'import_rows_raw_is_object',
  'import_rows_failed_has_error',
  'import_rows_outcome_has_lead',
  'import_rows_job_same_org_fk',
  'import_rows_lead_same_org_fk',
  'export_jobs_status',
  'export_jobs_filters_is_object',
  'export_jobs_columns_is_array',
  'export_jobs_row_count_non_negative',
  'export_jobs_completed_has_document',
  'export_jobs_document_same_org_fk',
  // Customers and conversion (`FR-DEAL-4`).
  'customers_name_present',
  'customers_country_code',
  'customers_tax_id_length',
  'customers_not_merged_into_self',
  // The pair that keeps provenance honest: a customer converted from a lead has a conversion date,
  // and a conversion date without a lead would be a claim about a capture that never happened.
  'customers_converted_has_lead',
  'customers_lead_same_org_fk',
  'customers_branch_same_org_fk',
  'customers_team_same_org_fk',
  'customers_owner_same_org_fk',
  'customers_merged_into_same_org_fk',
  // Deals. The three-column FK is the one that makes "a deal in another pipeline's stage"
  // unrepresentable — the same guarantee `leads_stage_in_pipeline_fk` gives, and the same one
  // Prisma has proposed dropping in every migration since it was written.
  'deals_stage_in_pipeline_fk',
  'deals_has_subject',
  'deals_name_present',
  'deals_currency_format',
  'deals_probability_range',
  'deals_money_non_negative',
  // The header total must equal its own parts. A deal whose value disagrees with its line items is
  // a quotation nobody can defend.
  'deals_totals_add_up',
  'deals_discount_within_gross',
  'deals_not_won_and_lost',
  'deals_lost_reason_needs_loss',
  'deals_lost_note_needs_loss',
  'deals_lead_same_org_fk',
  'deals_customer_same_org_fk',
  'deals_owner_same_org_fk',
  'deals_pipeline_same_org_fk',
  'deals_stage_same_org_fk',
  'deals_lost_reason_same_org_fk',
  'deal_items_name_present',
  'deal_items_position_positive',
  'deal_items_quantity_positive',
  'deal_items_tax_percent_range',
  'deal_items_money_non_negative',
  // The line's own arithmetic, enforced rather than trusted: `lineTotals()` in `@leados/shared` is
  // the one implementation, and these catch a second one appearing.
  'deal_items_net_is_gross_less_discount',
  'deal_items_total_is_net_plus_tax',
  'deal_items_discount_within_gross',
  'deal_items_deal_same_org_fk',
  'deal_items_product_same_org_fk',
  'products_name_present',
  'products_price_non_negative',
  'products_tax_percent_range',
  'products_currency_format',
  // Quotations (`FR-DEAL-2`). The status/timestamp pairs are what make the lifecycle unable to
  // lie: a `sent_at` with no send, or an "accepted" with no acceptance date, is unrepresentable
  // rather than merely unlikely.
  'quotations_has_subject',
  'quotations_status',
  'quotations_sent_via',
  'quotations_number_present',
  'quotations_version_positive',
  'quotations_currency_format',
  'quotations_sent_has_timestamp',
  'quotations_accepted_has_timestamp',
  'quotations_rejected_has_timestamp',
  'quotations_expired_has_timestamp',
  'quotations_reason_needs_rejection',
  // A draft cannot carry a rendered PDF: a file of a document that is still being written is a
  // file somebody sends by mistake.
  'quotations_pdf_needs_sending',
  'quotations_superseded_pair',
  'quotations_not_superseded_by_self',
  'quotations_money_non_negative',
  // The same arithmetic as a deal's, enforced rather than trusted (ADR-0018).
  'quotations_totals_add_up',
  'quotations_discount_within_gross',
  'quotations_deal_same_org_fk',
  'quotations_lead_same_org_fk',
  'quotations_customer_same_org_fk',
  'quotations_owner_same_org_fk',
  'quotations_rejected_reason_same_org_fk',
  'quotations_pdf_document_same_org_fk',
  'quotations_superseded_by_same_org_fk',
  'quotation_items_name_present',
  'quotation_items_position_positive',
  'quotation_items_quantity_positive',
  'quotation_items_tax_percent_range',
  'quotation_items_money_non_negative',
  'quotation_items_net_is_gross_less_discount',
  'quotation_items_total_is_net_plus_tax',
  'quotation_items_discount_within_gross',
  'quotation_items_quotation_same_org_fk',
  'quotation_items_product_same_org_fk',
  // The number series behind the numbers.
  'number_series_kind_present',
  'number_series_next_value_positive',
  'number_series_padding_range',
  // Payments (`FR-DEAL-3`). `payments_received_has_timestamp` is deliberately **not** a
  // biconditional on `succeeded`: a refunded payment did arrive and keeps its date, and writing it
  // the obvious way made it contradict `payments_refund_was_received` and refunding impossible.
  'payments_has_subject',
  'payments_status',
  'payments_number_present',
  'payments_currency_format',
  'payments_amount_positive',
  'payments_received_has_timestamp',
  'payments_failed_has_timestamp',
  'payments_refunded_has_timestamp',
  'payments_refund_was_received',
  'payments_metadata_is_object',
  'payments_deal_same_org_fk',
  'payments_quotation_same_org_fk',
  'payments_lead_same_org_fk',
  'payments_customer_same_org_fk',
  'payments_owner_same_org_fk',
  'payments_method_same_org_fk',
  'payment_methods_name_present',
  // The derived money columns, and the pair that keeps the two purchase dates honest.
  'deals_paid_non_negative',
  'customers_lifetime_value_non_negative',
  'customers_purchase_dates_pair',
  'customers_purchase_dates_ordered',
  // Industry templates (`FR-ONB-2`). The description check is not pedantry: a picker whose entries
  // have no sentence of description is a picker nobody can choose from.
  'industry_templates_key_format',
  'industry_templates_name_present',
  'industry_templates_description_present',
  'industry_templates_definition_is_object',
  // Tasks (`FR-TSK-1..6`). `tasks_completed_has_outcome` is the one that makes "what happened on
  // those forty calls" answerable a month later; the two timestamp pairs are written as `CASE`
  // rather than as biconditionals, which is how the payments migration made refunding impossible.
  'tasks_has_subject',
  'tasks_title_present',
  'tasks_completed_has_timestamp',
  'tasks_cancelled_has_timestamp',
  'tasks_completed_has_outcome',
  'tasks_reminder_offsets_is_array',
  'tasks_reschedule_count_non_negative',
  'tasks_not_own_follow_up',
  'tasks_lead_same_org_fk',
  'tasks_customer_same_org_fk',
  'tasks_deal_same_org_fk',
  'tasks_assignee_same_org_fk',
  'tasks_type_same_org_fk',
  'tasks_outcome_same_org_fk',
  'tasks_follows_same_org_fk',
  'leads_next_action_task_same_org_fk',
  'task_types_name_present',
  'task_types_duration_positive',
  'task_types_reminder_offsets_is_array',
  'task_outcomes_name_present',
  'reschedule_reasons_name_present',
  'task_reschedules_changes_the_time',
  'task_reschedules_note_present',
  'task_reschedules_task_same_org_fk',
  'task_reschedules_reason_same_org_fk',
  'task_reminders_offset_non_negative',
  'task_reminders_task_same_org_fk',
  // SLA (`FR-TSK-8`). `escalations_level_matches_reason` and the unique
  // `escalation_once_per_level_key` together are the "escalate exactly once" guarantee the phase's
  // exit criteria ask for — a database constraint rather than a careful sweep.
  'sla_policies_name_present',
  'sla_policies_first_response_positive',
  'sla_policies_next_response_positive',
  'sla_policies_resolution_positive',
  'sla_policies_warn_percent_range',
  'sla_policies_applies_to_is_object',
  'sla_policies_escalate_to_is_object',
  'sla_clocks_lead_subject_has_lead',
  'sla_clocks_subject_matches_lead',
  'sla_clocks_target_minutes_positive',
  'sla_clocks_paused_non_negative',
  'sla_clocks_instants_ordered',
  'sla_clocks_satisfied_has_timestamp',
  'sla_clocks_breached_has_timestamp',
  'sla_clocks_cancelled_has_timestamp',
  'sla_clocks_policy_same_org_fk',
  'sla_clocks_lead_same_org_fk',
  'sla_clocks_assignee_same_org_fk',
  'escalations_level_matches_reason',
  'escalations_notified_somebody',
  'escalations_acknowledged_pair',
  'escalations_clock_same_org_fk',
  'escalations_policy_same_org_fk',
];

describe('hand-written indexes survive every generated migration', () => {
  it.each(REQUIRED_INDEXES)('%s exists', async (name) => {
    expect(
      await indexExists(name),
      `${name} is missing. A generated migration probably dropped it — see the note at the top of ` +
        'the newest migration.',
    ).toBe(true);
  });
});

describe('hand-written constraints survive every generated migration', () => {
  it.each(REQUIRED_CONSTRAINTS)('%s exists', async (name) => {
    expect(await constraintExists(name), `${name} is missing`).toBe(true);
  });
});

describe('the objects Prisma cannot describe at all', () => {
  it('keeps activities partitioned by range, with a default partition', async () => {
    const rows = await h.unscoped.$queryRaw<
      { partition_strategy: string | null; partitions: bigint }[]
    >`
      SELECT (SELECT partstrat::text FROM pg_partitioned_table WHERE partrelid = 'activities'::regclass)
               AS partition_strategy,
             (SELECT count(*) FROM pg_inherits WHERE inhparent = 'activities'::regclass)
               AS partitions
    `;
    // 'r' is RANGE. A table that stopped being partitioned would still answer every query.
    expect(rows[0]?.partition_strategy).toBe('r');
    expect(Number(rows[0]?.partitions ?? 0)).toBeGreaterThan(1);
  });

  it('keeps the default partition, without which a stranded month becomes an error', async () => {
    expect(await indexExists('activities_default_pkey')).toBe(true);
  });

  it('keeps the partition-creating function the maintenance job calls', async () => {
    const rows = await h.unscoped.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM pg_proc WHERE proname = 'ensure_activity_partition'`;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('keeps the search-vector trigger, without which search silently returns nothing', async () => {
    const rows = await h.unscoped.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_trigger
      WHERE tgrelid = 'leads'::regclass AND tgname = 'leads_search_vector_trg' AND NOT tgisinternal
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('keeps the customers search-vector trigger too', async () => {
    // Two tables, two triggers, one search box. If this one goes, a converted customer is simply
    // absent from search results — and nothing else about the product looks broken.
    const rows = await h.unscoped.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_trigger
      WHERE tgrelid = 'customers'::regclass
        AND tgname = 'customers_search_vector_trg'
        AND NOT tgisinternal
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('keeps the deals search-vector trigger too', async () => {
    const rows = await h.unscoped.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_trigger
      WHERE tgrelid = 'deals'::regclass AND tgname = 'deals_search_vector_trg' AND NOT tgisinternal
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('keeps btree_gist, without which the band exclusion constraint cannot exist', async () => {
    const rows = await h.unscoped.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('keeps the audit log append-only', async () => {
    const rows = await h.unscoped.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_trigger
      WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal
    `;
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
