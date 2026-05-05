import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #3 (attribution-loop) — adds the `LicenseDeal` aggregate.
 *
 * **Scope:** additive only. Touches only `prm_license_deals`. Cross-spec contract
 * (FROZEN — Specs #5/#6 read these):
 *   - Table: `prm_license_deals`
 *   - Status enum: `pending` / `signed` / `active` / `churned`
 *   - Attribution path enum: `A` / `B` / `C` / `none`
 *   - Saga `correlationKey = license_deal_id + ':' + attribution_source`
 *
 * Invariant #7 trigger and enum CHECKs ship in the companion migration
 * `Migration20260505170000_prm_license_deal_indexes.ts` (mirrors the
 * `prm_prospects` two-migration split).
 */
export class Migration20260505160923_prm_license_deal extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "prm_license_deals" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "license_identifier" text not null, "client_company_name" text not null, "client_industry" text null, "type" text not null default 'enterprise', "status" text not null default 'pending', "is_renewal" boolean not null default false, "previous_license_deal_id" uuid null, "closed_at" timestamptz null, "signed_at" timestamptz null, "annual_value_usd" numeric(12,2) null, "monthly_license_amount" numeric(12,2) null, "attribution_path" text not null default 'none', "attribution_source" text not null default 'direct', "prospect_id" uuid null, "rfp_id" uuid null, "attributed_agency_id" uuid null, "attribution_reasoning" text null, "attributed_at" timestamptz null, "notes" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "version" int not null default 1, constraint "prm_license_deals_pkey" primary key ("id"));`,
    )
    this.addSql(`create index "prm_license_deals_tenant_id_index" on "prm_license_deals" ("tenant_id");`)
    this.addSql(`create index "prm_license_deals_organization_id_index" on "prm_license_deals" ("organization_id");`)
    this.addSql(
      `create index "prm_license_deals_client_company_name_index" on "prm_license_deals" ("client_company_name");`,
    )
    this.addSql(`create index "prm_license_deals_status_index" on "prm_license_deals" ("status");`)
    this.addSql(`create index "prm_license_deals_attribution_path_index" on "prm_license_deals" ("attribution_path");`)
    this.addSql(`create index "prm_license_deals_prospect_id_index" on "prm_license_deals" ("prospect_id");`)
    this.addSql(`create index "prm_license_deals_rfp_id_index" on "prm_license_deals" ("rfp_id");`)
    this.addSql(
      `create index "prm_license_deals_attributed_agency_id_index" on "prm_license_deals" ("attributed_agency_id");`,
    )
    this.addSql(
      `alter table "prm_license_deals" add constraint "prm_license_deals_tenant_identifier_uniq" unique ("tenant_id", "license_identifier");`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prm_license_deals" cascade;`)
  }
}
