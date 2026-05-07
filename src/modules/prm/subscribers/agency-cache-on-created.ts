import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `AgencyCacheOnCreatedInvalidator` — POST-MVP follow-up wiring SPEC-2026-04-23
 * agency-foundation §3.1.2.
 *
 * Listens on `prm.agency.created`. Invalidates the tenant-scoped Agency list
 * cache so the new Agency is visible immediately on the next B1 list load.
 *
 * Per the existing `agency-tier-change-library-invalidator` pattern: payload
 * assertion is loud — if `tenant_id` is missing the subscriber throws (in
 * non-production) so a Spec #1 payload-shape drift gets caught at integration
 * test time. Production silently no-ops to avoid taking the worker down on a
 * single bad event.
 *
 * Single-purpose: this subscriber does NOT touch `prm:agency:{id}` (no entry
 * exists for a brand-new id) or the portal status banner (no portal session
 * yet for the agency that was just created).
 */
export const metadata = {
  event: 'prm.agency.created',
  persistent: true,
  id: 'prm:agency-cache-on-created',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  tenant_id?: string
  tenantId?: string
  organization_id?: string
  organizationId?: string
}

type ResolverContext = { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  payload: Payload,
  ctx: ResolverContext,
): Promise<void> {
  const tenantId = payload?.tenant_id ?? payload?.tenantId ?? null
  if (!tenantId) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        '[prm:agency-cache-on-created] missing tenant_id on prm.agency.created payload',
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
  await invalidateLibraryCache(cache, [`prm:agency:list:tenant:${tenantId}`])
}
