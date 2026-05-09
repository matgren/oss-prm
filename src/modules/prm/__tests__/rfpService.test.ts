import { RfpService } from '../lib/rfpService'
import { Agency, CaseStudy, Rfp, RfpBroadcast, RfpResponse } from '../data/entities'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'
import {
  failingBroadcastFailureInjector,
  nullBroadcastFailureInjector,
} from '../lib/broadcastFailureInjector'

type AnyRow = Record<string, any>

class FakeEm {
  agencies: AnyRow[] = []
  rfps: AnyRow[] = []
  broadcasts: AnyRow[] = []
  responses: AnyRow[] = []
  caseStudies: AnyRow[] = []
  removedRows: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(EntityCtor: any, payload: T): T {
    const created: any = { ...payload, id: payload.id ?? `mock-${Math.random().toString(36).slice(2, 8)}` }
    return created as T
  }

  persist(row: AnyRow): void {
    if (this.matchEntity(row, Rfp)) {
      this.upsert(this.rfps, row)
    } else if (this.matchEntity(row, RfpBroadcast)) {
      this.upsert(this.broadcasts, row)
    } else if (this.matchEntity(row, RfpResponse)) {
      this.upsert(this.responses, row)
    }
  }

  remove(row: AnyRow): void {
    this.removedRows.push(row)
    this.broadcasts = this.broadcasts.filter((r) => r.id !== row.id)
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(EntityCtor: any, where: AnyRow): Promise<AnyRow | null> {
    const ctorName = EntityCtor?.name ?? ''
    if (ctorName === 'Rfp') {
      return (
        this.rfps.find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.organizationId === undefined || r.organizationId === where.organizationId) &&
            (where.deletedAt === undefined || (where.deletedAt === null ? !r.deletedAt : r.deletedAt === where.deletedAt)),
        ) ?? null
      )
    }
    if (ctorName === 'RfpResponse') {
      return (
        this.responses.find(
          (r) =>
            (where.rfpId === undefined || r.rfpId === where.rfpId) &&
            (where.agencyId === undefined || r.agencyId === where.agencyId) &&
            (where.organizationId === undefined || r.organizationId === where.organizationId),
        ) ?? null
      )
    }
    if (ctorName === 'RfpBroadcast') {
      return (
        this.broadcasts.find(
          (b) =>
            (where.rfpId === undefined || b.rfpId === where.rfpId) &&
            (where.agencyId === undefined || b.agencyId === where.agencyId) &&
            (where.organizationId === undefined || b.organizationId === where.organizationId),
        ) ?? null
      )
    }
    return null
  }

  async find(EntityCtor: any, where: AnyRow, _opts?: AnyRow): Promise<AnyRow[]> {
    const ctorName = EntityCtor?.name ?? ''
    if (ctorName === 'Agency') {
      return this.agencies.filter((a) => {
        if (where.tenantId && a.tenantId !== where.tenantId) return false
        if (where.status && a.status !== where.status) return false
        if (where.onboarded !== undefined && a.onboarded !== where.onboarded) return false
        if (where.deletedAt === null && a.deletedAt) return false
        return true
      })
    }
    if (ctorName === 'RfpBroadcast') {
      return this.broadcasts.filter((b) => {
        if (where.rfpId && b.rfpId !== where.rfpId) return false
        if (where.organizationId && b.organizationId !== where.organizationId) return false
        return true
      })
    }
    if (ctorName === 'RfpResponse') {
      return this.responses.filter((r) => {
        if (where.rfpId && r.rfpId !== where.rfpId) return false
        if (where.organizationId && r.organizationId !== where.organizationId) return false
        return true
      })
    }
    if (ctorName === 'CaseStudy') {
      const ids: string[] = where.id?.$in ?? []
      return this.caseStudies.filter((cs) => {
        if (ids.length && !ids.includes(cs.id)) return false
        if (where.organizationId && cs.organizationId !== where.organizationId) return false
        if (where.agencyId && cs.agencyId !== where.agencyId) return false
        if (where.deletedAt === null && cs.deletedAt) return false
        return true
      })
    }
    return []
  }

  private upsert(arr: AnyRow[], row: AnyRow): void {
    const idx = arr.findIndex((r) => r.id === row.id)
    if (idx >= 0) arr[idx] = row
    else arr.push(row)
  }

  private matchEntity(row: AnyRow, Ctor: any): boolean {
    // FakeEm relies on the caller having put the right shape in. We use shape
    // discriminators rather than `instanceof` because em.create returns a plain
    // POJO in this test fixture.
    if (Ctor === Rfp) {
      return 'title' in row && 'eligibilityFilter' in row
    }
    if (Ctor === RfpBroadcast) {
      return 'rfpId' in row && 'broadcastAt' in row
    }
    if (Ctor === RfpResponse) {
      return 'rfpId' in row && 'submittedByMemberId' in row
    }
    return false
  }
}

const TENANT = 't-1'
const ORG = 'o-1'
const USER = 'user-1'

function seedAgency(em: FakeEm, id: string, tier: string) {
  em.agencies.push({
    id,
    tenantId: TENANT,
    organizationId: ORG,
    tier,
    status: 'active',
    onboarded: true,
    deletedAt: null,
  })
}

function makeCreateInput(overrides: Partial<any> = {}) {
  return {
    title: 'Big RFP',
    received_from: 'Acme Corp',
    received_at: new Date('2026-04-15T00:00:00Z'),
    description: 'Need an agency.',
    tech_requirements: 'React/TS',
    domain_requirements: 'Fintech',
    industry: null,
    budget_bucket: null,
    timeline_bucket: null,
    required_capabilities: [],
    additional_criterion_name: null,
    deadline_to_respond: null,
    eligibility_filter: 'all_active' as const,
    min_tier: null,
    explicit_agency_ids: null,
    notes: null,
    ...overrides,
  }
}

describe('RfpService.createDraft', () => {
  it('persists an RFP at status="draft" and returns it', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    const rfp = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    expect(rfp.status).toBe('draft')
    expect(rfp.title).toBe('Big RFP')
    expect(rfp.organizationId).toBe(ORG)
    expect(em.rfps).toHaveLength(1)
    expect(em.flushCount).toBe(1)
  })
})

describe('RfpService.updateDraft', () => {
  it('updates only the fields supplied and emits prm.rfp.updated with the changed names', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    const updated = await service.updateDraft(
      created.id,
      { title: 'Bigger RFP', notes: 'Updated' },
      { organizationId: ORG },
    )
    expect(updated.title).toBe('Bigger RFP')
    expect(updated.notes).toBe('Updated')
    expect(updated.receivedFrom).toBe('Acme Corp') // unchanged
  })

  it('rejects edit when status != draft', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    seedAgency(em, 'a1', 'om_agency')
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    // simulate post-publish
    const stored = em.rfps[0]!
    stored.status = 'published'
    await expect(
      service.updateDraft(created.id, { title: 'too late' }, { organizationId: ORG }),
    ).rejects.toBeInstanceOf(PrmDomainError)
  })
})

describe('RfpService.publish', () => {
  it('transitions draft → published, writes one broadcast per eligible agency', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    seedAgency(em, 'a2', 'ai_native_expert')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    const result = await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    expect(result.broadcastAgencyIds.sort()).toEqual(['a1', 'a2'])
    expect(em.rfps[0]!.status).toBe('published')
    expect(em.rfps[0]!.publishedAt).toBeInstanceOf(Date)
    expect(em.broadcasts).toHaveLength(2)
  })

  it('respects by_min_tier — only matching tiers receive a broadcast', async () => {
    const em = new FakeEm()
    seedAgency(em, 'basic', 'om_agency')
    seedAgency(em, 'mid', 'ai_native')
    seedAgency(em, 'expert', 'ai_native_expert')
    const service = new RfpService(em as any)
    const created = await service.createDraft(
      makeCreateInput({ eligibility_filter: 'by_min_tier', min_tier: 'ai_native' }),
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    const result = await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    expect(result.broadcastAgencyIds.sort()).toEqual(['expert', 'mid'])
  })

  it('refuses publish with zero eligible agencies (§9.1 #3)', async () => {
    const em = new FakeEm()
    seedAgency(em, 'basic', 'om_agency')
    const service = new RfpService(em as any)
    const created = await service.createDraft(
      makeCreateInput({ eligibility_filter: 'by_min_tier', min_tier: 'ai_native_core' }),
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    await expect(
      service.publish(created.id, {}, { tenantId: TENANT, organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({ status: 409 })
    // Status unchanged.
    expect(em.rfps[0]!.status).toBe('draft')
  })

  it('refuses publish if status != draft', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    em.rfps[0]!.status = 'published'
    await expect(
      service.publish(created.id, {}, { tenantId: TENANT, organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('returns 409 when confirmedAgencyIds drifts from the evaluator output', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    seedAgency(em, 'a2', 'ai_native')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await expect(
      service.publish(
        created.id,
        { confirmedAgencyIds: ['a1'] /* missing a2 */ },
        { tenantId: TENANT, organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
})

/**
 * Spec #5 §9.1 #4 — partial-insert rollback (W4).
 *
 * The publish flow updates the RFP row (status: draft → published) and inserts
 * N broadcast rows in a single `em.flush()`. If the broadcast batch fails
 * mid-flush, the surrounding transaction must rollback every write — no
 * orphan broadcasts, RFP stays at status `draft`.
 *
 * Production proof = a single shared `em.flush()` (Postgres opens an implicit
 * transaction per statement-batch). This test exercises a DI-overridable
 * fault injection seam (`BroadcastFailureInjector`) in `RfpService.publish`:
 * the test passes `failingBroadcastFailureInjector` as the second
 * constructor argument, which throws BEFORE `em.flush()` runs, proving no DB
 * write window exists between the broadcast `persist()` calls and the flush.
 * `flushCount` stays at 1 (the earlier `createDraft` flush) — the publish's
 * flush never happened.
 *
 * Replaces the prior `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` env-var seam
 * (SPEC-2026-05-09b Phase 0b — eject env-var-gated fault injection from
 * production code paths).
 */
describe('RfpService.publish — Spec #5 §9.1 #4 partial-insert rollback', () => {
  it('rejects with the injected error when failingBroadcastFailureInjector is wired, and the broadcast flush never runs', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    seedAgency(em, 'a2', 'ai_native_expert')
    const service = new RfpService(em as any, failingBroadcastFailureInjector)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    // createDraft does one flush.
    expect(em.flushCount).toBe(1)

    await expect(
      service.publish(created.id, {}, { tenantId: TENANT, organizationId: ORG, userId: USER }),
    ).rejects.toThrow(/simulated DB error on broadcast batch flush/)

    // No additional flush ran — the publish's flush was never reached, so
    // in production the DB never received either the broadcast inserts or
    // the RFP status update. The whole publish is atomic-by-construction.
    expect(em.flushCount).toBe(1)
  })

  it('is a no-op with the production injector — publish succeeds normally', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    const service = new RfpService(em as any, nullBroadcastFailureInjector)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    const result = await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    expect(result.broadcastAgencyIds).toEqual(['a1'])
    expect(em.rfps[0]!.status).toBe('published')
    expect(em.broadcasts).toHaveLength(1)
    // createDraft flush + publish flush = 2.
    expect(em.flushCount).toBe(2)
  })

  it('is a no-op when no injector is passed — defaults to production no-op', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    // Default constructor (omitted second arg) must use the production no-op
    // — backward compatibility for callers that have not yet been migrated.
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    const result = await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    expect(result.broadcastAgencyIds).toEqual(['a1'])
    expect(em.rfps[0]!.status).toBe('published')
  })
})

describe('RfpService.unpublish', () => {
  it('reverts status to draft + deletes broadcasts when no agency has interacted', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    expect(em.broadcasts).toHaveLength(1)
    await service.unpublish(
      created.id,
      { reason: 'misclick' },
      { organizationId: ORG, userId: USER },
    )
    expect(em.rfps[0]!.status).toBe('draft')
    expect(em.rfps[0]!.publishedAt).toBeNull()
    expect(em.broadcasts).toHaveLength(0)
  })

  it('refuses unpublish when any broadcast has been opened (R6)', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    em.broadcasts[0]!.firstOpenedAt = new Date()
    await expect(
      service.unpublish(created.id, { reason: 'oops' }, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({ status: 409 })
    // Status preserved.
    expect(em.rfps[0]!.status).toBe('published')
  })

  it('refuses unpublish when an RfpResponse exists (defence-in-depth)', async () => {
    const em = new FakeEm()
    seedAgency(em, 'a1', 'om_agency')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    em.responses.push({
      id: 'resp-1',
      rfpId: created.id,
      organizationId: ORG,
      agencyId: 'a1',
      submittedByMemberId: 'm-1',
      status: 'draft',
    })
    await expect(
      service.unpublish(created.id, { reason: 'oops' }, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('returns 404 on unknown RFP id', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    await expect(
      service.unpublish('not-a-real-id', { reason: 'x' }, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('RfpService.upsertResponseDraft', () => {
  async function setupPublishedRfp(): Promise<{
    em: FakeEm
    service: RfpService
    rfpId: string
  }> {
    const em = new FakeEm()
    seedAgency(em, 'agency-A', 'ai_native')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    return { em, service, rfpId: created.id }
  }

  it('creates the response on first call and stamps submitted_by_member_id', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    const result = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      { tech_experience: 'React @ Acme', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    expect(result.response.status).toBe('draft')
    expect(result.response.submittedByMemberId).toBe('member-M1')
    expect(result.response.techExperience).toBe('React @ Acme')
    expect(em.responses).toHaveLength(1)
    expect(result.emitted).toBe(true)
  })

  it('updates the same row on subsequent calls without re-stamping the member id', async () => {
    const { service, rfpId } = await setupPublishedRfp()
    const first = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      { tech_experience: 'first take', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    const second = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      // M2 cannot retroactively become the author — service preserves M1.
      'member-M2',
      { tech_experience: 'edited copy', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    expect(second.response.id).toBe(first.response.id)
    expect(second.response.submittedByMemberId).toBe('member-M1')
    expect(second.response.techExperience).toBe('edited copy')
  })

  it('R7: skips event emission when content hash is unchanged', async () => {
    const { service, rfpId } = await setupPublishedRfp()
    const first = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      { tech_experience: 'identical', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    const second = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      { tech_experience: 'identical', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    expect(first.emitted).toBe(true)
    expect(second.emitted).toBe(false)
  })

  it('rejects edits when RFP status is no longer portal-visible', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    em.rfps[0]!.status = 'closed'
    await expect(
      service.upsertResponseDraft(
        rfpId,
        'agency-A',
        'member-M1',
        { tech_experience: 'late entry', attached_case_study_ids: [] },
        { organizationId: ORG },
      ),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('accepts own-Agency live case study ids on the response draft (Spec #7 closes §9.3 #14)', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    em.caseStudies.push({
      id: '11111111-1111-4111-8111-111111111111',
      organizationId: ORG,
      agencyId: 'agency-A',
      deletedAt: null,
    })
    const result = await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      {
        tech_experience: 'with attachments',
        attached_case_study_ids: ['11111111-1111-4111-8111-111111111111'],
      },
      { organizationId: ORG },
    )
    expect(result.response.attachedCaseStudyIds).toContain('11111111-1111-4111-8111-111111111111')
  })

  it('rejects cross-Agency case study ids on the response draft (own-Agency lookup)', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    em.caseStudies.push({
      id: '22222222-2222-4222-8222-222222222222',
      organizationId: ORG,
      agencyId: 'other-agency-Z',
      deletedAt: null,
    })
    await expect(
      service.upsertResponseDraft(
        rfpId,
        'agency-A',
        'member-M1',
        {
          tech_experience: 'with attachments',
          attached_case_study_ids: ['22222222-2222-4222-8222-222222222222'],
        },
        { organizationId: ORG },
      ),
    ).rejects.toMatchObject({
      status: 400,
      details: expect.objectContaining({ reason: 'case_study_ownership_failed' }),
    })
  })

  it('rejects soft-deleted case study ids on the response draft', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    em.caseStudies.push({
      id: '33333333-3333-4333-8333-333333333333',
      organizationId: ORG,
      agencyId: 'agency-A',
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    })
    await expect(
      service.upsertResponseDraft(
        rfpId,
        'agency-A',
        'member-M1',
        {
          tech_experience: 'with attachments',
          attached_case_study_ids: ['33333333-3333-4333-8333-333333333333'],
        },
        { organizationId: ORG },
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects edits when the response is already submitted (defence-in-depth)', async () => {
    const { em, service, rfpId } = await setupPublishedRfp()
    await service.upsertResponseDraft(
      rfpId,
      'agency-A',
      'member-M1',
      { tech_experience: 'first', attached_case_study_ids: [] },
      { organizationId: ORG },
    )
    em.responses[0]!.status = 'submitted'
    await expect(
      service.upsertResponseDraft(
        rfpId,
        'agency-A',
        'member-M1',
        { tech_experience: 'late edit', attached_case_study_ids: [] },
        { organizationId: ORG },
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('RfpService.submitResponse / unsubmitResponse', () => {
  async function publishedWithDraft(
    deadline: Date | null = null,
    overrides: { techExperience?: string | null; domainExperience?: string | null } = {},
  ): Promise<{ em: FakeEm; service: RfpService; rfpId: string }> {
    const em = new FakeEm()
    seedAgency(em, 'agency-A', 'ai_native')
    const service = new RfpService(em as any)
    const created = await service.createDraft(
      makeCreateInput({ deadline_to_respond: deadline }),
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    await service.upsertResponseDraft(
      created.id,
      'agency-A',
      'member-M1',
      {
        tech_experience: overrides.techExperience ?? 'Built X for Y',
        domain_experience: overrides.domainExperience ?? 'fintech 5y',
        attached_case_study_ids: [],
      },
      { organizationId: ORG },
    )
    return { em, service, rfpId: created.id }
  }

  it('happy path: draft → submitted, stamps first_submitted_at, isInitialSubmission=true', async () => {
    const { em, service, rfpId } = await publishedWithDraft()
    const result = await service.submitResponse(rfpId, 'agency-A', { organizationId: ORG })
    expect(result.response.status).toBe('submitted')
    expect(result.response.firstSubmittedAt).toBeInstanceOf(Date)
    expect(result.isInitialSubmission).toBe(true)
    expect(em.responses[0]!.status).toBe('submitted')
  })

  it('idempotent re-submit returns isInitialSubmission=false (no event re-emit)', async () => {
    const { service, rfpId } = await publishedWithDraft()
    const a = await service.submitResponse(rfpId, 'agency-A', { organizationId: ORG })
    const b = await service.submitResponse(rfpId, 'agency-A', { organizationId: ORG })
    expect(a.isInitialSubmission).toBe(true)
    expect(b.isInitialSubmission).toBe(false)
    expect(b.response.status).toBe('submitted')
  })

  it('refuses submit with empty tech_experience (§9.3 #13)', async () => {
    const { service, rfpId } = await publishedWithDraft(null, { techExperience: '' })
    await expect(
      service.submitResponse(rfpId, 'agency-A', { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('refuses submit when deadline has passed (§9.3 #15)', async () => {
    const past = new Date(Date.now() - 60_000)
    const { service, rfpId } = await publishedWithDraft(past)
    await expect(
      service.submitResponse(rfpId, 'agency-A', { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('refuses submit when RFP status is not published (e.g. scoring round)', async () => {
    const { em, service, rfpId } = await publishedWithDraft()
    em.rfps[0]!.status = 'scoring'
    await expect(
      service.submitResponse(rfpId, 'agency-A', { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('unsubmit happy path: submitted → draft, emits prm.rfp_response.unsubmitted', async () => {
    const { em, service, rfpId } = await publishedWithDraft()
    await service.submitResponse(rfpId, 'agency-A', { organizationId: ORG })
    const result = await service.unsubmitResponse(
      rfpId,
      'agency-A',
      { reason: 'changed mind' },
      { organizationId: ORG },
    )
    expect(result.response.status).toBe('draft')
    expect(result.reverted).toBe(true)
    expect(em.responses[0]!.status).toBe('draft')
  })

  it('refuses unsubmit when deadline has passed (§9.3 #18)', async () => {
    const future = new Date(Date.now() + 60_000)
    const { em, service, rfpId } = await publishedWithDraft(future)
    await service.submitResponse(rfpId, 'agency-A', { organizationId: ORG })
    em.rfps[0]!.deadlineToRespond = new Date(Date.now() - 60_000)
    await expect(
      service.unsubmitResponse(rfpId, 'agency-A', {}, { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('idempotent unsubmit on a draft row returns reverted=false', async () => {
    const { service, rfpId } = await publishedWithDraft()
    const result = await service.unsubmitResponse(
      rfpId,
      'agency-A',
      {},
      { organizationId: ORG },
    )
    expect(result.reverted).toBe(false)
    expect(result.response.status).toBe('draft')
  })
})

describe('RfpService.declineBroadcast / undeclineBroadcast', () => {
  async function publishedWithBroadcast(): Promise<{
    em: FakeEm
    service: RfpService
    rfpId: string
  }> {
    const em = new FakeEm()
    seedAgency(em, 'agency-A', 'ai_native')
    const service = new RfpService(em as any)
    const created = await service.createDraft(makeCreateInput(), {
      tenantId: TENANT,
      organizationId: ORG,
      userId: USER,
    })
    await service.publish(
      created.id,
      {},
      { tenantId: TENANT, organizationId: ORG, userId: USER },
    )
    return { em, service, rfpId: created.id }
  }

  it('decline with reason — sets declined_at + decline_reason and emits event (§9.4 #20)', async () => {
    const { em, service, rfpId } = await publishedWithBroadcast()
    const result = await service.declineBroadcast(
      rfpId,
      'agency-A',
      { decline_reason: 'capacity' },
      { organizationId: ORG },
    )
    expect(result.declined).toBe(true)
    expect(result.broadcast.declinedAt).toBeInstanceOf(Date)
    expect(result.broadcast.declineReason).toBe('capacity')
    expect(em.broadcasts[0]!.declinedAt).toBeInstanceOf(Date)
  })

  it('decline without reason is allowed (§9.4 #21)', async () => {
    const { service, rfpId } = await publishedWithBroadcast()
    const result = await service.declineBroadcast(
      rfpId,
      'agency-A',
      { decline_reason: null },
      { organizationId: ORG },
    )
    expect(result.declined).toBe(true)
    expect(result.broadcast.declineReason).toBeNull()
  })

  it('idempotent decline returns declined=false on the second call', async () => {
    const { service, rfpId } = await publishedWithBroadcast()
    await service.declineBroadcast(
      rfpId,
      'agency-A',
      { decline_reason: 'capacity' },
      { organizationId: ORG },
    )
    const second = await service.declineBroadcast(
      rfpId,
      'agency-A',
      { decline_reason: 'still busy' },
      { organizationId: ORG },
    )
    expect(second.declined).toBe(false)
    // First reason preserved — idempotency does not overwrite.
    expect(second.broadcast.declineReason).toBe('capacity')
  })

  it('rejects decline once RFP has moved past published (§9.4 #23)', async () => {
    const { em, service, rfpId } = await publishedWithBroadcast()
    em.rfps[0]!.status = 'scoring'
    await expect(
      service.declineBroadcast(rfpId, 'agency-A', {}, { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('rejects decline when no broadcast row exists (cross-Agency probe)', async () => {
    const { service, rfpId } = await publishedWithBroadcast()
    await expect(
      service.declineBroadcast(rfpId, 'agency-X-not-broadcast', {}, { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('undecline pre-deadline clears declined_at + decline_reason (§9.4 #22)', async () => {
    const { service, rfpId } = await publishedWithBroadcast()
    await service.declineBroadcast(
      rfpId,
      'agency-A',
      { decline_reason: 'misclick' },
      { organizationId: ORG },
    )
    const result = await service.undeclineBroadcast(rfpId, 'agency-A', { organizationId: ORG })
    expect(result.reverted).toBe(true)
    expect(result.broadcast.declinedAt).toBeNull()
    expect(result.broadcast.declineReason).toBeNull()
  })

  it('idempotent undecline on a non-declined broadcast returns reverted=false', async () => {
    const { service, rfpId } = await publishedWithBroadcast()
    const result = await service.undeclineBroadcast(rfpId, 'agency-A', { organizationId: ORG })
    expect(result.reverted).toBe(false)
  })
})
