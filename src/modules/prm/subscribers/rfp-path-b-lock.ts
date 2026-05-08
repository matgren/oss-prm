import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * RFP Path-B lock subscriber (Spec #3 — attribution-loop, §8.4 cross-spec contract).
 *
 * Maintains the `prm_rfps.is_path_b_locked` read-model column written by Spec #3
 * and read+enforced by Spec #6. The migration that adds the column lives in
 * Spec #5 (rfp-broadcast-response). Until that migration lands the column does
 * not exist — this subscriber detects that case at runtime via `to_regclass` +
 * `information_schema.columns` introspection (same pattern T1 introduced in
 * `api/portal/dashboard/route.ts` for the WIC table). When the column is absent
 * we no-op + log a debug line so the writer activates automatically once Spec #5
 * ships, with zero PRM-side change.
 *
 * Lock semantics (§8.6 decision):
 *   - lock = TRUE when ANY LicenseDeal has `attribution_path = 'B' AND rfp_id = X
 *     AND status IN ('signed','active')`.
 *   - lock = FALSE otherwise (including when the lone Path-B deal moves to
 *     `pending` via /unreverse-status, releasing the RFP for re-selection).
 *
 * Scope-column note: `prm_license_deals` carries `tenant_id`, but `prm_rfps`
 * scopes by `organization_id` only (no tenant_id column on that table — see
 * `data/entities.ts` Rfp + `Migration20260506224953_prm_rfp.ts`). Both scope
 * columns must be sourced from the event payload.
 *
 * This subscriber is the SOLE writer for `is_path_b_locked` per Singularity Law.
 */
export const metadata = {
  event: 'prm.license_deal.status_changed',
  persistent: true,
  id: 'prm:rfp-path-b-lock',
}

type StatusChangedPayload = {
  licenseDealId?: string
  tenantId?: string
  organizationId?: string
  attributionPath?: 'A' | 'B' | 'C' | 'none'
  attributionSource?: 'prospect' | 'rfp' | 'direct'
  rfpId?: string | null
  fromStatus?: string
  toStatus?: string
}

export default async function handle(
  payload: StatusChangedPayload,
  ctx: { resolve: <T = unknown>(name: string) => T },
): Promise<void> {
  if (!payload?.tenantId || !payload?.organizationId || !payload?.rfpId) return
  // Only interested in Path B transitions — other paths can't affect the RFP lock.
  if (payload.attributionPath !== 'B') return

  let em: EntityManager
  try {
    em = ctx.resolve<EntityManager>('em')
  } catch (err) {
    // No DI scope — nothing we can do; the wildcard event runtime will retry.
    console.warn('[prm:rfp-path-b-lock] em resolve failed', err)
    return
  }

  const knex = em.getKnex()

  // Step 1 — table presence check (deferred Spec #5 dependency).
  let tableExists = false
  let columnExists = false
  try {
    const reg = (await knex.raw(`select to_regclass('public.prm_rfps') as oid`)) as {
      rows: Array<{ oid: string | null }>
    }
    tableExists = !!reg.rows?.[0]?.oid
    if (tableExists) {
      const cols = (await knex.raw(
        `select column_name from information_schema.columns where table_name = 'prm_rfps' and column_name = 'is_path_b_locked'`,
      )) as { rows: Array<{ column_name: string }> }
      columnExists = (cols.rows ?? []).length > 0
    }
  } catch (err) {
    // Introspection failed — log and bail; we cannot know the schema state.
    console.warn('[prm:rfp-path-b-lock] schema introspection failed', err)
    return
  }

  if (!tableExists || !columnExists) {
    // Spec #5 hasn't migrated yet — defer silently. When Spec #5 ships and the
    // column appears, the next status_changed event will activate the writer.
    return
  }

  // Step 2 — recompute the lock state for this RFP.
  // The writer is the SOLE source of truth: count signed+active Path-B deals for
  // this RFP; if any exist → lock = true; else → false. This is idempotent per
  // event delivery. `prm_license_deals` is tenant-scoped.
  const liveCount = (await knex('prm_license_deals')
    .where('rfp_id', payload.rfpId)
    .where('tenant_id', payload.tenantId)
    .where('attribution_path', 'B')
    .whereIn('status', ['signed', 'active'])
    .whereNull('deleted_at')
    .count<{ c: string }[]>('* as c')) as Array<{ c: string }>

  const shouldLock = Number(liveCount[0]?.c ?? 0) > 0

  // `prm_rfps` is organization-scoped (no tenant_id column).
  await knex('prm_rfps')
    .where('id', payload.rfpId)
    .where('organization_id', payload.organizationId)
    .update({ is_path_b_locked: shouldLock, updated_at: new Date() })
}
