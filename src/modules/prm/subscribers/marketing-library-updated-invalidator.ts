import type { EntityManager } from '@mikro-orm/postgresql'
import { MarketingMaterial } from '../data/entities'
import { invalidateLibraryCache, type CacheLike } from '../lib/libraryCache'

/**
 * `MarketingLibraryUpdatedInvalidator` — Spec #7 §4.3.
 *
 * Listens on `prm.marketing_material.updated`. Reads the aggregate;
 * if currently published (`published_at IS NOT NULL AND unpublished_at
 * IS NULL`) → invalidate `['prm:library']`. Otherwise → no-op (a draft
 * edit shouldn't bust the cache).
 */
export const metadata = {
  event: 'prm.marketing_material.updated',
  persistent: true,
  id: 'prm:marketing-library-updated-invalidator',
}

type Payload = {
  material_id: string
  organization_id: string
  material_type: string
  visibility: string
  min_tier?: string | null
}

type ResolverContext = { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  payload: Payload,
  ctx: ResolverContext,
): Promise<void> {
  if (!payload?.material_id) return

  let em: EntityManager
  try {
    em = ctx.resolve<EntityManager>('em')
  } catch {
    return
  }
  let material: MarketingMaterial | null = null
  try {
    material = await em.findOne(MarketingMaterial, {
      id: payload.material_id,
      organizationId: payload.organization_id,
    } as any)
  } catch {
    return
  }
  if (!material) return
  const isCurrentlyPublished = !!material.publishedAt && !material.unpublishedAt
  if (!isCurrentlyPublished) return

  let cache: CacheLike | null = null
  try {
    cache = ctx.resolve<CacheLike>('cache')
  } catch {
    return
  }
  await invalidateLibraryCache(cache, ['prm:library'])
}
