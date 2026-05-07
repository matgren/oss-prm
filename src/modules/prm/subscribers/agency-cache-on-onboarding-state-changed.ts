import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `AgencyCacheOnOnboardingStateChangedInvalidator` — POST-MVP follow-up wiring
 * SPEC-2026-04-23 agency-foundation §3.1.2 + §3.1.3 + §3.1.4 + §3.2.1.
 *
 * Listens on `prm.agency.onboarding_state_changed`. Invalidates ALL THREE
 * declared tags — onboarding flags (`contract_signed` / `nda_signed` /
 * `onboarded`) appear in B1 filters, B2 detail, and the portal status banner.
 */
export const metadata = {
  event: 'prm.agency.onboarding_state_changed',
  persistent: true,
  id: 'prm:agency-cache-on-onboarding-state-changed',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  tenant_id?: string
  tenantId?: string
  contractSigned?: boolean
  ndaSigned?: boolean
  onboarded?: boolean
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
        '[prm:agency-cache-on-onboarding-state-changed] missing agency_id or tenant_id on prm.agency.onboarding_state_changed payload',
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
