import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #6 — non-decorator-expressible structures for the
 * `RfpResponseScore` aggregate + the additive `reopened` status enum
 * extension on `prm_rfps`.
 *
 * Mirrors the existing two-migration split. Additive only.
 *
 *   - Score-range CHECKs (0..5).
 *   - Source enum CHECK (`manual` / `llm_assisted`).
 *   - Cross-field CHECK: `source = 'llm_assisted'` iff `llm_model_id` non-null.
 *   - FKs to `prm_rfp_responses`, `directory_organizations`.
 *   - Composite index `(rfp_response_id, version desc)` for "latest score" reads.
 *   - Replace `prm_rfps_status_check` with the extended enum
 *     (`draft` / `published` / `scoring` / `selection_made` / `closed` /
 *     `reopened`).
 *   - Index `prm_rfps_reopened_deadline_idx` on the new column for the
 *     scheduled deadline-expiry worker.
 *
 * Note: we DROP the old `prm_rfps_status_check` constraint and re-create it
 * with the new enum value. Because `reopened` is not yet present in any
 * row, this is a safe additive change.
 */
export class Migration20260507100001_prm_rfp_score_indexes extends Migration {
  override async up(): Promise<void> {
    // Score-range CHECKs.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_tech_fit_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_tech_fit_check" check ("tech_fit_score" between 0 and 5); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_domain_fit_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_domain_fit_check" check ("domain_fit_score" between 0 and 5); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_optional_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_optional_check" check ("optional_score" is null or "optional_score" between 0 and 5); end if; end $$;`,
    )
    // Source enum.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_source_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_source_check" check ("source" in ('manual','llm_assisted')); end if; end $$;`,
    )
    // Cross-field: llm_model_id required iff source = 'llm_assisted'.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_llm_pairing_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_llm_pairing_check" check ((source = 'manual' and "llm_model_id" is null) or (source = 'llm_assisted' and "llm_model_id" is not null)); end if; end $$;`,
    )
    // Reasoning min-length CHECK (defence-in-depth — Zod enforces 10 chars).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_reasoning_minlen_check') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_reasoning_minlen_check" check (char_length("reasoning") >= 10); end if; end $$;`,
    )
    // FKs.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_organization_fk') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_organization_fk" foreign key ("organization_id") references "directory_organizations" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_rfp_response_scores_response_fk') then alter table "prm_rfp_response_scores" add constraint "prm_rfp_response_scores_response_fk" foreign key ("rfp_response_id") references "prm_rfp_responses" ("id") on delete restrict; end if; end $$;`,
    )
    // Latest-score read hot path.
    this.addSql(
      `create index if not exists "prm_rfp_response_scores_response_version_idx" on "prm_rfp_response_scores" ("rfp_response_id", "version" desc);`,
    )

    // Extend prm_rfps.status enum to include 'reopened' (additive).
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_status_check";`)
    this.addSql(
      `alter table "prm_rfps" add constraint "prm_rfps_status_check" check ("status" in ('draft','published','scoring','selection_made','closed','reopened'));`,
    )
    // Index for the scheduled deadline-expiry worker.
    this.addSql(
      `create index if not exists "prm_rfps_reopened_deadline_idx" on "prm_rfps" ("reopened_deadline_at") where "deleted_at" is null and "reopened_deadline_at" is not null;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "prm_rfps_reopened_deadline_idx";`)
    // Restore the original (Spec #5) enum.
    this.addSql(`alter table "prm_rfps" drop constraint if exists "prm_rfps_status_check";`)
    this.addSql(
      `alter table "prm_rfps" add constraint "prm_rfps_status_check" check ("status" in ('draft','published','scoring','selection_made','closed'));`,
    )
    this.addSql(`drop index if exists "prm_rfp_response_scores_response_version_idx";`)
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_response_fk";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_organization_fk";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_reasoning_minlen_check";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_llm_pairing_check";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_source_check";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_optional_check";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_domain_fit_check";`,
    )
    this.addSql(
      `alter table "prm_rfp_response_scores" drop constraint if exists "prm_rfp_response_scores_tech_fit_check";`,
    )
  }
}
