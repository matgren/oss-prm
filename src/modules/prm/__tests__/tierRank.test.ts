import { TIER_RANK, isAgencyTier, tierRank } from '../lib/tierRank'

describe('tierRank lookup', () => {
  it('orders the tiers in the canonical sequence', () => {
    expect(TIER_RANK.om_agency).toBe(1)
    expect(TIER_RANK.ai_native).toBe(2)
    expect(TIER_RANK.ai_native_expert).toBe(3)
    expect(TIER_RANK.ai_native_core).toBe(4)
  })

  it('returns null for unknown / null inputs', () => {
    expect(tierRank(null)).toBeNull()
    expect(tierRank(undefined)).toBeNull()
    expect(tierRank('not_a_tier')).toBeNull()
  })

  it('returns the rank for canonical tiers', () => {
    expect(tierRank('om_agency')).toBe(1)
    expect(tierRank('ai_native')).toBe(2)
    expect(tierRank('ai_native_expert')).toBe(3)
    expect(tierRank('ai_native_core')).toBe(4)
  })

  it('isAgencyTier narrows correctly', () => {
    expect(isAgencyTier('ai_native')).toBe(true)
    expect(isAgencyTier('elite')).toBe(false)
  })
})
