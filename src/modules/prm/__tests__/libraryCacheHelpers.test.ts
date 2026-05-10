/**
 * Unit tests for `lib/libraryCache.ts` helpers — Spec #7 §3.4 / §4.3.
 *
 * These cover the cache-key + tag primitives that the P11 portal route
 * (`cache.set` write-side) and the 4 invalidator subscribers (`cache.deleteByTags`
 * read-side) MUST agree on. A drift here silently breaks invalidation —
 * `@open-mercato/cache.deleteByTags` is exact-string-match, no wildcards.
 */
import {
  LIBRARY_CACHE_TAG,
  LIBRARY_CACHE_TTL_MS,
  agencyTierTag,
  allAgencyTierTags,
  buildLibraryCacheKey,
} from '../lib/libraryCache'

describe('libraryCache helpers', () => {
  describe('LIBRARY_CACHE_TAG / LIBRARY_CACHE_TTL_MS', () => {
    it('exposes the spec-declared universal tag', () => {
      expect(LIBRARY_CACHE_TAG).toBe('prm:library')
    })

    it('exposes the spec-declared 15-minute TTL', () => {
      expect(LIBRARY_CACHE_TTL_MS).toBe(15 * 60 * 1000)
    })
  })

  describe('agencyTierTag', () => {
    it('renders `prm:agency:${agencyId}:tier:${tier}` for a known tier', () => {
      expect(agencyTierTag('agency-A', 'om_agency')).toBe('prm:agency:agency-A:tier:om_agency')
      expect(agencyTierTag('agency-A', 'ai_native')).toBe('prm:agency:agency-A:tier:ai_native')
      expect(agencyTierTag('agency-A', 'ai_native_expert')).toBe(
        'prm:agency:agency-A:tier:ai_native_expert',
      )
      expect(agencyTierTag('agency-A', 'ai_native_core')).toBe(
        'prm:agency:agency-A:tier:ai_native_core',
      )
    })

    it('renders `:tier:null` when tier is null/undefined/unknown', () => {
      expect(agencyTierTag('agency-A', null)).toBe('prm:agency:agency-A:tier:null')
      expect(agencyTierTag('agency-A', undefined)).toBe('prm:agency:agency-A:tier:null')
      // Unknown tier strings collapse to `null` rather than leaking to the tag
      // namespace.
      expect(agencyTierTag('agency-A', 'something_invalid')).toBe(
        'prm:agency:agency-A:tier:null',
      )
    })
  })

  describe('allAgencyTierTags', () => {
    it('returns every known tier + the null form for an agency', () => {
      const tags = allAgencyTierTags('agency-A')
      expect(tags).toEqual([
        'prm:agency:agency-A:tier:om_agency',
        'prm:agency:agency-A:tier:ai_native',
        'prm:agency:agency-A:tier:ai_native_expert',
        'prm:agency:agency-A:tier:ai_native_core',
        'prm:agency:agency-A:tier:null',
      ])
    })

    it('produces 5 distinct tags', () => {
      const tags = allAgencyTierTags('agency-X')
      expect(new Set(tags).size).toBe(tags.length)
      expect(tags.length).toBe(5)
    })
  })

  describe('buildLibraryCacheKey', () => {
    const baseParams = {
      orgId: 'org-1',
      agencyId: 'agency-1',
      tier: 'ai_native' as string | null,
      params: {
        page: 1,
        pageSize: 50,
        materialType: undefined,
        topics: undefined,
        viewerRoleSlugs: undefined,
      },
    }

    it('produces the same key for identical input', () => {
      expect(buildLibraryCacheKey(baseParams)).toBe(buildLibraryCacheKey(baseParams))
    })

    it('is deterministic across topic/role-slug array ordering', () => {
      const a = buildLibraryCacheKey({
        ...baseParams,
        params: {
          ...baseParams.params,
          topics: ['ai', 'devops'],
          viewerRoleSlugs: ['partner_admin', 'partner_member'],
        },
      })
      const b = buildLibraryCacheKey({
        ...baseParams,
        params: {
          ...baseParams.params,
          topics: ['devops', 'ai'],
          viewerRoleSlugs: ['partner_member', 'partner_admin'],
        },
      })
      expect(a).toBe(b)
    })

    it('differs when agencyId changes', () => {
      expect(buildLibraryCacheKey(baseParams)).not.toBe(
        buildLibraryCacheKey({ ...baseParams, agencyId: 'agency-2' }),
      )
    })

    it('differs when tier changes', () => {
      expect(buildLibraryCacheKey(baseParams)).not.toBe(
        buildLibraryCacheKey({ ...baseParams, tier: 'ai_native_expert' }),
      )
    })

    it('differs when orgId changes', () => {
      expect(buildLibraryCacheKey(baseParams)).not.toBe(
        buildLibraryCacheKey({ ...baseParams, orgId: 'org-2' }),
      )
    })

    it('differs when materialType / topics / viewerRoleSlugs change', () => {
      const base = buildLibraryCacheKey(baseParams)
      expect(base).not.toBe(
        buildLibraryCacheKey({
          ...baseParams,
          params: { ...baseParams.params, materialType: 'playbook' },
        }),
      )
      expect(base).not.toBe(
        buildLibraryCacheKey({
          ...baseParams,
          params: { ...baseParams.params, topics: ['ai'] },
        }),
      )
      expect(base).not.toBe(
        buildLibraryCacheKey({
          ...baseParams,
          params: { ...baseParams.params, viewerRoleSlugs: ['partner_admin'] },
        }),
      )
    })

    it('differs when pagination changes', () => {
      const base = buildLibraryCacheKey(baseParams)
      expect(base).not.toBe(
        buildLibraryCacheKey({ ...baseParams, params: { ...baseParams.params, page: 2 } }),
      )
      expect(base).not.toBe(
        buildLibraryCacheKey({ ...baseParams, params: { ...baseParams.params, pageSize: 25 } }),
      )
    })

    it('encodes a null tier as `null` segment in the key', () => {
      const key = buildLibraryCacheKey({ ...baseParams, tier: null })
      expect(key).toMatch(/^prm:portal:library:org-1:agency-1:null:/)
    })
  })
})
