import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `MarketingLibraryUnpublishedInvalidator` — Spec #7 §4.3.
 *
 * Listens on `prm.marketing_material.unpublished`. Same effect as the
 * published invalidator: invalidate every per-Agency library cache.
 */
export const metadata = {
  event: 'prm.marketing_material.unpublished',
  persistent: true,
  id: 'prm:marketing-library-unpublished-invalidator',
}

type Payload = {
  material_id: string
  organization_id: string
  unpublished_at: string
  unpublished_by_user_id: string
  reason?: string | null
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
