/**
 * Shared helper for the four cache invalidator subscribers (Spec #7 §4.3 /
 * OQ-019 resolution).
 *
 * Resolves `cache` from the request DI container and calls `deleteByTags`
 * if the cache implementation exposes that method. Failure is non-fatal —
 * the 15-min TTL serves as the fallback per spec §8.4.
 */
export type CacheLike = {
  deleteByTags?: (tags: string[]) => Promise<unknown>
}

export async function invalidateLibraryCache(
  cache: CacheLike | null | undefined,
  tags: string[],
): Promise<void> {
  if (!cache || typeof cache.deleteByTags !== 'function') return
  try {
    await cache.deleteByTags(tags)
  } catch (err) {
    // Soft-fail per spec §8.4 — TTL is the final fallback.
    if (typeof console !== 'undefined') {
      console.warn('[prm:library-cache-invalidate] failed', err)
    }
  }
}
