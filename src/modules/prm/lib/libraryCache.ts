/**
 * Shared cache helpers for the P11 portal Marketing Library
 * (Spec #7 §3.4 / §4.3 / OQ-019 resolution).
 *
 * Two responsibilities:
 *
 *   1. Soft-fail invalidation API (`invalidateLibraryCache`) used by the four
 *      cache-invalidator subscribers. Failure is non-fatal — the 15-min TTL
 *      serves as the fallback per spec §8.4.
 *
 *   2. Read-side cache-key + tag + TTL primitives consumed by
 *      `api/portal/library/route.ts` so the cache.set side actually writes
 *      against the same tag set the invalidators delete by.
 *
 * `@open-mercato/cache` `deleteByTags` is **exact-string match** against
 * sha1-hashed tags — wildcards are NOT supported. Any tag-set drift between
 * writers and invalidators silently breaks invalidation. The constants and
 * helpers here are the single source of truth for the tag scheme.
 */
import { createHash } from 'node:crypto'
import { AGENCY_TIERS, type AgencyTier } from '../data/validators'

export type CacheLike = {
  get?: (key: string) => Promise<unknown>
  set?: (
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[] },
  ) => Promise<unknown>
  deleteByTags?: (tags: string[]) => Promise<unknown>
}

/** Universal tag — invalidates every cached portal-library response. */
export const LIBRARY_CACHE_TAG = 'prm:library'

/** TTL per spec §3.4 — 15 minutes. */
export const LIBRARY_CACHE_TTL_MS = 15 * 60 * 1000

/**
 * Per-(agency, tier) tag — written alongside `LIBRARY_CACHE_TAG` so a tier
 * change can target a single agency without flushing the whole library.
 */
export function agencyTierTag(agencyId: string, tier: string | null | undefined): string {
  // We always include the literal `null` form when an agency has no tier
  // assigned — keeps the tag space deterministic.
  const tierKey = tier && (AGENCY_TIERS as readonly string[]).includes(tier) ? tier : 'null'
  return `prm:agency:${agencyId}:tier:${tierKey}`
}

/**
 * Enumerated list of every per-tier tag for a given agency.
 *
 * Used by `agency-tier-change-library-invalidator` — when an Agency's tier
 * changes we don't necessarily know the prior tier, and `deleteByTags` is
 * NOT wildcard-aware, so we issue all 4 tags + the `null` form. Bounded set
 * (5 tags), one round-trip, no fan-out concerns.
 *
 * If a 5th tier ever lands in `data/validators.ts` AGENCY_TIERS, this list
 * regenerates automatically — no hand-update needed.
 */
export function allAgencyTierTags(agencyId: string): string[] {
  const tags = (AGENCY_TIERS as readonly AgencyTier[]).map((t) => agencyTierTag(agencyId, t))
  tags.push(agencyTierTag(agencyId, null))
  return tags
}

/**
 * Canonical params used in the cache-key hash. The route's parsed query
 * shape (page, pageSize, materialType, topics[]) plus the viewer's role
 * slugs so role-gated content does not bleed across roles within one
 * agency+tier cache namespace.
 *
 * Arrays are sorted before hashing so query-string array-order doesn't
 * fracture the cache (e.g. `?topics=a&topics=b` and `?topics=b&topics=a`
 * MUST be the same key).
 */
export type LibraryCacheKeyParams = {
  page: number
  pageSize: number
  materialType?: string | null | undefined
  topics?: readonly string[] | null | undefined
  viewerRoleSlugs?: readonly string[] | null | undefined
}

/**
 * Build the deterministic cache key for a library list response.
 *
 * Shape:
 *   `prm:portal:library:${orgId}:${agencyId}:${tier|null}:${sha1(params)}`
 *
 * `orgId` is included for defense-in-depth even though `@open-mercato/cache`
 * tenant-namespaces all keys via `runWithCacheTenant`. Belt + suspenders.
 */
export function buildLibraryCacheKey(input: {
  orgId: string
  agencyId: string
  tier: string | null
  params: LibraryCacheKeyParams
}): string {
  const { orgId, agencyId, tier, params } = input
  const canonical = {
    page: params.page,
    pageSize: params.pageSize,
    materialType: params.materialType ?? null,
    topics: [...(params.topics ?? [])].sort(),
    viewerRoleSlugs: [...(params.viewerRoleSlugs ?? [])].sort(),
  }
  const hash = createHash('sha1').update(JSON.stringify(canonical)).digest('hex')
  const tierKey = tier ?? 'null'
  return `prm:portal:library:${orgId}:${agencyId}:${tierKey}:${hash}`
}

/**
 * Soft-fail tag invalidation used by the 4 cache invalidator subscribers
 * (spec §4.3). Failure is non-fatal — the 15-min TTL is the fallback.
 */
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
