import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #5 (rfp-broadcast-response) — non-decorator-expressible structures
 * for the `Rfp`, `RfpBroadcast`, `RfpResponse` aggregates.
 *
 * Mirrors the existing two-migration split (`prm_prospect_indexes`,
 * `prm_license_deal_indexes`, `prm_wic_ingestion_indexes`):
 *   - Enum CHECK constraints (`status`, `eligibility_filter`,
 *     `budget_bucket`, `timeline_bucket`).
 *   - Cross-field CHECK: `min_tier` required iff `eligibility_filter = 'by_min_tier'`.
 *   - FKs to `organizations` (directory module — its actual table name), `prm_agencies`, `prm_agency_members`.
 *   - Perf indexes for portal inbox JOIN and Spec #6 scoring-ready query.
 *   - Deadline index for the auto-transition scheduler (Spec #6 owns the job;
 *     index lives here so the column owner ships it).
 *
 * Additive only. No DROP / ALTER COLUMN.
 *
 * Cross-spec FROZEN names:
 *   - `prm_rfp_broadcasts_rfp_agency_uniq` (created in companion migration —
 *     UNIQUE source of truth for invariant #15).
 *   - `prm_rfp_responses_rfp_agency_uniq` (likewise).
 */
export class Migration20260506224954_prm_rfp_indexes extends Migration {
  override async up(): Promise<void> {
    // Rfp.status enum
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_status_check') then alter table "prm_rfps" add constraint "prm_rfps_status_check" check ("status" in ('draft','published','scoring','selection_made','closed')); end if; end $$;`,
    )
    // Rfp.eligibility_filter enum
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_eligibility_filter_check') then alter table "prm_rfps" add constraint "prm_rfps_eligibility_filter_check" check ("eligibility_filter" in ('all_active','by_min_tier','explicit')); end if; end $$;`,
    )
    // Rfp.budget_bucket enum (NULL allowed)
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_budget_bucket_check') then alter table "prm_rfps" add constraint "prm_rfps_budget_bucket_check" check ("budget_bucket" is null or "budget_bucket" in ('<50k','50k-250k','250k-1m','1m+','unknown')); end if; end $$;`,
    )
    // Rfp.timeline_bucket enum (NULL allowed)
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_timeline_bucket_check') then alter table "prm_rfps" add constraint "prm_rfps_timeline_bucket_check" check ("timeline_bucket" is null or "timeline_bucket" in ('0-3m','3-6m','6-12m','12m+','unknown')); end if; end $$;`,
    )
    // Cross-field: min_tier required iff eligibility_filter = 'by_min_tier'.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_min_tier_required_check') then alter table "prm_rfps" add constraint "prm_rfps_min_tier_required_check" check ("eligibility_filter" <> 'by_min_tier' or "min_tier" is not null); end if; end $$;`,
    )
    // Cross-field: explicit_agency_ids non-empty iff eligibility_filter = 'explicit'.
    // Postgres jsonb_array_length raises on non-array; the COALESCE-guard keeps the
    // CHECK total-function over the column.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_explicit_agencies_required_check') then alter table "prm_rfps" add constraint "prm_rfps_explicit_agencies_required_check" check ("eligibility_filter" <> 'explicit' or (jsonb_typeof("explicit_agency_ids") = 'array' and jsonb_array_length("explicit_agency_ids") > 0)); end if; end $$;`,
    )
    // FK: Rfp.organization_id → organizations(id) (RESTRICT).
    // Directory core module declares the table as `organizations` (not `directory_organizations`);
    // the original reference here failed at migrate time and blocked all ephemeral Playwright runs.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_organization_fk') then alter table "prm_rfps" add constraint "prm_rfps_organization_fk" foreign key ("organization_id") references "organizations" ("id") on delete restrict; end if; end $$;`,
    )
    // FK: Rfp.selected_agency_id → prm_agencies(id) (SET NULL on agency delete).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfps_selected_agency_fk') then alter table "prm_rfps" add constraint "prm_rfps_selected_agency_fk" foreign key ("selected_agency_id") references "prm_agencies" ("id") on delete set null; end if; end $$;`,
    )

    // Inbox / scheduler indexes.
    this.addSql(
      `create index if not exists "prm_rfps_deadline_idx" on "prm_rfps" ("deadline_to_respond") where "deleted_at" is null and "deadline_to_respond" is not null;`,
    )

    // RfpBroadcast.status_check N/A (no status enum); but FKs + perf indexes:
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_broadcasts_rfp_fk') then alter table "prm_rfp_broadcasts" add constraint "prm_rfp_broadcasts_rfp_fk" foreign key ("rfp_id") references "prm_rfps" ("id") on delete cascade; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_broadcasts_agency_fk') then alter table "prm_rfp_broadcasts" add constraint "prm_rfp_broadcasts_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    // Inbox-list hot path: agency view, unread first.
    this.addSql(
      `create index if not exists "prm_rfp_broadcasts_agency_first_opened_idx" on "prm_rfp_broadcasts" ("agency_id", "first_opened_at");`,
    )

    // RfpResponse.status enum
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_responses_status_check') then alter table "prm_rfp_responses" add constraint "prm_rfp_responses_status_check" check ("status" in ('draft','submitted')); end if; end $$;`,
    )
    // FKs.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_responses_rfp_fk') then alter table "prm_rfp_responses" add constraint "prm_rfp_responses_rfp_fk" foreign key ("rfp_id") references "prm_rfps" ("id") on delete cascade; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_responses_agency_fk') then alter table "prm_rfp_responses" add constraint "prm_rfp_responses_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_responses_member_fk') then alter table "prm_rfp_responses" add constraint "prm_rfp_responses_member_fk" foreign key ("submitted_by_member_id") references "prm_agency_members" ("id") on delete restrict; end if; end $$;`,
    )
    // Spec #6 scoring-ready hot path: by RFP + status.
    this.addSql(
      `create index if not exists "prm_rfp_responses_rfp_status_idx" on "prm_rfp_responses" ("rfp_id", "status");`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "prm_rfp_responses_rfp_status_idx";`)
    this.addSql(
      `alter table "prm_rfp_responses" drop constraint if exists "prm_rfp_responses_member_fk";`,
    )
    this.addSql(
      `alter table "prm_rfp_responses" drop constraint if exists "prm_rfp_responses_agency_fk";`,
    )
    this.addSql(`alter table "prm_rfp_responses" drop constraint if exists "prm_rfp_responses_rfp_fk";`)
    this.addSql(
      `alter table "prm_rfp_responses" drop constraint if exists "prm_rfp_responses_status_check";`,
    )
    this.addSql(`drop index if exists "prm_rfp_broadcasts_agency_first_opened_idx";`)
    this.addSql(
      `alter table "prm_rfp_broadcasts" drop constraint if exists "prm_rfp_broadcasts_agency_fk";`,
    )
    this.addSql(`alter table "prm_rfp_broadcasts" drop constraint if exists "prm_rfp_broadcasts_rfp_fk";`)
    this.addSql(`drop index if exists "prm_rfps_deadline_idx";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_selected_agency_fk";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_organization_fk";`)
    this.addSql(
      `alter table "prm_rfps" drop constraint if exists "prm_rfps_explicit_agencies_required_check";`,
    )
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_min_tier_required_check";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_timeline_bucket_check";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_budget_bucket_check";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_eligibility_filter_check";`)
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_status_check";`)
  }
}
