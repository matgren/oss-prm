import {
  ADMIN_ONLY_AGENCY_FIELDS,
  AGENCY_TIERS,
  ROLE_SLUGS,
  createAgencySchema,
  createCaseStudySchema,
  createMarketingMaterialSchema,
  inviteAgencyMemberSchema,
  portalInviteAgencyMemberSchema,
  updateAgencyBackendSchema,
  updateAgencyMemberPortalSchema,
  updateAgencyPortalSchema,
  updateRfpDraftSchema,
} from '../data/validators'

describe('PRM validators', () => {
  it('validates create agency input', () => {
    const ok = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'acme-co',
      tier: 'om_agency',
    })
    expect(ok.success).toBe(true)

    const badSlug = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'Bad Slug',
      tier: 'om_agency',
    })
    expect(badSlug.success).toBe(false)

    const unknownTier = createAgencySchema.safeParse({
      name: 'Acme',
      slug: 'acme-co',
      tier: 'platinum',
    })
    expect(unknownTier.success).toBe(false)
  })

  it('portal update validates headquartersCountry (agency admin sets it)', () => {
    const ok = updateAgencyPortalSchema.safeParse({ headquartersCountry: 'US' })
    expect(ok.success).toBe(true)
    const badCase = updateAgencyPortalSchema.safeParse({ headquartersCountry: 'us' })
    expect(badCase.success).toBe(false)
    const badLength = updateAgencyPortalSchema.safeParse({ headquartersCountry: 'USA' })
    expect(badLength.success).toBe(false)
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

  // -------------------------------------------------------------------------
  // SPEC-2026-05-11 — open-vocabulary tag fields.
  // -------------------------------------------------------------------------

  describe('open-vocab tag fields (SPEC-2026-05-11)', () => {
    const LEGACY_UUID = '7a4b8c9d-1234-5678-9abc-def012345678'

    it('updateAgencyBackendSchema accepts both legacy UUID and free-form slugs in services + techCapabilities', () => {
      const legacyShape = updateAgencyBackendSchema.safeParse({
        services: [LEGACY_UUID],
        techCapabilities: [LEGACY_UUID],
      })
      expect(legacyShape.success).toBe(true)

      const openVocab = updateAgencyBackendSchema.safeParse({
        services: ['Workflow automation', 'AI-native engineering'],
        techCapabilities: ['LangGraph', 'PyTorch', 'React'],
      })
      expect(openVocab.success).toBe(true)
    })

    it('updateAgencyPortalSchema mirrors the open-vocab acceptance', () => {
      const res = updateAgencyPortalSchema.safeParse({
        services: ['Discovery sprints'],
        techCapabilities: ['Next.js'],
      })
      expect(res.success).toBe(true)
    })

    it('openTagSlugArray rejects whitespace-only elements after trim', () => {
      const res = updateAgencyBackendSchema.safeParse({
        services: ['   '],
      })
      expect(res.success).toBe(false)
    })

    it('openTagSlugArray rejects elements over 80 chars', () => {
      const res = updateAgencyBackendSchema.safeParse({
        services: ['x'.repeat(81)],
      })
      expect(res.success).toBe(false)
    })

    it('openTagSlugArray rejects arrays with more than 50 elements (max-cap)', () => {
      const fiftyOne = Array.from({ length: 51 }, (_, i) => `tag-${i}`)
      const res = updateAgencyBackendSchema.safeParse({
        techCapabilities: fiftyOne,
      })
      expect(res.success).toBe(false)
      if (!res.success) {
        const flat = JSON.stringify(res.error.flatten())
        expect(flat).toMatch(/prm\.errors\.tagArrayTooLarge/)
      }
    })

    it('createCaseStudySchema tightens slugStringArray (trim + max-cap)', () => {
      const validPayload = {
        title: 'Migrating to LangGraph',
        clientName: 'Acme Co',
        challengeMarkdown: 'Challenge text.',
        approachMarkdown: 'Approach text.',
        outcomeMarkdown: 'Outcome text.',
      }
      const ok = createCaseStudySchema.safeParse({
        ...validPayload,
        technologiesUsed: ['LangGraph', 'PyTorch'],
        servicesDelivered: ['Workflow automation'],
      })
      expect(ok.success).toBe(true)

      const whitespaceOnly = createCaseStudySchema.safeParse({
        ...validPayload,
        technologiesUsed: ['  '],
      })
      expect(whitespaceOnly.success).toBe(false)

      const overCap = createCaseStudySchema.safeParse({
        ...validPayload,
        technologiesUsed: Array.from({ length: 51 }, (_, i) => `t-${i}`),
      })
      expect(overCap.success).toBe(false)
    })

    it('createMarketingMaterialSchema also picks up slugStringArray tightening (NM1 cascade)', () => {
      const basePayload = {
        title: 'Sample guide deck',
        materialType: 'guide' as const,
        primaryAttachmentId: LEGACY_UUID,
      }
      const ok = createMarketingMaterialSchema.safeParse({
        ...basePayload,
        topics: ['agentic-ai', 'rag-evals'],
      })
      expect(ok.success).toBe(true)

      const whitespaceOnly = createMarketingMaterialSchema.safeParse({
        ...basePayload,
        topics: ['  '],
      })
      expect(whitespaceOnly.success).toBe(false)

      const overCap = createMarketingMaterialSchema.safeParse({
        ...basePayload,
        topics: Array.from({ length: 51 }, (_, i) => `topic-${i}`),
      })
      expect(overCap.success).toBe(false)
    })

    it('updateRfpDraftSchema tightens required_capabilities to openTagSlugArray', () => {
      const trimmed = updateRfpDraftSchema.safeParse({
        required_capabilities: ['LangGraph', 'PyTorch'],
      })
      expect(trimmed.success).toBe(true)

      const empty = updateRfpDraftSchema.safeParse({
        required_capabilities: [''],
      })
      expect(empty.success).toBe(false)

      const whitespace = updateRfpDraftSchema.safeParse({
        required_capabilities: ['   '],
      })
      expect(whitespace.success).toBe(false)

      const overCap = updateRfpDraftSchema.safeParse({
        required_capabilities: Array.from({ length: 51 }, (_, i) => `cap-${i}`),
      })
      expect(overCap.success).toBe(false)
    })
  })
})
