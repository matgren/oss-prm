import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `AgencyCacheOnTierChangedInvalidator` — POST-MVP follow-up wiring
 * SPEC-2026-04-23 agency-foundation §3.1.2 + §3.1.3 + §3.1.4.
 *
 * Listens on `prm.agency.tier_changed`. Invalidates two tags:
 *   - `prm:agency:list:tenant:{tenant_id}` — tier appears in B1 list filter/sort.
 *   - `prm:agency:{agency_id}` — single-agency cache for B2 detail.
 *
 * Does NOT touch `prm:portal:agency:{id}:status_banner` — tier change is
 * invisible in the portal status banner copy (banner reflects status +
 * onboarding flags only, per §3.2.1).
 *
 * Note: a separate `agency-tier-change-library-invalidator.ts` already exists
 * and invalidates the per-Agency MARKETING LIBRARY cache (`prm:agency:{id}:tier:*`).
 * This new subscriber is concerned with the AGENCY-LIST + AGENCY-DETAIL caches
 * declared in Spec #1 §3.1.2-§3.1.4 — orthogonal tag namespaces, both correct.
 */
export const metadata = {
  event: 'prm.agency.tier_changed',
  persistent: true,
  id: 'prm:agency-cache-on-tier-changed',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  tenant_id?: string
  tenantId?: string
  fromTier?: string
  toTier?: string
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
        '[prm:agency-cache-on-tier-changed] missing agency_id or tenant_id on prm.agency.tier_changed payload',
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
