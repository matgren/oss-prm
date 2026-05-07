import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #7 (case-studies-marketing) — adds the `CaseStudy` +
 * `MarketingMaterial` aggregates.
 *
 * Scope: additive only. Creates `prm_case_studies` + `prm_marketing_materials`.
 * CHECK constraints + partial indexes ship in the companion `_indexes.ts`
 * migration (mirrors the existing two-migration split used by every other
 * PRM aggregate).
 *
 * Cross-spec contract (FROZEN):
 *   - `prm_case_studies.may_publish_on_om_website` + `prm_case_studies.published_url`
 *     together constitute "published" per invariant #8.
 *   - `prm_case_studies.deleted_at` enables US2.3 soft-delete (no hard-delete in v1).
 *   - `prm_marketing_materials` uses `published_at IS NOT NULL AND unpublished_at IS NULL`
 *     as the "currently published" predicate (re-publish bumps `published_at`).
 *   - `min_tier_rank` is application-maintained (not Postgres GENERATED) — see
 *     `lib/tierRank.ts`.
 */
export class Migration20260507062342_prm_case_study_marketing_material extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "prm_case_studies" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "agency_id" uuid not null, "title" text not null, "client_name" text not null, "client_industry" text null, "client_country" text null, "challenge_markdown" text not null, "approach_markdown" text not null, "outcome_markdown" text not null, "technologies_used" jsonb not null default '[]', "services_delivered" jsonb not null default '[]', "hero_image_attachment_id" uuid null, "gallery_attachment_ids" jsonb not null default '[]', "may_publish_on_om_website" boolean not null default false, "published_url" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "prm_case_studies_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index "prm_case_studies_organization_id_index" on "prm_case_studies" ("organization_id");`,
    )
    this.addSql(
      `create index "prm_case_studies_agency_id_index" on "prm_case_studies" ("agency_id");`,
    )
    this.addSql(
      `create index "prm_case_studies_may_publish_on_om_website_index" on "prm_case_studies" ("may_publish_on_om_website");`,
    )

    this.addSql(
      `create table "prm_marketing_materials" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "title" text not null, "description" text null, "material_type" text not null, "visibility" text not null default 'all_partners', "min_tier" text null, "min_tier_rank" smallint null, "topics" jsonb not null default '[]', "audiences" jsonb not null default '[]', "primary_attachment_id" uuid not null, "published_at" timestamptz null, "unpublished_at" timestamptz null, "created_by_user_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "prm_marketing_materials_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index "prm_marketing_materials_organization_id_index" on "prm_marketing_materials" ("organization_id");`,
    )
    this.addSql(
      `create index "prm_marketing_materials_material_type_index" on "prm_marketing_materials" ("material_type");`,
    )
    this.addSql(
      `create index "prm_marketing_materials_visibility_index" on "prm_marketing_materials" ("visibility");`,
    )
    this.addSql(
      `create index "prm_marketing_materials_min_tier_rank_index" on "prm_marketing_materials" ("min_tier_rank");`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prm_marketing_materials" cascade;`)
    this.addSql(`drop table if exists "prm_case_studies" cascade;`)
  }
}
