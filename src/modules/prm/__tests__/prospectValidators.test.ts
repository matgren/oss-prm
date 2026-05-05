import {
  normalizeCompanyName,
  normalizeContactEmail,
  registerProspectSchema,
  updateProspectSchema,
  PROSPECT_TRANSITIONS,
} from '../data/validators'

describe('Prospect validators', () => {
  describe('normalizeCompanyName', () => {
    it('lowercases, trims, strips punctuation, and collapses whitespace', () => {
      expect(normalizeCompanyName('  Acme-Corp,  Inc. ')).toBe('acme corp inc')
    })
    it('preserves Unicode letters', () => {
      expect(normalizeCompanyName('Açaí Bowls Ltd.')).toBe('açaí bowls ltd')
    })
    it('handles digits', () => {
      expect(normalizeCompanyName('123 Innovations LLC')).toBe('123 innovations llc')
    })
  })

  describe('normalizeContactEmail', () => {
    it('lowercases and trims', () => {
      expect(normalizeContactEmail('  LEAD@Acme-Corp.IO ')).toBe('lead@acme-corp.io')
    })
  })

  describe('registerProspectSchema', () => {
    it('rejects extra unknown fields with .strict()', () => {
      const result = registerProspectSchema.safeParse({
        companyName: 'Acme',
        contactName: 'Jane',
        contactEmail: 'jane@acme.io',
        registeredAt: '2020-01-01T00:00:00Z', // <-- should be rejected
      })
      expect(result.success).toBe(false)
    })
    it('defaults source to agency_owned', () => {
      const result = registerProspectSchema.safeParse({
        companyName: 'Acme',
        contactName: 'Jane',
        contactEmail: 'jane@acme.io',
      })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.source).toBe('agency_owned')
    })
    it('rejects empty company name', () => {
      const result = registerProspectSchema.safeParse({
        companyName: '',
        contactName: 'Jane',
        contactEmail: 'jane@acme.io',
      })
      expect(result.success).toBe(false)
    })
    it('rejects malformed email', () => {
      const result = registerProspectSchema.safeParse({
        companyName: 'Acme',
        contactName: 'Jane',
        contactEmail: 'not-an-email',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateProspectSchema (discriminated union)', () => {
    it('rejects edit body containing registeredAt (invariant #1)', () => {
      const result = updateProspectSchema.safeParse({
        kind: 'edit',
        companyName: 'Acme Global',
        registeredAt: '2020-01-01T00:00:00Z',
      })
      expect(result.success).toBe(false)
    })
    it('rejects transition body without ifMatchStatusChangedAt', () => {
      const result = updateProspectSchema.safeParse({
        kind: 'transition',
        toStatus: 'qualified',
      })
      expect(result.success).toBe(false)
    })
    it('rejects transition with toStatus = won (portal subset only)', () => {
      const result = updateProspectSchema.safeParse({
        kind: 'transition',
        toStatus: 'won',
        ifMatchStatusChangedAt: '2026-01-01T00:00:00Z',
      })
      expect(result.success).toBe(false)
    })
    it('accepts a valid transition payload', () => {
      const result = updateProspectSchema.safeParse({
        kind: 'transition',
        toStatus: 'qualified',
        ifMatchStatusChangedAt: '2026-01-01T00:00:00Z',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('PROSPECT_TRANSITIONS map', () => {
    it('lists no transitions out of terminal states (won, lost)', () => {
      expect(PROSPECT_TRANSITIONS.won).toEqual([])
      expect(PROSPECT_TRANSITIONS.lost).toEqual([])
    })
    it('allows new → qualified | lost', () => {
      expect(PROSPECT_TRANSITIONS.new).toEqual(expect.arrayContaining(['qualified', 'lost']))
    })
    it('allows qualified → contacted | won | lost', () => {
      expect(PROSPECT_TRANSITIONS.qualified).toEqual(
        expect.arrayContaining(['contacted', 'won', 'lost']),
      )
    })
    it('allows contacted → won | lost | dormant', () => {
      expect(PROSPECT_TRANSITIONS.contacted).toEqual(
        expect.arrayContaining(['won', 'lost', 'dormant']),
      )
    })
    it('allows dormant → qualified | lost', () => {
      expect(PROSPECT_TRANSITIONS.dormant).toEqual(expect.arrayContaining(['qualified', 'lost']))
    })
  })
})
