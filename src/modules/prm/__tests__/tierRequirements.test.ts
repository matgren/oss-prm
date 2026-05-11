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
    // Next tier (ai_native) requires 5 WIP and 2 monthly WIC.
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

  it('every tier declares a positive minYearlyMin (third KPI rail)', () => {
    // SPEC-2026-05-10: MIN per tier is a first-class threshold alongside
    // WIP/mo and WIC/mo. App-spec §1.4 values: 1, 2, 5, 5.
    expect(getTierRequirement('om_agency').minYearlyMin).toBe(1)
    expect(getTierRequirement('ai_native').minYearlyMin).toBe(2)
    expect(getTierRequirement('ai_native_expert').minYearlyMin).toBe(5)
    expect(getTierRequirement('ai_native_core').minYearlyMin).toBe(5)
  })

  it('computeTierProgress treats MIN as a lagging metric when supplied', () => {
    // Next tier (ai_native) requires 5 WIP, 2 WIC, 2 MIN.
    // Meet WIP + WIC but only 0 MIN → pct is bounded by MIN → 0.
    const progress = computeTierProgress({
      current: 'om_agency',
      currentWip: 10,
      currentMonthlyWic: 5,
      currentYearlyMin: 0,
    })
    expect(progress.pctToNext).toBe(0)
  })

  it('computeTierProgress ignores MIN when currentYearlyMin is omitted (back-compat)', () => {
    // No MIN supplied → MIN does not bound the calculation.
    const progress = computeTierProgress({
      current: 'om_agency',
      currentWip: 10,
      currentMonthlyWic: 5,
    })
    expect(progress.pctToNext).toBe(1)
  })

  it('computeTierProgress returns the lagging of all three metrics', () => {
    // Next tier (ai_native) requires 5 WIP, 2 WIC, 2 MIN.
    // 2/5 WIP = 0.4, 2/2 WIC = 1, 2/2 MIN = 1 → lagging = WIP at 0.4.
    const progress = computeTierProgress({
      current: 'om_agency',
      currentWip: 2,
      currentMonthlyWic: 2,
      currentYearlyMin: 2,
    })
    expect(progress.pctToNext).toBeCloseTo(0.4, 5)
  })
})
