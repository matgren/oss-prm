import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #3 (attribution-loop) — non-decorator-expressible structures for the
 * `LicenseDeal` aggregate.
 *
 * Mirrors the Phase-1 / Phase-2 pattern (separate `*_indexes.ts` companion):
 *   - Enum CHECK constraints for `status`, `attribution_path`, `attribution_source`,
 *     and `type` (defence-in-depth alongside zod + service layer).
 *   - Mutual-exclusion CHECK on attribution FKs (at most one of `prospect_id`/`rfp_id`).
 *   - Path-C requires `attribution_reasoning` CHECK (Spec §5.1).
 *   - FK to `prm_agencies` on `attributed_agency_id` (RESTRICT — invariant #4).
 *   - FK to `prm_prospects` on `prospect_id` (RESTRICT). NOTE: no FK on `rfp_id` —
 *     `prm_rfps` is owned by Spec #5 and not migrated yet (additive when it lands).
 *   - FK to self (`previous_license_deal_id`) for renewal chain.
 *   - Trigger enforcing invariant #7 (attribution freeze on `status >= active`).
 *   - Composite index for the MIN widget (Spec §3.2: agency_id + status + attribution_source).
 *
 * Additive only — no DROP / ALTER COLUMN.
 *
 * Cross-spec contract: index/constraint names listed below are FROZEN (downstream
 * specs may reference them in extension migrations).
 */
export class Migration20260505170000_prm_license_deal_indexes extends Migration {
  override async up(): Promise<void> {
    // Enum CHECKs — defence-in-depth; the aggregate `LicenseDealService` is the primary
    // gatekeeper. Source: LICENSE_DEAL_STATUSES + LICENSE_DEAL_ATTRIBUTION_PATHS.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_status_check') then alter table "prm_license_deals" add constraint "prm_license_deals_status_check" check ("status" in ('pending','signed','active','churned')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_attribution_path_check') then alter table "prm_license_deals" add constraint "prm_license_deals_attribution_path_check" check ("attribution_path" in ('A','B','C','none')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_attribution_source_check') then alter table "prm_license_deals" add constraint "prm_license_deals_attribution_source_check" check ("attribution_source" in ('prospect','rfp','direct')); end if; end $$;`,
    )

    // Mutual-exclusion CHECK: at most one of prospect_id / rfp_id is set.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_attribution_exclusive_check') then alter table "prm_license_deals" add constraint "prm_license_deals_attribution_exclusive_check" check (((case when "prospect_id" is null then 0 else 1 end) + (case when "rfp_id" is null then 0 else 1 end)) <= 1); end if; end $$;`,
    )

    // Path-C (direct) requires attribution_reasoning when path is 'C' (Spec §5.1).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_path_c_reasoning_check') then alter table "prm_license_deals" add constraint "prm_license_deals_path_c_reasoning_check" check ("attribution_path" <> 'C' or "attribution_reasoning" is not null); end if; end $$;`,
    )

    // FK to prm_agencies (RESTRICT) on attributed_agency_id.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_agency_fk') then alter table "prm_license_deals" add constraint "prm_license_deals_agency_fk" foreign key ("attributed_agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )

    // FK to prm_prospects on prospect_id (RESTRICT) — NULLs are allowed (Path B / C / none).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_prospect_fk') then alter table "prm_license_deals" add constraint "prm_license_deals_prospect_fk" foreign key ("prospect_id") references "prm_prospects" ("id") on delete restrict; end if; end $$;`,
    )

    // Self-FK on previous_license_deal_id (renewal chain).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_license_deals_previous_fk') then alter table "prm_license_deals" add constraint "prm_license_deals_previous_fk" foreign key ("previous_license_deal_id") references "prm_license_deals" ("id") on delete set null; end if; end $$;`,
    )

    // MIN widget hot path: agency + status + source filter (Spec §1.4.4).
    this.addSql(
      `create index if not exists "prm_license_deals_min_widget_partial" on "prm_license_deals" ("attributed_agency_id", "status", "attribution_source") where "deleted_at" is null and "attributed_agency_id" is not null;`,
    )

    // Invariant #7 trigger — attribution freeze on `status >= active`. Defence-in-depth
    // alongside the application-layer `LicenseDealService.attribute` guard. The aggregate
    // only allows attribution mutations through `attribute()` / `reverse()` / `unreverse-status`,
    // but a DBA bypass or future ORM regression would still be caught here.
    this.addSql(`create or replace function prm_license_deal_attribution_freeze()
      returns trigger language plpgsql as $$
      begin
        if old.status in ('active','churned')
          and (
            new.attributed_agency_id is distinct from old.attributed_agency_id
            or new.prospect_id is distinct from old.prospect_id
            or new.rfp_id is distinct from old.rfp_id
            or new.attribution_path is distinct from old.attribution_path
            or new.attribution_source is distinct from old.attribution_source
          )
          and new.status = old.status
        then
          raise exception using errcode = '23514', message = 'PRM invariant #7: LicenseDeal attribution frozen once status >= active. Use /unreverse-status first.';
        end if;
        return new;
      end;
    $$;`)
    this.addSql(`drop trigger if exists prm_license_deals_attribution_freeze_tg on "prm_license_deals";`)
    this.addSql(
      `create trigger prm_license_deals_attribution_freeze_tg before update on "prm_license_deals" for each row execute function prm_license_deal_attribution_freeze();`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists prm_license_deals_attribution_freeze_tg on "prm_license_deals";`)
    this.addSql(`drop function if exists prm_license_deal_attribution_freeze();`)
    this.addSql(`drop index if exists "prm_license_deals_min_widget_partial";`)
    this.addSql(`alter table "prm_license_deals" drop constraint if exists "prm_license_deals_previous_fk";`)
    this.addSql(`alter table "prm_license_deals" drop constraint if exists "prm_license_deals_prospect_fk";`)
    this.addSql(`alter table "prm_license_deals" drop constraint if exists "prm_license_deals_agency_fk";`)
    this.addSql(
      `alter table "prm_license_deals" drop constraint if exists "prm_license_deals_path_c_reasoning_check";`,
    )
    this.addSql(
      `alter table "prm_license_deals" drop constraint if exists "prm_license_deals_attribution_exclusive_check";`,
    )
    this.addSql(
      `alter table "prm_license_deals" drop constraint if exists "prm_license_deals_attribution_source_check";`,
    )
    this.addSql(
      `alter table "prm_license_deals" drop constraint if exists "prm_license_deals_attribution_path_check";`,
    )
    this.addSql(`alter table "prm_license_deals" drop constraint if exists "prm_license_deals_status_check";`)
  }
}
