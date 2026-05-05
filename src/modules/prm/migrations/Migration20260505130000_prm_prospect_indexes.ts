import { Migration } from '@mikro-orm/migrations'

/**
 * PRM Spec #2 (wip-scoreboard) — non-decorator-expressible structures for the
 * Prospect aggregate.
 *
 * Mirrors the Phase-1 pattern (`Migration20260505100000_prm_indexes.ts`):
 *   - Enum CHECK constraints for `source`, `status`, `lost_reason` (defence-in-depth
 *     alongside zod and the aggregate state machine).
 *   - FK constraint to `prm_agencies` (RESTRICT — invariant #4).
 *   - Composite index for the WIP widget hot path (monthly aggregate per agency).
 *   - Trigger enforcing `registered_at` immutability (invariant #1, defence-in-depth).
 *
 * Additive only — no DROP / ALTER COLUMN.
 *
 * Cross-spec contract: index names listed below are FROZEN (downstream specs may
 * reference them in extension migrations).
 */
export class Migration20260505130000_prm_prospect_indexes extends Migration {
  override async up(): Promise<void> {
    // Enum CHECKs — defence-in-depth; the aggregate state machine is the primary
    // gatekeeper. Source: PROSPECT_SOURCES + PROSPECT_STATUSES in data/validators.ts.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospects_source_check') then alter table "prm_prospects" add constraint "prm_prospects_source_check" check ("source" in ('agency_owned','event','other')); end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospects_status_check') then alter table "prm_prospects" add constraint "prm_prospects_status_check" check ("status" in ('new','qualified','contacted','won','lost','dormant')); end if; end $$;`,
    )
    // `lost_reason` is required iff status = 'lost'.
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospects_lost_reason_check') then alter table "prm_prospects" add constraint "prm_prospects_lost_reason_check" check ("status" <> 'lost' or ("lost_reason" is not null and char_length("lost_reason") >= 10)); end if; end $$;`,
    )

    // FK to prm_agencies — RESTRICT prevents accidental cascade-delete (invariant #4).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospects_agency_fk') then alter table "prm_prospects" add constraint "prm_prospects_agency_fk" foreign key ("agency_id") references "prm_agencies" ("id") on delete restrict; end if; end $$;`,
    )
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospects_member_fk') then alter table "prm_prospects" add constraint "prm_prospects_member_fk" foreign key ("registered_by_agency_member_id") references "prm_agency_members" ("id") on delete restrict; end if; end $$;`,
    )

    // Projection FK + cascade (when the aggregate is hard-deleted, the index follows).
    this.addSql(
      `do $$ begin if not exists (select 1 from pg_constraint where conname = 'prm_prospect_candidate_index_prospect_fk') then alter table "prm_prospect_candidate_index" add constraint "prm_prospect_candidate_index_prospect_fk" foreign key ("prospect_id") references "prm_prospects" ("id") on delete cascade; end if; end $$;`,
    )

    // WIP widget hot path: filtered partial index for live + agency-owned + non-lost rows
    // (invariant #14 — WIP filter is `source = 'agency_owned' AND status NOT IN ('lost')`).
    this.addSql(
      `create index if not exists "prm_prospects_wip_partial" on "prm_prospects" ("organization_id", "agency_id", "registered_at" desc) where "deleted_at" is null and "source" = 'agency_owned' and "status" <> 'lost';`,
    )
    // Portal list default sort (registered_at DESC, id DESC).
    this.addSql(
      `create index if not exists "prm_prospects_portal_list" on "prm_prospects" ("organization_id", "agency_id", "registered_at" desc, "id" desc) where "deleted_at" is null;`,
    )

    // Invariant #1 — `registered_at` IMMUTABLE after INSERT. Defence-in-depth trigger.
    // The aggregate (`ProspectService.update`) ignores `registered_at` patches, but a DBA
    // bypass or future ORM migration regression would still be caught here.
    this.addSql(`create or replace function prm_prospect_registered_at_immutable()
      returns trigger language plpgsql as $$
      begin
        if old.registered_at is distinct from new.registered_at then
          raise exception using errcode = '23514', message = 'prm_prospects.registered_at is immutable (PRM invariant #1)';
        end if;
        return new;
      end;
    $$;`)
    this.addSql(`drop trigger if exists prm_prospects_registered_at_immutable_tg on "prm_prospects";`)
    this.addSql(
      `create trigger prm_prospects_registered_at_immutable_tg before update on "prm_prospects" for each row execute function prm_prospect_registered_at_immutable();`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists prm_prospects_registered_at_immutable_tg on "prm_prospects";`)
    this.addSql(`drop function if exists prm_prospect_registered_at_immutable();`)
    this.addSql(`drop index if exists "prm_prospects_portal_list";`)
    this.addSql(`drop index if exists "prm_prospects_wip_partial";`)
    this.addSql(`alter table "prm_prospect_candidate_index" drop constraint if exists "prm_prospect_candidate_index_prospect_fk";`)
    this.addSql(`alter table "prm_prospects" drop constraint if exists "prm_prospects_member_fk";`)
    this.addSql(`alter table "prm_prospects" drop constraint if exists "prm_prospects_agency_fk";`)
    this.addSql(`alter table "prm_prospects" drop constraint if exists "prm_prospects_lost_reason_check";`)
    this.addSql(`alter table "prm_prospects" drop constraint if exists "prm_prospects_status_check";`)
    this.addSql(`alter table "prm_prospects" drop constraint if exists "prm_prospects_source_check";`)
  }
}
