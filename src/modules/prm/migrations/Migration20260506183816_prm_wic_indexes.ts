import { Migration } from '@mikro-orm/migrations'

/**
 * PRM WIC ingestion — non-decorator-expressible indexes, CHECKs, FKs (Spec #4).
 *
 * Companion to `Migration20260506183815_prm_wic.ts`. Ships:
 *   - Partial UNIQUE for active-row supersession (invariant #3 — at the "currently active
 *     row per (agency_member_id, contribution_month)" grain, predicate
 *     `superseded_by_id IS NULL AND archived_at IS NULL`).
 *   - DB-level CHECK on `contribution_month` day-of-month = 1 (defence-in-depth for ACL).
 *   - Enum CHECKs on `wic_level`, `rejection_reason`, `resolution_action`.
 *   - FKs to `prm_agencies` (snapshot agency_id, resolved_agency_id) and
 *     `prm_agency_members` (FK on agency_member_id) — RESTRICT to prevent silent cascade.
 *   - Read-shape indexes for Spec #2 dashboard (active-row partial index on
 *     `(agency_id, contribution_month DESC)`) and B10 default filter
 *     (`(resolved_at, rejection_reason) WHERE resolved_at IS NULL`).
 *
 * Cross-spec contract: the constraint and index names below are FROZEN; downstream
 * specs must reference them by name when extending.
 *
 * **Additive only** — no DROP / ALTER COLUMN.
 */
export class Migration20260506183816_prm_wic_indexes extends Migration {
  override async up(): Promise<void> {
    // Invariant #3 — exactly one active row per (member, month).
    this.addSql(
      `create unique index if not exists "prm_wic_contributions_active_member_month_uniq" on "prm_wic_contributions" ("agency_member_id", "contribution_month") where "superseded_by_id" is null and "archived_at" is null;`,
    )

    // Spec §1.4.6 ACL defence-in-depth — first-of-month enforced at DB.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_contributions_month_first_check') then alter table "prm_wic_contributions" add constraint "prm_wic_contributions_month_first_check" check (extract(day from "contribution_month") = 1); end if; end $$;`,
    )

    // wic_level enum check — informational only (L-002), but still constrained.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_contributions_wic_level_check') then alter table "prm_wic_contributions" add constraint "prm_wic_contributions_wic_level_check" check ("wic_level" is null or "wic_level" in ('L1','L2','L3','L4')); end if; end $$;`,
    )

    // rejection_reason enum — App Spec §1.4.6 form is the persisted contract.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_import_audit_log_rejection_reason_check') then alter table "prm_wic_import_audit_log" add constraint "prm_wic_import_audit_log_rejection_reason_check" check ("rejection_reason" in ('unknown_github_profile','ambiguous_github_profile','malformed_month','unknown_level','invalid_payload')); end if; end $$;`,
    )

    // resolution_action enum (B10 row actions).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_import_audit_log_resolution_action_check') then alter table "prm_wic_import_audit_log" add constraint "prm_wic_import_audit_log_resolution_action_check" check ("resolution_action" is null or "resolution_action" in ('accepted_after_fix','rolled_back','ignored')); end if; end $$;`,
    )

    // FKs — RESTRICT on parent rows; matches existing PRM pattern (invariant #4 cousin).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_contributions_agency_fk') then alter table "prm_wic_contributions" add constraint "prm_wic_contributions_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_contributions_agency_member_fk') then alter table "prm_wic_contributions" add constraint "prm_wic_contributions_agency_member_fk" foreign key ("agency_member_id") references "prm_agency_members" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_contributions_superseded_by_fk') then alter table "prm_wic_contributions" add constraint "prm_wic_contributions_superseded_by_fk" foreign key ("superseded_by_id") references "prm_wic_contributions" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_wic_import_audit_log_resolved_agency_fk') then alter table "prm_wic_import_audit_log" add constraint "prm_wic_import_audit_log_resolved_agency_fk" foreign key ("resolved_agency_id") references "prm_agencies" ("id") on delete set null; end if; end $$;`,
    )

    // Read-shape indexes.
    // Spec #2 dashboard reads (sum of wic_score per agency per month over active rows).
    this.addSql(
      `create index if not exists "prm_wic_contributions_active_agency_month_idx" on "prm_wic_contributions" ("agency_id", "contribution_month" desc) where "archived_at" is null;`,
    )
    // Month rollups (cross-agency).
    this.addSql(
      `create index if not exists "prm_wic_contributions_month_agency_idx" on "prm_wic_contributions" ("contribution_month", "agency_id");`,
    )
    // B10 default filter — open issues (resolved_at IS NULL) sorted by rejection_reason.
    this.addSql(
      `create index if not exists "prm_wic_import_audit_log_open_idx" on "prm_wic_import_audit_log" ("resolved_at", "rejection_reason") where "resolved_at" is null;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "prm_wic_contributions_active_member_month_uniq";`)
    this.addSql(`drop index if exists "prm_wic_contributions_active_agency_month_idx";`)
    this.addSql(`drop index if exists "prm_wic_contributions_month_agency_idx";`)
    this.addSql(`drop index if exists "prm_wic_import_audit_log_open_idx";`)
    this.addSql(`alter table "prm_wic_contributions" drop constraint if exists "prm_wic_contributions_month_first_check";`)
    this.addSql(`alter table "prm_wic_contributions" drop constraint if exists "prm_wic_contributions_wic_level_check";`)
    this.addSql(`alter table "prm_wic_import_audit_log" drop constraint if exists "prm_wic_import_audit_log_rejection_reason_check";`)
    this.addSql(`alter table "prm_wic_import_audit_log" drop constraint if exists "prm_wic_import_audit_log_resolution_action_check";`)
    this.addSql(`alter table "prm_wic_contributions" drop constraint if exists "prm_wic_contributions_agency_fk";`)
    this.addSql(`alter table "prm_wic_contributions" drop constraint if exists "prm_wic_contributions_agency_member_fk";`)
    this.addSql(`alter table "prm_wic_contributions" drop constraint if exists "prm_wic_contributions_superseded_by_fk";`)
    this.addSql(`alter table "prm_wic_import_audit_log" drop constraint if exists "prm_wic_import_audit_log_resolved_agency_fk";`)
  }
}
