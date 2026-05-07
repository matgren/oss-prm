import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `AgencyCacheOnDeletedInvalidator` — POST-MVP follow-up wiring SPEC-2026-04-23
 * agency-foundation §3.1.2 + §3.1.3 + §3.1.4.
 *
 * Listens on `prm.agency.deleted`. Invalidates the tenant-scoped Agency list
 * cache and the single-agency detail cache. Does NOT invalidate the portal
 * status banner — a deleted agency has no portal session left to see it.
 *
 * Note: T0 ships hard delete only when there are no dependents (invariant #4).
 * Once the agency aggregate has children (Phase 2+), delete becomes a
 * soft-delete and this subscriber still applies.
 */
export const metadata = {
  event: 'prm.agency.deleted',
  persistent: true,
  id: 'prm:agency-cache-on-deleted',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  tenant_id?: string
  tenantId?: string
}

type ResolverContext = { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  payload: Payload,
  ctx: ResolverContext,
): Promise<void> {
  const agencyId = payload?.agency_id ?? payload?.agencyId ?? null
  const tenantId = payload?.tenant_id ?? payload?.tenantId ?? null
  if (!agencyId || !tenantId) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        '[prm:agency-cache-on-deleted] missing agency_id or tenant_id on prm.agency.deleted payload',
      )
    }
    return
  }
  let cache: CacheLike | null = null
  try {
    cache = ctx.resolve<CacheLike>('cache')
  } catch {
    return
  }
  await invalidateLibraryCache(cache, [
    `prm:agency:list:tenant:${tenantId}`,
    `prm:agency:${agencyId}`,
  ])
}
