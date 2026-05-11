import { Migration } from '@mikro-orm/migrations';

/**
 * Add `tenant_id` to `prm_marketing_materials` so the portal Marketing Library
 * can scope visibility by tenant (shared across all agency orgs) rather than
 * by the authoring organization. Backfills from `organizations.tenant_id`
 * before enforcing NOT NULL.
 *
 * NOTE: the OM core Organization entity maps to table `organizations` (plural).
 * The first iteration of this migration used the singular `organization` which
 * does not exist — fixed before any environment recorded it as applied (the
 * migration is transactional, so the broken run rolled back cleanly).
 */
export class Migration20260511014325 extends Migration {

  override async up(): Promise<void> {
    // 1. Add the column as NULLABLE first so existing rows survive the ALTER.
    this.addSql(`alter table "prm_marketing_materials" add column "tenant_id" uuid;`);

    // 2. Backfill from organizations.tenant_id (single source of truth for the
    //    authoring org's tenant context).
    this.addSql(
      `update "prm_marketing_materials" mm ` +
      `set "tenant_id" = o."tenant_id" ` +
      `from "organizations" o ` +
      `where mm."organization_id" = o."id" and mm."tenant_id" is null;`,
    );

    // 3. Enforce NOT NULL once every row has a tenant_id.
    this.addSql(
      `alter table "prm_marketing_materials" alter column "tenant_id" set not null;`,
    );

    // 4. Index for the new scoping filter (matches the @Index decorator).
    this.addSql(
      `create index "prm_marketing_materials_tenant_id_index" on "prm_marketing_materials" ("tenant_id");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index "prm_marketing_materials_tenant_id_index";`);
    this.addSql(`alter table "prm_marketing_materials" drop column "tenant_id";`);
  }

}
