import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #2 (wip-scoreboard) — adds a synthetic `id` column to
 * `prm_prospect_candidate_index` that mirrors `prospect_id` via a Postgres
 * `GENERATED ALWAYS AS (prospect_id) STORED` clause.
 *
 * **Scope:** additive only. The PK remains `prospect_id` (frozen cross-spec
 * contract — T1 §11, T2 Golden Rule picker reads it directly).
 *
 * **Why:** the framework's `query_index` reindexer
 * (`@open-mercato/core/src/modules/query_index/lib/reindexer.ts:179,332,336`)
 * hardcodes `b.id` as the partition / pagination column for every entity it
 * sweeps. Without an `id` column, `yarn mercato init --reinstall` fails the
 * reindex pass with `column b.id does not exist`. Maintained server-side by
 * Postgres — zero application code, zero subscriber changes.
 */
export class Migration20260505232046_prm_prospect_candidate_index_id_mirror extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "prm_prospect_candidate_index" add column "id" uuid generated always as (prospect_id) stored not null;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_prospect_candidate_index" drop column "id";`)
  }
}
