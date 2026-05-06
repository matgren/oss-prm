import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #5 (rfp-broadcast-response) — adds the `Rfp`, `RfpBroadcast`,
 * `RfpResponse` aggregates.
 *
 * **Scope:** additive only. Creates three new tables — `prm_rfps`,
 * `prm_rfp_broadcasts`, `prm_rfp_responses`. No existing table is touched.
 *
 * Cross-spec contract (FROZEN):
 *   - `prm_rfps.is_path_b_locked` boolean default false. WRITTEN by Spec #3's
 *     `RfpPathBLockSubscriber` (already shipped on develop) on
 *     `prm.license_deal.status_changed`. READ by Spec #6 (not yet built) for
 *     the re-open guard.
 *   - `prm_rfps.status` enum: `draft` / `published` / `scoring` /
 *     `selection_made` / `closed`.
 *   - `prm_rfps.eligibility_filter` enum: `all_active` / `by_min_tier` /
 *     `explicit`.
 *   - `prm_rfp_responses.status` enum: `draft` / `submitted` (Spec #6 derives
 *     `scored / selected / not_selected` as views, NOT persisted columns).
 *
 * Enum CHECK constraints, FKs, and the `(rfp_id, agency_id)` UNIQUE on
 * broadcasts + responses ship in the companion
 * `Migration20260506224954_prm_rfp_indexes.ts` (mirrors the existing
 * `prm_prospects` / `prm_license_deals` / `prm_wic` two-migration split).
 */
export class Migration20260506224953_prm_rfp extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "prm_rfps" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "title" text not null, "received_from" text not null, "received_at" timestamptz not null, "description" text not null, "tech_requirements" text not null, "domain_requirements" text not null, "industry" text null, "budget_bucket" text null, "timeline_bucket" text null, "required_capabilities" jsonb not null default '[]', "additional_criterion_name" text null, "deadline_to_respond" timestamptz null, "eligibility_filter" text not null, "min_tier" text null, "explicit_agency_ids" jsonb null, "status" text not null default 'draft', "selected_agency_id" uuid null, "selection_decided_at" timestamptz null, "selection_decided_by_user_id" uuid null, "selection_reasoning" text null, "is_path_b_locked" boolean not null default false, "notes" text null, "created_by_user_id" uuid not null, "published_at" timestamptz null, "closed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "prm_rfps_pkey" primary key ("id"));`,
    )
    this.addSql(`create index "prm_rfps_organization_id_index" on "prm_rfps" ("organization_id");`)
    this.addSql(`create index "prm_rfps_status_index" on "prm_rfps" ("status");`)

    this.addSql(
      `create table "prm_rfp_broadcasts" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "rfp_id" uuid not null, "agency_id" uuid not null, "broadcast_at" timestamptz not null, "first_opened_at" timestamptz null, "declined_at" timestamptz null, "decline_reason" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "prm_rfp_broadcasts_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index "prm_rfp_broadcasts_organization_id_index" on "prm_rfp_broadcasts" ("organization_id");`,
    )
    this.addSql(`create index "prm_rfp_broadcasts_rfp_id_index" on "prm_rfp_broadcasts" ("rfp_id");`)
    this.addSql(`create index "prm_rfp_broadcasts_agency_id_index" on "prm_rfp_broadcasts" ("agency_id");`)
    this.addSql(
      `alter table "prm_rfp_broadcasts" add constraint "prm_rfp_broadcasts_rfp_agency_uniq" unique ("rfp_id", "agency_id");`,
    )

    this.addSql(
      `create table "prm_rfp_responses" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "rfp_id" uuid not null, "agency_id" uuid not null, "submitted_by_member_id" uuid not null, "status" text not null default 'draft', "tech_experience" text null, "domain_experience" text null, "differentiators" text null, "attached_case_study_ids" jsonb not null default '[]', "first_submitted_at" timestamptz null, "last_updated_at" timestamptz not null, "challenge_round_updated_at" timestamptz null, "created_at" timestamptz not null, constraint "prm_rfp_responses_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index "prm_rfp_responses_organization_id_index" on "prm_rfp_responses" ("organization_id");`,
    )
    this.addSql(`create index "prm_rfp_responses_rfp_id_index" on "prm_rfp_responses" ("rfp_id");`)
    this.addSql(`create index "prm_rfp_responses_agency_id_index" on "prm_rfp_responses" ("agency_id");`)
    this.addSql(
      `alter table "prm_rfp_responses" add constraint "prm_rfp_responses_rfp_agency_uniq" unique ("rfp_id", "agency_id");`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prm_rfp_responses" cascade;`)
    this.addSql(`drop table if exists "prm_rfp_broadcasts" cascade;`)
    this.addSql(`drop table if exists "prm_rfps" cascade;`)
  }
}
