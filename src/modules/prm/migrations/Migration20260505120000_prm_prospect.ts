import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #2 (wip-scoreboard) — adds the `Prospect` aggregate and its read-model
 * projection `prm_prospect_candidate_index`.
 *
 * **Scope:** additive only. Touches only `prm_*` tables. Cross-spec contract
 * (FROZEN — Spec #3 attribution-loop reads these):
 *   - Table: `prm_prospects`
 *   - Table: `prm_prospect_candidate_index` (PK = `prospect_id`)
 *
 * State machine + immutability invariants are enforced both at the aggregate
 * (`ProspectService`) and at the DB layer via the companion indexes migration
 * (`Migration20260505130000_prm_prospect_indexes.ts`). The split mirrors the
 * Phase-1 pattern (`Migration20260505100000_prm_indexes.ts` for `prm_agencies`).
 */
export class Migration20260505120000_prm_prospect extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "prm_prospects" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "agency_id" uuid not null, "registered_by_agency_member_id" uuid not null, "company_name" text not null, "contact_name" text not null, "contact_email" text not null, "source" text not null default 'agency_owned', "status" text not null default 'new', "lost_reason" text null, "notes" text null, "registered_at" timestamptz not null, "status_changed_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "prm_prospects_pkey" primary key ("id"));`,
    )
    this.addSql(`create index "prm_prospects_tenant_id_index" on "prm_prospects" ("tenant_id");`)
    this.addSql(`create index "prm_prospects_organization_id_index" on "prm_prospects" ("organization_id");`)
    this.addSql(`create index "prm_prospects_agency_id_index" on "prm_prospects" ("agency_id");`)
    this.addSql(
      `create index "prm_prospects_registered_by_agency_member_id_index" on "prm_prospects" ("registered_by_agency_member_id");`,
    )
    this.addSql(`create index "prm_prospects_status_index" on "prm_prospects" ("status");`)
    this.addSql(`create index "prm_prospects_registered_at_index" on "prm_prospects" ("registered_at");`)

    this.addSql(
      `create table "prm_prospect_candidate_index" ("prospect_id" uuid not null, "organization_id" uuid not null, "agency_id" uuid not null, "normalized_company_name" text not null, "lowercased_contact_email" text not null, "current_status" text not null, "registered_at" timestamptz not null, "projection_updated_at" timestamptz not null, constraint "prm_prospect_candidate_index_pkey" primary key ("prospect_id"));`,
    )
    this.addSql(
      `create index "prm_prospect_candidate_index_organization_id_index" on "prm_prospect_candidate_index" ("organization_id");`,
    )
    this.addSql(
      `create index "prm_prospect_candidate_index_agency_id_index" on "prm_prospect_candidate_index" ("agency_id");`,
    )
    this.addSql(
      `create index "prm_prospect_candidate_index_normalized_company_name_index" on "prm_prospect_candidate_index" ("normalized_company_name");`,
    )
    this.addSql(
      `create index "prm_prospect_candidate_index_lowercased_contact_email_index" on "prm_prospect_candidate_index" ("lowercased_contact_email");`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prm_prospect_candidate_index" cascade;`)
    this.addSql(`drop table if exists "prm_prospects" cascade;`)
  }
}
