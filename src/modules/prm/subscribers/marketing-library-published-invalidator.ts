import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `MarketingLibraryPublishedInvalidator` — Spec #7 §4.3 (OQ-019 resolution).
 *
 * Listens on `prm.marketing_material.published`. Calls
 * `cache.deleteByTags(['prm:library'])` to invalidate every per-Agency
 * library cache entry — the new material may now be visible to all
 * Agencies at/above min_tier.
 *
 * Per-feature subscriber, not a generic event-to-cache-bust router.
 */
export const metadata = {
  event: 'prm.marketing_material.published',
  persistent: true,
  id: 'prm:marketing-library-published-invalidator',
}

type Payload = {
  material_id: string
  organization_id: string
  visibility: string
  min_tier?: string | null
  published_at: string
}

type ResolverContext = { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  _payload: Payload,
  ctx: ResolverContext,
): Promise<void> {
  let cache: CacheLike | null = null
  try {
    cache = ctx.resolve<CacheLike>('cache')
  } catch {
    return
  }
  await invalidateLibraryCache(cache, ['prm:library'])
}
