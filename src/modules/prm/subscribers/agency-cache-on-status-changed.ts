import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `AgencyCacheOnStatusChangedInvalidator` — POST-MVP follow-up wiring
 * SPEC-2026-04-23 agency-foundation §3.1.2 + §3.1.3 + §3.1.4 + §3.2.1.
 *
 * Listens on `prm.agency.status_changed`. Invalidates ALL THREE declared tags:
 *   - `prm:agency:list:tenant:{tenant_id}` — status filter affects B1 list.
 *   - `prm:agency:{agency_id}` — single-agency cache for B2 detail.
 *   - `prm:portal:agency:{agency_id}:status_banner` — status banner copy
 *     changes when status changes (suspended → active etc.).
 *
 * Status changes are the most cache-invalidating Agency event — they affect
 * list filters, detail pages, AND the portal banner that customer users see.
 */
export const metadata = {
  event: 'prm.agency.status_changed',
  persistent: true,
  id: 'prm:agency-cache-on-status-changed',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  tenant_id?: string
  tenantId?: string
  fromStatus?: string
  toStatus?: string
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
        '[prm:agency-cache-on-status-changed] missing agency_id or tenant_id on prm.agency.status_changed payload',
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
    `prm:portal:agency:${agencyId}:status_banner`,
  ])
}
