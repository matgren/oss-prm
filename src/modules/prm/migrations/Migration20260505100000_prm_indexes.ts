import { Migration } from '@mikro-orm/migrations'

/**
 * PRM follow-up migration — non-decorator-expressible structures.
 *
 * The MikroORM-generated migration covers tables, columns, FKs, and full UNIQUEs.
 * Partial unique indexes (the GH-profile global lock per invariant #5) and explicit
 * enum CHECK constraints are not derivable from decorators in this version of MikroORM,
 * so we add them in this companion migration. **Additive only** — no DROP / ALTER COLUMN.
 *
 * Cross-spec contract: this index name (`prm_agency_members_github_profile_active_uniq`)
 * is FROZEN; downstream specs must reference it by name when extending.
 */
export class Migration20260505100000PrmIndexes extends Migration {
  override async up(): Promise<void> {
    // Partial UNIQUE on LOWER(github_profile) — invariant #5, deliberately tenant-unscoped.
    this.addSql(
      `create unique index if not exists "prm_agency_members_github_profile_active_uniq" on "prm_agency_members" (lower("github_profile")) where "is_active" = true and "github_profile" is not null and "deleted_at" is null;`,
    )
    // Partial UNIQUE on customer_user_id — invariant #5 (1:1 CustomerUser ↔ AgencyMember).
    this.addSql(
      `create unique index if not exists "prm_agency_members_customer_user_uniq" on "prm_agency_members" ("customer_user_id") where "customer_user_id" is not null and "deleted_at" is null;`,
    )
    // FK to prm_agencies — restrict prevents accidental cascade-delete (invariant #4).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agency_members_agency_fk') then alter table "prm_agency_members" add constraint "prm_agency_members_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    // Enum CHECK constraints — defence-in-depth alongside zod validation.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agencies_tier_check') then alter table "prm_agencies" add constraint "prm_agencies_tier_check" check ("tier" in ('om_agency','ai_native','ai_native_expert','ai_native_core')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agencies_status_check') then alter table "prm_agencies" add constraint "prm_agencies_status_check" check ("status" in ('active','historical')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agencies_team_size_bucket_check') then alter table "prm_agencies" add constraint "prm_agencies_team_size_bucket_check" check ("team_size_bucket" is null or "team_size_bucket" in ('1-5','6-20','21-50','51-100','100+')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agency_members_role_slug_check') then alter table "prm_agency_members" add constraint "prm_agency_members_role_slug_check" check ("role_slug" in ('partner_admin','partner_member')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_agency_members_agency_status_check') then alter table "prm_agency_members" add constraint "prm_agency_members_agency_status_check" check ("agency_status" in ('active','historical')); end if; end $$;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "prm_agency_members_github_profile_active_uniq";`)
    this.addSql(`drop index if exists "prm_agency_members_customer_user_uniq";`)
    this.addSql(`alter table "prm_agency_members" drop constraint if exists "prm_agency_members_agency_fk";`)
    this.addSql(`alter table "prm_agencies" drop constraint if exists "prm_agencies_tier_check";`)
    this.addSql(`alter table "prm_agencies" drop constraint if exists "prm_agencies_status_check";`)
    this.addSql(`alter table "prm_agencies" drop constraint if exists "prm_agencies_team_size_bucket_check";`)
    this.addSql(`alter table "prm_agency_members" drop constraint if exists "prm_agency_members_role_slug_check";`)
    this.addSql(`alter table "prm_agency_members" drop constraint if exists "prm_agency_members_agency_status_check";`)
  }
}
