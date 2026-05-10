import { Migration } from '@mikro-orm/migrations';

/**
 * Drops the `visibility` + `audiences` columns from `prm_marketing_materials`
 * and replaces `audiences` with a new role-gate column `allowed_roles`.
 *
 * Visibility semantics merged into a NULL/non-NULL test on `min_tier`:
 *   - `min_tier IS NULL`     → all partners see it (formerly `visibility = 'all_partners'`).
 *   - `min_tier IS NOT NULL` → tier-gated         (formerly `visibility = 'tier_gated'`).
 *
 * Audiences (old: free string array) replaced by `allowed_roles` — JSONB
 * array of customer-role slugs (`partner_admin` / `partner_member`).
 * Empty array (the default) means visible to all roles.
 *
 * The live partial index is rebuilt without `visibility`:
 *   `(published_at, min_tier_rank) WHERE published_at IS NOT NULL AND unpublished_at IS NULL`.
 *
 * Auto-generated rename of `audiences → allowed_roles` is preserved (data
 * survives the migration), but in practice the column starts effectively
 * empty for new tenants. The auto-generator missed the live index + CHECK
 * constraints — those are dropped/recreated explicitly here.
 */
export class Migration20260510080949 extends Migration {

  override async up(): Promise<void> {
    // Drop the partial live-index that references `visibility` before we drop
    // the column; recreate without it after.
    this.addSql(`drop index if exists "prm_marketing_materials_live_idx";`);

    // Drop the visibility-related CHECK constraints. The
    // `tier_gated_requires_min_tier` constraint is gone outright (min_tier
    // is now freely optional); the standalone `visibility_check` enum
    // CHECK is dropped because its column is going away.
    this.addSql(`alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_tier_gated_requires_min_tier_check";`);
    this.addSql(`alter table "prm_marketing_materials" drop constraint if exists "prm_marketing_materials_visibility_check";`);

    // Drop the `visibility` column + its single-column index.
    this.addSql(`drop index if exists "prm_marketing_materials_visibility_index";`);
    this.addSql(`alter table "prm_marketing_materials" drop column if exists "visibility";`);

    // Rename `audiences` → `allowed_roles` (preserves whatever historical
    // values existed; new writes use seeded customer-role slugs).
    this.addSql(`alter table "prm_marketing_materials" rename column "audiences" to "allowed_roles";`);

    // Recreate the live partial index — same predicate, but without
    // `visibility` in the column list.
    this.addSql(
      `create index if not exists "prm_marketing_materials_live_idx" on "prm_marketing_materials" ("published_at", "min_tier_rank") where "published_at" is not null and "unpublished_at" is null;`,
    );
  }

  override async down(): Promise<void> {
    // Reverse the live-index rebuild + column rename + visibility re-add.
    this.addSql(`drop index if exists "prm_marketing_materials_live_idx";`);
    this.addSql(`alter table "prm_marketing_materials" rename column "allowed_roles" to "audiences";`);
    this.addSql(`alter table "prm_marketing_materials" add column "visibility" text not null default 'all_partners';`);
    this.addSql(`create index "prm_marketing_materials_visibility_index" on "prm_marketing_materials" ("visibility");`);
    // Re-add the original CHECK constraints (kept idempotent).
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_visibility_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_visibility_check" check ("visibility" in ('all_partners','tier_gated')); end if; end $$;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_marketing_materials_tier_gated_requires_min_tier_check') then alter table "prm_marketing_materials" add constraint "prm_marketing_materials_tier_gated_requires_min_tier_check" check ("visibility" = 'all_partners' or "min_tier" is not null); end if; end $$;`);
    // Recreate the original live partial index with `visibility` in the
    // column list.
    this.addSql(
      `create index if not exists "prm_marketing_materials_live_idx" on "prm_marketing_materials" ("published_at", "visibility", "min_tier_rank") where "published_at" is not null and "unpublished_at" is null;`,
    );
  }

}
