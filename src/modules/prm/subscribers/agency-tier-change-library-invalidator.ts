import {
  allAgencyTierTags,
  invalidateLibraryCache,
  type CacheLike,
} from '../lib/libraryCache'

/**
 * `AgencyTierChangeLibraryInvalidator` — Spec #7 §4.3.
 *
 * Listens on `prm.agency.tier_changed` (Spec #1). When an Agency's tier
 * changes, the library cache for that Agency must be invalidated — the
 * visibility set may change. Tag invalidation is targeted to the Agency.
 *
 * `@open-mercato/cache.deleteByTags` does NOT support wildcards; tags are
 * sha1-hashed and exact-matched. We enumerate every known tier tag for the
 * agency (via `allAgencyTierTags`) so the subscriber works regardless of
 * whether the payload carries the prior `fromTier`/`toTier` fields.
 *
 * Per spec §8.5 mitigation: the payload assertion is loud — if `agency_id`
 * is missing the subscriber throws (in non-production mode) so a Spec #1
 * payload-shape drift gets caught at integration test time.
 */
export const metadata = {
  event: 'prm.agency.tier_changed',
  persistent: true,
  id: 'prm:agency-tier-change-library-invalidator',
}

type Payload = {
  agency_id?: string
  agencyId?: string
  fromTier?: string
  toTier?: string
  organization_id?: string
  organizationId?: string
}

type ResolverContext = { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  payload: Payload,
  ctx: ResolverContext,
): Promise<void> {
  const agencyId = payload?.agency_id ?? payload?.agencyId ?? null
  if (!agencyId) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        '[prm:agency-tier-change-library-invalidator] missing agency_id on prm.agency.tier_changed payload',
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
  await invalidateLibraryCache(cache, allAgencyTierTags(agencyId))
}
