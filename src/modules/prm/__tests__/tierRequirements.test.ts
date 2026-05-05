import {
  computeTierProgress,
  getNextTier,
  getTierRequirement,
  listTierRequirements,
} from '../lib/tierRequirements'

describe('tier requirements registry', () => {
  it('returns the requirement for every tier', () => {
    expect(getTierRequirement('om_agency')).toMatchObject({ rank: 0 })
    expect(getTierRequirement('ai_native')).toMatchObject({ rank: 1 })
    expect(getTierRequirement('ai_native_expert')).toMatchObject({ rank: 2 })
    expect(getTierRequirement('ai_native_core')).toMatchObject({ rank: 3 })
  })

  it('listTierRequirements returns the registry in canonical order', () => {
    const list = listTierRequirements()
    expect(list.map((r) => r.tier)).toEqual([
      'om_agency',
      'ai_native',
      'ai_native_expert',
      'ai_native_core',
    ])
  })

  it('computes pct = 1 at top tier', () => {
    expect(computeTierProgress({ current: 'ai_native_core', currentWip: 0, currentMonthlyWic: 0 })).toMatchObject({
      pctToNext: 1,
      next: null,
    })
  })

  it('computes pct based on the lagging metric', () => {
    // Next tier (ai_native) requires 5 WIP and 1 monthly WIC.
    // We have plenty of WIP (10) but zero WIC → pct = 0.
    const progress = computeTierProgress({
      current: 'om_agency',
      currentWip: 10,
      currentMonthlyWic: 0,
    })
    expect(progress.next?.tier).toBe('ai_native')
    expect(progress.pctToNext).toBe(0)
  })

  it('caps pct at 1 even if metrics overshoot', () => {
    const progress = computeTierProgress({
      current: 'om_agency',
      currentWip: 100,
      currentMonthlyWic: 100,
    })
    expect(progress.pctToNext).toBe(1)
  })

  it('getNextTier returns null at top', () => {
    expect(getNextTier('ai_native_core')).toBeNull()
  })

  it('getNextTier returns the next-rank requirement', () => {
    expect(getNextTier('ai_native')?.tier).toBe('ai_native_expert')
  })
})
