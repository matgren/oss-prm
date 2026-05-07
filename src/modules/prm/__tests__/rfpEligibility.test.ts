import {
  evaluateRfpEligibility,
  toEligibilityFilterInput,
} from '../lib/rfpEligibility'

const A = (id: string, tier: string) => ({ id, tier })

describe('evaluateRfpEligibility (Spec #5 §2.US5.2)', () => {
  it('all_active returns every candidate', () => {
    const out = evaluateRfpEligibility(
      { kind: 'all_active' },
      [A('a1', 'om_agency'), A('a2', 'ai_native_core')],
    )
    expect(out.sort()).toEqual(['a1', 'a2'])
  })

  it('all_active with empty candidate list → empty', () => {
    expect(evaluateRfpEligibility({ kind: 'all_active' }, [])).toEqual([])
  })

  it('by_min_tier filters out lower tiers (om_agency < ai_native)', () => {
    const out = evaluateRfpEligibility(
      { kind: 'by_min_tier', minTier: 'ai_native' },
      [
        A('basic', 'om_agency'),
        A('mid', 'ai_native'),
        A('expert', 'ai_native_expert'),
        A('core', 'ai_native_core'),
      ],
    )
    expect(out.sort()).toEqual(['core', 'expert', 'mid'])
  })

  it('by_min_tier with strict highest tier (ai_native_core) returns only that tier', () => {
    const out = evaluateRfpEligibility(
      { kind: 'by_min_tier', minTier: 'ai_native_core' },
      [
        A('basic', 'om_agency'),
        A('mid', 'ai_native'),
        A('core1', 'ai_native_core'),
        A('core2', 'ai_native_core'),
      ],
    )
    expect(out.sort()).toEqual(['core1', 'core2'])
  })

  it('by_min_tier with no matching agencies → empty (§9.1 #3 path)', () => {
    const out = evaluateRfpEligibility(
      { kind: 'by_min_tier', minTier: 'ai_native_core' },
      [A('basic', 'om_agency'), A('mid', 'ai_native')],
    )
    expect(out).toEqual([])
  })

  it('explicit returns only the listed ids that exist in the candidate set', () => {
    const out = evaluateRfpEligibility(
      { kind: 'explicit', explicitAgencyIds: ['a1', 'a99'] }, // a99 does not exist
      [A('a1', 'om_agency'), A('a2', 'ai_native')],
    )
    expect(out).toEqual(['a1'])
  })

  it('explicit with no overlap → empty', () => {
    const out = evaluateRfpEligibility(
      { kind: 'explicit', explicitAgencyIds: ['x1', 'x2'] },
      [A('a1', 'om_agency')],
    )
    expect(out).toEqual([])
  })

  it('treats unknown tier as below the min — defence-in-depth on enum drift', () => {
    const out = evaluateRfpEligibility(
      { kind: 'by_min_tier', minTier: 'ai_native' },
      [A('weird', 'unknown_tier_value' as any), A('valid', 'ai_native_expert')],
    )
    expect(out).toEqual(['valid'])
  })
})

describe('toEligibilityFilterInput', () => {
  it('maps all_active', () => {
    expect(
      toEligibilityFilterInput({ eligibilityFilter: 'all_active' } as any),
    ).toEqual({ kind: 'all_active' })
  })

  it('maps by_min_tier with minTier present', () => {
    expect(
      toEligibilityFilterInput({
        eligibilityFilter: 'by_min_tier',
        minTier: 'ai_native_expert',
      } as any),
    ).toEqual({ kind: 'by_min_tier', minTier: 'ai_native_expert' })
  })

  it('throws when by_min_tier omits minTier', () => {
    expect(() =>
      toEligibilityFilterInput({ eligibilityFilter: 'by_min_tier' } as any),
    ).toThrow(/by_min_tier requires minTier/)
  })

  it('maps explicit with non-empty ids', () => {
    expect(
      toEligibilityFilterInput({
        eligibilityFilter: 'explicit',
        explicitAgencyIds: ['a', 'b'],
      } as any),
    ).toEqual({ kind: 'explicit', explicitAgencyIds: ['a', 'b'] })
  })

  it('throws when explicit has empty/null ids', () => {
    expect(() =>
      toEligibilityFilterInput({ eligibilityFilter: 'explicit', explicitAgencyIds: [] } as any),
    ).toThrow(/non-empty/)
  })

  it('throws on unknown filter value', () => {
    expect(() =>
      toEligibilityFilterInput({ eligibilityFilter: 'made_up' } as any),
    ).toThrow(/unknown eligibility_filter/)
  })
})
