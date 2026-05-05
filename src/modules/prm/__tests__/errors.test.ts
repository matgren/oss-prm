import {
  PRM_ERROR_CODES,
  PrmDomainError,
  isUniqueViolation,
  toPrmErrorBody,
  GITHUB_PROFILE_CONFLICT_MESSAGE,
} from '../lib/errors'

describe('PRM domain errors', () => {
  it('serialises into the standard envelope', () => {
    const err = new PrmDomainError(PRM_ERROR_CODES.AGENCY_SLUG_TAKEN, 'taken', 409, { field: 'slug' })
    expect(toPrmErrorBody(err)).toEqual({
      ok: false,
      error: { code: 'agency_slug_taken', message: 'taken', details: { field: 'slug' } },
    })
  })

  it('detects Postgres 23505 unique violations', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ constraintName: 'prm_agency_members_github_profile_active_uniq' })).toBe(true)
    expect(isUniqueViolation({ code: '42P01' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
  })

  it('does not reveal cross-agency information in the L-010 message', () => {
    expect(GITHUB_PROFILE_CONFLICT_MESSAGE).not.toMatch(/Acme|agency_id|tenant/i)
    expect(GITHUB_PROFILE_CONFLICT_MESSAGE).toMatch(/contact OM PartnerOps/i)
  })
})
