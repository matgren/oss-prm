import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #6 (rfp-scoring-selection) — adds the append-only
 * `RfpResponseScore` aggregate and the `reopened_deadline_at` column on
 * the existing `prm_rfps` table.
 *
 * **Scope:** additive only. Creates one new table — `prm_rfp_response_scores`
 * — and one new nullable column on `prm_rfps`. No existing column is
 * touched destructively; the only ALTER is on the `prm_rfps_status_check`
 * constraint to extend the enum with the new `reopened` value.
 *
 * Cross-spec contract (FROZEN once shipped):
 *   - `prm_rfp_response_scores.version` is monotonically increasing per
 *     `rfp_response_id`. UNIQUE `(rfp_response_id, version)` is the
 *     source of truth for invariant #18 (append-only).
 *   - `prm_rfp_response_scores.source` enum: `manual` / `llm_assisted`.
 *   - `prm_rfps.status` enum extended to include `reopened` — Spec #6
 *     ships the additive enum extension.
 *   - `prm_rfps.reopened_deadline_at` TIMESTAMPTZ NULL — owned by Spec #6.
 *
 * Enum CHECKs, FKs, and the cross-field CHECK
 * (`source = 'llm_assisted' ↔ llm_model_id IS NOT NULL`) ship in the
 * companion `Migration20260507100001_prm_rfp_score_indexes.ts`.
 */
export class Migration20260507100000_prm_rfp_score extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "prm_rfp_response_scores" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "rfp_response_id" uuid not null, "version" integer not null, "scored_by_user_id" uuid not null, "tech_fit_score" smallint not null, "domain_fit_score" smallint not null, "optional_score" smallint null, "include_optional" boolean not null default false, "reasoning" text not null, "source" text not null, "llm_model_id" text null, "change_reason" text null, "created_at" timestamptz not null, constraint "prm_rfp_response_scores_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index "prm_rfp_response_scores_organization_id_index" on "prm_rfp_response_scores" ("organization_id");`,
    )
    this.addSql(
      `create index "prm_rfp_response_scores_rfp_response_id_index" on "prm_rfp_response_scores" ("rfp_response_id");`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_response_version_uniq" unique ("rfp_response_id", "version");`,
    )

    // Additive column on prm_rfps — Spec §5.2.
    this.addSql(`alter table "prm_rfps" add column if not exists "reopened_deadline_at" timestamptz null;`)
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_rfps" drop column if exists "reopened_deadline_at";`)
    this.addSql(`drop table if exists "prm_rfp_response_scores" cascade;`)
  }
}
