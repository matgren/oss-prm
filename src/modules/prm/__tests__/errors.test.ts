import {
  PRM_ERROR_CODES,
  PrmDomainError,
  isPrmDomainError,
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

describe('isPrmDomainError type guard', () => {
  it('recognises a real `PrmDomainError`', () => {
    const err = new PrmDomainError(PRM_ERROR_CODES.VALIDATION_FAILED, 'bad', 409)
    expect(isPrmDomainError(err)).toBe(true)
  })

  it('recognises a sibling-chunk `PrmDomainError` (correct tag + shape, different prototype)', () => {
    // Simulates the Next.js Turbopack scenario where the service-side chunk
    // and the route-side chunk each have their own copy of `PrmDomainError`
    // — the prototype chains diverge but the structural shape is identical.
    // `instanceof` returns false here; the guard MUST still recognise it.
    class SiblingPrmDomainError extends Error {
      public readonly code: string
      public readonly status: number
      constructor(code: string, message: string, status: number) {
        super(message)
        this.name = 'PrmDomainError'
        this.code = code
        this.status = status
      }
    }
    const err = new SiblingPrmDomainError('validation_failed', 'bad', 409)
    expect(err instanceof PrmDomainError).toBe(false)
    expect(isPrmDomainError(err)).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isPrmDomainError(new Error('boom'))).toBe(false)
    expect(isPrmDomainError(new TypeError('boom'))).toBe(false)
  })

  it('rejects a tag-spoofed object that is missing structural fields', () => {
    // Defence in depth — a random thrown object that happens to set
    // `.name = 'PrmDomainError'` but lacks `.code` / `.status` must not pass.
    const fake = { name: 'PrmDomainError', message: 'incomplete' }
    expect(isPrmDomainError(fake)).toBe(false)
  })

  it('rejects null / undefined / primitives', () => {
    expect(isPrmDomainError(null)).toBe(false)
    expect(isPrmDomainError(undefined)).toBe(false)
    expect(isPrmDomainError('PrmDomainError')).toBe(false)
    expect(isPrmDomainError(42)).toBe(false)
  })

  it('narrows the union so the call site can read `code` / `status` / `message`', () => {
    const err: unknown = new PrmDomainError(PRM_ERROR_CODES.VALIDATION_FAILED, 'msg', 409)
    if (isPrmDomainError(err)) {
      // TypeScript is happy here only because the guard narrowed `err`.
      expect(err.code).toBe('validation_failed')
      expect(err.status).toBe(409)
      expect(err.message).toBe('msg')
    } else {
      throw new Error('guard should have narrowed')
    }
  })
})
