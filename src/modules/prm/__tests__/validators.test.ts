import {
  ADMIN_ONLY_AGENCY_FIELDS,
  AGENCY_TIERS,
  ROLE_SLUGS,
  createAgencySchema,
  inviteAgencyMemberSchema,
  portalInviteAgencyMemberSchema,
  updateAgencyBackendSchema,
  updateAgencyMemberPortalSchema,
  updateAgencyPortalSchema,
} from '../data/validators'

describe('PRM validators', () => {
  it('validates create agency input', () => {
    const ok = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'acme-co',
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    expect(ok.success).toBe(true)

    const badSlug = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'Bad Slug',
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    expect(badSlug.success).toBe(false)

    const badCountry = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'acme-co',
      tier: 'om_agency',
      headquartersCountry: 'us',
    })
    expect(badCountry.success).toBe(false)

    const unknownTier = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'acme-co',
      tier: 'platinum',
      headquartersCountry: 'US',
    })
    expect(unknownTier.success).toBe(false)
  })

  it('rejects unknown fields on portal update (strict)', () => {
    const res = updateAgencyPortalSchema.safeParse({ tier: 'ai_native' })
    expect(res.success).toBe(false)
    if (!res.success) {
      const flat = res.error.flatten()
      expect(JSON.stringify(flat)).toMatch(/tier/i)
    }
  })

  it('accepts known editable fields on portal update', () => {
    const res = updateAgencyPortalSchema.safeParse({ name: 'X', description: 'Y', headquartersCity: 'NYC' })
    expect(res.success).toBe(true)
  })

  it('exposes the admin-only field set', () => {
    expect(ADMIN_ONLY_AGENCY_FIELDS).toEqual(
      expect.arrayContaining(['tier', 'status', 'contractSigned', 'ndaSigned', 'onboarded']),
    )
  })

  it('admits backend update payload with all admin-only fields', () => {
    const res = updateAgencyBackendSchema.safeParse({
      tier: 'ai_native',
      status: 'historical',
      contractSigned: true,
      ndaSigned: true,
      onboarded: true,
    })
    expect(res.success).toBe(true)
  })

  it('validates GitHub profile regex', () => {
    const ok = inviteAgencyMemberSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      githubProfile: 'ada-lovelace',
      roleSlug: 'partner_admin',
    })
    expect(ok.success).toBe(true)
    const bad = inviteAgencyMemberSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      githubProfile: '@ada',
      roleSlug: 'partner_admin',
    })
    expect(bad.success).toBe(false)
  })

  it('portal invite schema strips role_slug other than partner_member', () => {
    const ok = portalInviteAgencyMemberSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    })
    expect(ok.success).toBe(true)

    const explicit = portalInviteAgencyMemberSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      roleSlug: 'partner_member',
    })
    expect(explicit.success).toBe(true)
  })

  it('portal member self-edit rejects role-slug attempts', () => {
    const res = updateAgencyMemberPortalSchema.safeParse({ roleSlug: 'partner_admin' })
    expect(res.success).toBe(false)
  })

  it('exposes the canonical role slug list', () => {
    expect(ROLE_SLUGS).toEqual(['partner_admin', 'partner_member'])
    expect(AGENCY_TIERS).toContain('om_agency')
  })
})
