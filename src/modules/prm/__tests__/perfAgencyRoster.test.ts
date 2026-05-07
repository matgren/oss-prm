import {
  buildPerfAgencyRoster,
  tierCountsForSize,
} from '../testing/fixtures/perfAgencyRoster'
import { AGENCY_TIERS } from '../data/validators'

/**
 * Unit tests for the 500-agency roster generator (Spec #5 §9.6 perf-smoke
 * support). The integration test exercises the wall-clock end-to-end, but
 * the shape contract — counts, eligibility math, slug/UUID validity, JSON
 * column shape — must be airtight before we trust the smoke's assertions.
 */
describe('tierCountsForSize', () => {
  it('500 agencies produce 250/150/75/25', () => {
    expect(tierCountsForSize(500)).toEqual({
      om_agency: 250,
      ai_native: 150,
      ai_native_expert: 75,
      ai_native_core: 25,
    })
  })

  it('arbitrary size still sums to size (largest-remainder distribution)', () => {
    for (const size of [1, 17, 503, 1000, 5003]) {
      const counts = tierCountsForSize(size)
      const total = Object.values(counts).reduce((s, n) => s + n, 0)
      expect(total).toBe(size)
    }
  })

  it('rejects non-positive sizes', () => {
    expect(() => tierCountsForSize(0)).toThrow()
    expect(() => tierCountsForSize(-1)).toThrow()
    expect(() => tierCountsForSize(1.5)).toThrow()
  })
})

describe('buildPerfAgencyRoster', () => {
  it('default 500-agency roster has the right shape and counts', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'unit-roster' })
    expect(roster.agencies.length).toBe(500)
    expect(roster.countsByTier).toEqual({
      om_agency: 250,
      ai_native: 150,
      ai_native_expert: 75,
      ai_native_core: 25,
    })
    // every agency must have a unique UUID and slug.
    const ids = new Set(roster.agencies.map((a) => a.id))
    const slugs = new Set(roster.agencies.map((a) => a.slug))
    expect(ids.size).toBe(500)
    expect(slugs.size).toBe(500)
  })

  it('every Agency is status=active by default; onboarded=true', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'unit-roster-active' })
    for (const a of roster.agencies) {
      expect(a.status).toBe('active')
      expect(a.onboarded).toBe(true)
    }
  })

  it('withSomeNonOnboarded=true flips ~5% to onboarded=false (every 20th)', () => {
    const roster = buildPerfAgencyRoster({
      slugPrefix: 'unit-roster-mixed',
      withSomeNonOnboarded: true,
    })
    const offCount = roster.agencies.filter((a) => !a.onboarded).length
    // every 20th of 500 → 25 non-onboarded.
    expect(offCount).toBe(25)
  })

  it('eligibleIdsByMinTier matches the by_min_tier evaluator semantics', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'unit-roster-elig' })
    // by_min_tier='om_agency' → all 500 (lowest tier admits everything).
    expect(roster.eligibleIdsByMinTier.om_agency.length).toBe(500)
    // by_min_tier='ai_native' → 150 + 75 + 25 = 250.
    expect(roster.eligibleIdsByMinTier.ai_native.length).toBe(250)
    // by_min_tier='ai_native_expert' → 75 + 25 = 100.
    expect(roster.eligibleIdsByMinTier.ai_native_expert.length).toBe(100)
    // by_min_tier='ai_native_core' → 25.
    expect(roster.eligibleIdsByMinTier.ai_native_core.length).toBe(25)
  })

  it('eligibleIdsByMinTier excludes non-onboarded agencies', () => {
    const roster = buildPerfAgencyRoster({
      slugPrefix: 'unit-roster-mixed-elig',
      withSomeNonOnboarded: true,
    })
    // 25 non-onboarded must NOT appear in any tier list.
    const nonOnboardedIds = new Set(roster.agencies.filter((a) => !a.onboarded).map((a) => a.id))
    for (const tier of AGENCY_TIERS) {
      for (const id of roster.eligibleIdsByMinTier[tier]) {
        expect(nonOnboardedIds.has(id)).toBe(false)
      }
    }
  })

  it('spotCheckAgencyId is an onboarded ai_native_core agency', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'unit-roster-spot' })
    const spot = roster.agencies.find((a) => a.id === roster.spotCheckAgencyId)
    expect(spot).toBeDefined()
    expect(spot!.tier).toBe('ai_native_core')
    expect(spot!.onboarded).toBe(true)
    expect(spot!.status).toBe('active')
  })

  it('spotCheckAgencyId appears in every relevant by_min_tier eligible list', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'unit-roster-spot-elig' })
    expect(roster.eligibleIdsByMinTier.ai_native_core).toContain(roster.spotCheckAgencyId)
    expect(roster.eligibleIdsByMinTier.ai_native_expert).toContain(roster.spotCheckAgencyId)
    expect(roster.eligibleIdsByMinTier.ai_native).toContain(roster.spotCheckAgencyId)
    expect(roster.eligibleIdsByMinTier.om_agency).toContain(roster.spotCheckAgencyId)
  })

  it('every slug satisfies the Agency slug invariant', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'slug-test' })
    const re = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    for (const a of roster.agencies) {
      expect(re.test(a.slug)).toBe(true)
    }
  })

  it('rejects invalid slugPrefix shapes', () => {
    expect(() => buildPerfAgencyRoster({ slugPrefix: 'BadCase' })).toThrow()
    expect(() => buildPerfAgencyRoster({ slugPrefix: 'has spaces' })).toThrow()
    expect(() => buildPerfAgencyRoster({ slugPrefix: '-leading' })).toThrow()
    expect(() => buildPerfAgencyRoster({ slugPrefix: 'trailing-' })).toThrow()
  })

  it('industries/services arrays are non-empty per Agency', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'industries-test' })
    for (const a of roster.agencies) {
      expect(a.industries.length).toBeGreaterThan(0)
      expect(a.services.length).toBeGreaterThan(0)
    }
  })

  it('size override produces the requested number of agencies', () => {
    const roster = buildPerfAgencyRoster({ slugPrefix: 'small-roster', size: 17 })
    expect(roster.agencies.length).toBe(17)
  })
})
