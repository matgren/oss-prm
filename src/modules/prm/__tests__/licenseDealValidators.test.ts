import {
  attributeLicenseDealSchema,
  createLicenseDealSchema,
  isAttributionFrozen,
  licenseDealCorrelationKey,
  LICENSE_DEAL_TRANSITIONS,
  pathToAttributionSource,
  reverseLicenseDealSchema,
  unreverseLicenseDealStatusSchema,
} from '../data/validators'

describe('LicenseDeal validators', () => {
  describe('createLicenseDealSchema', () => {
    it('accepts a minimal payload', () => {
      const r = createLicenseDealSchema.safeParse({
        licenseIdentifier: 'OM-2026-0001',
        clientCompanyName: 'Acme Corp',
      })
      expect(r.success).toBe(true)
    })
    it('rejects an empty client name', () => {
      const r = createLicenseDealSchema.safeParse({
        licenseIdentifier: 'OM-2026-0001',
        clientCompanyName: '',
      })
      expect(r.success).toBe(false)
    })
    it('coerces decimal strings without throwing', () => {
      const r = createLicenseDealSchema.safeParse({
        licenseIdentifier: 'OM-2026-0001',
        clientCompanyName: 'Acme',
        annualValueUsd: '120000.00',
      })
      expect(r.success).toBe(true)
    })
    it('rejects junk decimal strings', () => {
      const r = createLicenseDealSchema.safeParse({
        licenseIdentifier: 'OM-2026-0001',
        clientCompanyName: 'Acme',
        annualValueUsd: '120k',
      })
      expect(r.success).toBe(false)
    })
  })

  describe('attributeLicenseDealSchema (discriminated union)', () => {
    it('Path A requires golden_rule_default_prospect_id', () => {
      const r = attributeLicenseDealSchema.safeParse({
        attribution_path: 'A',
        prospect_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      })
      expect(r.success).toBe(false)
    })
    it('Path A accepts the optional reasoning', () => {
      const r = attributeLicenseDealSchema.safeParse({
        attribution_path: 'A',
        prospect_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        golden_rule_default_prospect_id: '8c9e6679-7425-40de-944b-e07fc1f90ae8',
        attribution_reasoning: 'override because contact email matched.',
        competing_prospect_ids_to_retire: [],
      })
      expect(r.success).toBe(true)
    })
    it('Path B requires only rfp_id', () => {
      const r = attributeLicenseDealSchema.safeParse({
        attribution_path: 'B',
        rfp_id: '9c9e6679-7425-40de-944b-e07fc1f90ae9',
      })
      expect(r.success).toBe(true)
    })
    it('Path C requires reasoning + agency id', () => {
      const r = attributeLicenseDealSchema.safeParse({
        attribution_path: 'C',
        attributed_agency_id: 'ac9e6679-7425-40de-944b-e07fc1f90ae0',
        attribution_reasoning: 'direct OM sale via founder intro',
      })
      expect(r.success).toBe(true)
    })
    it('Path C without reasoning fails', () => {
      const r = attributeLicenseDealSchema.safeParse({
        attribution_path: 'C',
        attributed_agency_id: 'ac9e6679-7425-40de-944b-e07fc1f90ae0',
      })
      expect(r.success).toBe(false)
    })
  })

  describe('reverseLicenseDealSchema', () => {
    it('requires a 10+ char reason', () => {
      expect(
        reverseLicenseDealSchema.safeParse({ reason: 'short' }).success,
      ).toBe(false)
      expect(
        reverseLicenseDealSchema.safeParse({ reason: 'long enough reason text here' }).success,
      ).toBe(true)
    })
    it('accepts an optional newAttribution payload', () => {
      const r = reverseLicenseDealSchema.safeParse({
        reason: 'reassign per finance audit ticket #4567',
        newAttribution: {
          attribution_path: 'C',
          attributed_agency_id: 'bc9e6679-7425-40de-944b-e07fc1f90af9',
          attribution_reasoning: 'direct OM hand-off',
        },
      })
      expect(r.success).toBe(true)
    })
  })

  describe('unreverseLicenseDealStatusSchema', () => {
    it('only allows signed/pending as targets', () => {
      expect(
        unreverseLicenseDealStatusSchema.safeParse({
          toStatus: 'churned',
          reason: 'long enough reason',
        }).success,
      ).toBe(false)
      expect(
        unreverseLicenseDealStatusSchema.safeParse({
          toStatus: 'pending',
          reason: 'release rfp lock for re-selection',
        }).success,
      ).toBe(true)
    })
  })

  describe('LICENSE_DEAL_TRANSITIONS', () => {
    it('rejects pending → active (must go via signed)', () => {
      expect(LICENSE_DEAL_TRANSITIONS.pending).toEqual(['signed'])
    })
    it('treats churned as terminal', () => {
      expect(LICENSE_DEAL_TRANSITIONS.churned).toEqual([])
    })
    it('signed can move to active or churned', () => {
      expect(LICENSE_DEAL_TRANSITIONS.signed).toEqual(['active', 'churned'])
    })
  })

  describe('helpers', () => {
    it('maps path → source', () => {
      expect(pathToAttributionSource('A')).toBe('prospect')
      expect(pathToAttributionSource('B')).toBe('rfp')
      expect(pathToAttributionSource('C')).toBe('direct')
      expect(pathToAttributionSource('none')).toBe('direct')
    })
    it('builds correlationKey as license_deal_id + : + attribution_source (FROZEN contract)', () => {
      expect(
        licenseDealCorrelationKey('7c9e6679-7425-40de-944b-e07fc1f90ae7', 'prospect'),
      ).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7:prospect')
    })
    it('isAttributionFrozen returns true for active and churned only', () => {
      expect(isAttributionFrozen('pending')).toBe(false)
      expect(isAttributionFrozen('signed')).toBe(false)
      expect(isAttributionFrozen('active')).toBe(true)
      expect(isAttributionFrozen('churned')).toBe(true)
    })
  })
})
