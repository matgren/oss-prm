import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #7 (case-studies-marketing) — non-decorator-expressible structures
 * for `CaseStudy` + `MarketingMaterial`.
 *
 * Mirrors the existing two-migration split. Ships:
 *   - `prm_case_studies`:
 *       - Invariant #8 CHECK: `published_url IS NULL OR may_publish_on_om_website = TRUE`.
 *       - Partial index serving Spec #5 P10 picker (`agency_id WHERE deleted_at IS NULL`).
 *       - Partial index serving B8 publish-flag triage.
 *       - FKs to `organizations` + `prm_agencies`. (Directory core declares the table
 *         as `organizations`; an earlier draft incorrectly referenced
 *         `directory_organizations` which broke ephemeral migrate. Fixed in line with
 *         Migration20260506224954's precedent comment.)
 *   - `prm_marketing_materials`:
 *       - Enum CHECKs: `material_type`, `visibility`, `min_tier`.
 *       - Cross-field CHECK: `min_tier` required iff `visibility = 'tier_gated'`.
 *       - Cross-field CHECK: `unpublished_at IS NULL OR published_at IS NOT NULL`.
 *       - Partial index serving the live-and-tier-gated query.
 *       - FK to `organizations` (same correction as above).
 *
 * Additive only. No DROP / ALTER COLUMN.
 */
export class Migration20260507062343_prm_case_study_marketing_material_indexes extends Migration {
  override async up(): Promise<void> {
    // ---- prm_case_studies ----
    // Invariant #8.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_case_studies_published_url_requires_flag_check') then alter table "prm_case_studies" add constraint "prm_case_studies_published_url_requires_flag_check" check ("published_url" is null or "may_publish_on_om_website" = true); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_case_studies_organization_fk') then alter table "prm_case_studies" add constraint "prm_case_studies_organization_fk" foreign key ("organization_id") references "organizations" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_case_studies_agency_fk') then alter table "prm_case_studies" add constraint "prm_case_studies_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `create index if not exists "prm_case_studies_agency_live_idx" on "prm_case_studies" ("agency_id") where "deleted_at" is null;`,
    )
    this.addSql(
      `create index if not exists "prm_case_studies_publish_flag_idx" on "prm_case_studies" ("may_publish_on_om_website", "published_url") where "may_publish_on_om_website" = true;`,
    )

    // ---- prm_marketing_materials ----
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_material_type_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_material_type_check" check ("material_type" in ('playbook','sales_deck','video','guide','case_study_template','other')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_visibility_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_visibility_check" check ("visibility" in ('all_partners','tier_gated')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_min_tier_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_min_tier_check" check ("min_tier" is null or "min_tier" in ('om_agency','ai_native','ai_native_expert','ai_native_core')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_tier_gated_requires_min_tier_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_tier_gated_requires_min_tier_check" check ("visibility" = 'all_partners' or "min_tier" is not null); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_unpublished_after_published_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_unpublished_after_published_check" check ("unpublished_at" is null or "published_at" is not null); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_organization_fk') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_organization_fk" foreign key ("organization_id") references "organizations" ("id") on delete restrict; end if; end $$;`,
    )
    // Live-and-tier-gated hot path: serves the P11 portal query.
    this.addSql(
      `create index if not exists "prm_marketing_materials_live_idx" on "prm_marketing_materials" ("published_at", "visibility", "min_tier_rank") where "published_at" is not null and "unpublished_at" is null;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "prm_marketing_materials_live_idx";`)
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_organization_fk";`,
    )
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_unpublished_after_published_check";`,
    )
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_tier_gated_requires_min_tier_check";`,
    )
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_min_tier_check";`,
    )
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_visibility_check";`,
    )
    this.addSql(
      `alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_material_type_check";`,
    )
    this.addSql(`drop index if exists "prm_case_studies_publish_flag_idx";`)
    this.addSql(`drop index if exists "prm_case_studies_agency_live_idx";`)
    this.addSql(
      `alter table "prm_case_studies" drop constraint if exists "prm_case_studies_agency_fk";`,
    )
    this.addSql(
      `alter table "prm_case_studies" drop constraint if exists "prm_case_studies_organization_fk";`,
    )
    this.addSql(
      `alter table "prm_case_studies" drop constraint if exists "prm_case_studies_published_url_requires_flag_check";`,
    )
  }
}
