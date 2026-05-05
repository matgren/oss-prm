import { Migration } from '@mikro-orm/migrations';

/**
 * PRM baseline migration — creates `prm_agencies` and `prm_agency_members`.
 *
 * The first auto-generated emit for this module accidentally contained ~1200 lines of
 * unrelated drops/creates spanning ~80 other modules' tables. Root cause: when the
 * generator ran for PRM, no `.snapshot-open-mercato.json` existed for the module yet,
 * so MikroORM compared its (PRM-only) entity set against the live database — every
 * non-PRM table looked "extra" → drop, then "missing" → recreate. The snapshot that
 * was emitted alongside the bad migration is correct (it lists only the two PRM
 * tables) so this clean baseline is paired with that snapshot; future
 * `yarn mercato db generate` runs diff entities against the snapshot and produce
 * either an empty or PRM-only delta.
 *
 * The SQL below is lifted verbatim from the generator's PRM-only output (the two
 * blocks that survived after the contamination was filtered out). Constraint /
 * column / type names match what the entity decorators in `data/entities.ts` would
 * produce on a fresh generation — verified by inspecting both the snapshot and the
 * paired `Migration20260505100000_prm_indexes.ts` which references these names.
 */
export class Migration20260505090240_prm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "prm_agencies" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "slug" text not null, "description" text null, "website_url" text null, "logo_url" text null, "headquarters_country" text not null, "headquarters_city" text null, "team_size_bucket" text null, "industries" jsonb not null default '[]', "services" jsonb not null default '[]', "tech_capabilities" jsonb not null default '[]', "tier" text not null default 'om_agency', "status" text not null default 'active', "contract_signed" boolean not null default false, "nda_signed" boolean not null default false, "onboarded" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "prm_agencies_pkey" primary key ("id"));`);
    this.addSql(`create index "prm_agencies_tenant_id_index" on "prm_agencies" ("tenant_id");`);
    this.addSql(`create index "prm_agencies_tier_index" on "prm_agencies" ("tier");`);
    this.addSql(`create index "prm_agencies_status_index" on "prm_agencies" ("status");`);
    this.addSql(`alter table "prm_agencies" add constraint "prm_agencies_tenant_slug_uniq" unique ("tenant_id", "slug");`);
    this.addSql(`alter table "prm_agencies" add constraint "prm_agencies_organization_uniq" unique ("organization_id");`);

    this.addSql(`create table "prm_agency_members" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "agency_id" uuid not null, "customer_user_id" uuid null, "invitation_id" uuid null, "email" text not null, "email_lookup" text not null, "first_name" text not null, "last_name" text not null, "role_in_agency" text null, "github_profile" text null, "is_active" boolean not null default true, "invited_at" timestamptz not null, "activated_at" timestamptz null, "agency_status" text not null default 'active', "role_slug" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "prm_agency_members_pkey" primary key ("id"));`);
    this.addSql(`create index "prm_agency_members_tenant_id_index" on "prm_agency_members" ("tenant_id");`);
    this.addSql(`create index "prm_agency_members_agency_id_index" on "prm_agency_members" ("agency_id");`);
    this.addSql(`alter table "prm_agency_members" add constraint "prm_agency_members_agency_email_uniq" unique ("agency_id", "email_lookup");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prm_agency_members" cascade;`);
    this.addSql(`drop table if exists "prm_agencies" cascade;`);
  }

}
