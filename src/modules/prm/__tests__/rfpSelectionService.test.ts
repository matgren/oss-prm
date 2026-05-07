import { RfpService } from '../lib/rfpService'
import { RfpResponseScoreRepo } from '../lib/rfpResponseScoreRepo'
import { PRM_ERROR_CODES } from '../lib/errors'

type AnyRow = Record<string, any>

/**
 * Spec #6 — RfpService.selectWinner / closeRfp / reopenRfp / expireReopenedDeadline tests.
 *
 * Uses a richer FakeEm that supports broadcasts, scores, and the
 * raw-SQL hard-guard query against `prm_license_deals`.
 */
class FakeEm {
  rfps: AnyRow[] = []
  broadcasts: AnyRow[] = []
  responses: AnyRow[] = []
  scores: AnyRow[] = []
  /** Synthetic LicenseDeal rows for the hard-guard query. */
  licenseDeals: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_Ctor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `mock-${Math.random().toString(36).slice(2, 8)}` } as T
  }

  persist(row: AnyRow): void {
    if (row.title !== undefined && row.eligibilityFilter !== undefined) {
      this.upsert(this.rfps, row)
    } else if (row.broadcastAt !== undefined) {
      this.upsert(this.broadcasts, row)
    } else if (row.submittedByMemberId !== undefined && row.rfpId !== undefined) {
      this.upsert(this.responses, row)
    } else if (row.version !== undefined && row.rfpResponseId !== undefined) {
      this.upsert(this.scores, row)
    }
  }

  remove(_row: AnyRow): void {
    /* not used */
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(Ctor: any, where: AnyRow): Promise<AnyRow | null> {
    const ctor = Ctor?.name ?? ''
    if (ctor === 'Rfp') {
      return this.rfps.find((r) =>
        (where.id === undefined || r.id === where.id) &&
        (where.organizationId === undefined || r.organizationId === where.organizationId) &&
        (where.deletedAt === undefined || (where.deletedAt === null ? !r.deletedAt : r.deletedAt === where.deletedAt)),
      ) ?? null
    }
    if (ctor === 'RfpResponse') {
      return this.responses.find((r) =>
        (where.id === undefined || r.id === where.id) &&
        (where.rfpId === undefined || r.rfpId === where.rfpId) &&
        (where.organizationId === undefined || r.organizationId === where.organizationId),
      ) ?? null
    }
    return null
  }

  async find(Ctor: any, where: AnyRow, opts?: AnyRow): Promise<AnyRow[]> {
    const ctor = Ctor?.name ?? ''
    if (ctor === 'Rfp') {
      return this.rfps.filter((r) => {
        if (where.organizationId && r.organizationId !== where.organizationId) return false
        if (where.status && r.status !== where.status) return false
        if (where.deletedAt === null && r.deletedAt) return false
        if (where.reopenedDeadlineAt) {
          const lt = (where.reopenedDeadlineAt as { $lt?: Date }).$lt
          if (lt instanceof Date) {
            if (!r.reopenedDeadlineAt || r.reopenedDeadlineAt.getTime() >= lt.getTime()) return false
          }
        }
        return true
      })
    }
    if (ctor === 'RfpResponseScore') {
      let rows = this.scores.filter((s) => {
        if (where.organizationId && s.organizationId !== where.organizationId) return false
        if (where.rfpResponseId !== undefined) {
          const target = where.rfpResponseId
          if (target && typeof target === 'object' && '$in' in target) {
            if (!(target.$in as string[]).includes(s.rfpResponseId)) return false
          } else if (target !== s.rfpResponseId) return false
        }
        return true
      })
      if (opts?.orderBy?.version === 'desc') rows = rows.slice().sort((a, b) => b.version - a.version)
      if (opts?.orderBy?.rfpResponseId === 'asc') {
        rows = rows.slice().sort((a, b) => {
          const cmp = a.rfpResponseId.localeCompare(b.rfpResponseId)
          if (cmp !== 0) return cmp
          return (b.version ?? 0) - (a.version ?? 0)
        })
      }
      if (typeof opts?.limit === 'number') rows = rows.slice(0, opts.limit)
      return rows
    }
    if (ctor === 'RfpResponse') {
      return this.responses.filter((r) =>
        (where.rfpId === undefined || r.rfpId === where.rfpId) &&
        (where.organizationId === undefined || r.organizationId === where.organizationId),
      )
    }
    if (ctor === 'RfpBroadcast') {
      return this.broadcasts.filter((b) =>
        (where.rfpId === undefined || b.rfpId === where.rfpId),
      )
    }
    return []
  }

  getConnection() {
    const self = this
    return {
      async execute<T = any>(sql: string, params?: unknown[]): Promise<T> {
        if (sql.includes('max(version)') && params && params.length > 0) {
          const responseId = params[0] as string
          const peers = self.scores.filter((s) => s.rfpResponseId === responseId)
          const max = peers.length === 0 ? null : Math.max(...peers.map((p) => p.version))
          return [{ max }] as unknown as T
        }
        if (sql.includes('"prm_license_deals"') && params && params.length > 0) {
          const rfpId = params[0] as string
          const matching = self.licenseDeals.filter(
            (d) => d.rfpId === rfpId && (d.status === 'signed' || d.status === 'active') && !d.deletedAt,
          )
          return matching.slice(0, 1).map((d) => ({ id: d.id })) as unknown as T
        }
        return [] as unknown as T
      },
    }
  }

  private upsert(arr: AnyRow[], row: AnyRow): void {
    const idx = arr.findIndex((r) => r.id === row.id)
    if (idx >= 0) arr[idx] = row
    else arr.push(row)
  }
}

const ORG = 'o-1'
const USER = 'staff-1'
const RFP_ID = 'rfp-1'

function seedRfp(em: FakeEm, status: string = 'scoring', isPathBLocked = false) {
  em.rfps.push({
    id: RFP_ID,
    organizationId: ORG,
    title: 'RFP',
    receivedFrom: 'Acme',
    eligibilityFilter: 'all_active',
    status,
    selectedAgencyId: null,
    selectionDecidedAt: null,
    selectionDecidedByUserId: null,
    selectionReasoning: null,
    isPathBLocked,
    deletedAt: null,
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

function seedBroadcast(em: FakeEm, agencyId: string) {
  em.broadcasts.push({
    id: `broadcast-${agencyId}`,
    rfpId: RFP_ID,
    organizationId: ORG,
    agencyId,
    broadcastAt: new Date(),
    firstOpenedAt: null,
    declinedAt: null,
    declineReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

function seedResponse(em: FakeEm, id: string, agencyId: string) {
  em.responses.push({
    id,
    rfpId: RFP_ID,
    organizationId: ORG,
    agencyId,
    submittedByMemberId: 'mem-' + agencyId,
    status: 'submitted',
    techExperience: 'tech',
    domainExperience: 'domain',
    differentiators: null,
    attachedCaseStudyIds: [],
    firstSubmittedAt: new Date(),
    lastUpdatedAt: new Date(),
    createdAt: new Date(),
  })
}

async function recordScore(em: FakeEm, responseId: string) {
  const repo = new RfpResponseScoreRepo(em as any)
  await repo.insertNextVersion({
    rfpResponseId: responseId,
    organizationId: ORG,
    scoredByUserId: USER,
    techFitScore: 4,
    domainFitScore: 3,
    optionalScore: null,
    includeOptional: false,
    reasoning: 'reasoning string here',
    source: 'manual',
    llmModelId: null,
    changeReason: null,
  })
}

describe('RfpService.selectWinner', () => {
  it('happy path: scoring → selection_made, emits selection_made', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedBroadcast(em, 'agency-A')
    seedBroadcast(em, 'agency-B')
    seedResponse(em, 'resp-A', 'agency-A')
    seedResponse(em, 'resp-B', 'agency-B')
    await recordScore(em, 'resp-A')
    await recordScore(em, 'resp-B')

    const service = new RfpService(em as any)
    const result = await service.selectWinner(
      RFP_ID,
      {
        winner_rfp_response_id: 'resp-A',
        selection_reasoning: 'Strong tech depth + named-client evidence.',
      },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.status).toBe('selection_made')
    expect(result.rfp.selectedAgencyId).toBe('agency-A')
    expect(result.rfp.selectionReasoning).toContain('Strong tech depth')
    expect(result.runnersUpAgencyIds).toContain('agency-B')
    expect(result.runnersUpAgencyIds).not.toContain('agency-A')
    expect(result.isReselection).toBe(false)
  })

  it('re-selection from selection_made → selection_changed semantics', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made')
    em.rfps[0]!.selectedAgencyId = 'agency-A'
    seedBroadcast(em, 'agency-A')
    seedBroadcast(em, 'agency-B')
    seedResponse(em, 'resp-A', 'agency-A')
    seedResponse(em, 'resp-B', 'agency-B')
    await recordScore(em, 'resp-A')
    await recordScore(em, 'resp-B')

    const service = new RfpService(em as any)
    const result = await service.selectWinner(
      RFP_ID,
      {
        winner_rfp_response_id: 'resp-B',
        selection_reasoning: 'Re-selecting after challenge round review.',
      },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.selectedAgencyId).toBe('agency-B')
    expect(result.isReselection).toBe(true)
    expect(result.priorWinner?.agencyId).toBe('agency-A')
  })

  it('rejects with NO_SCORED_RESPONSES when zero scores exist on the RFP', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'resp-A', 'agency-A')
    // No score recorded.
    const service = new RfpService(em as any)
    await expect(
      service.selectWinner(
        RFP_ID,
        {
          winner_rfp_response_id: 'resp-A',
          selection_reasoning: 'Strong response — but unscored.',
        },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.WINNER_NOT_SCORED,
      status: 409,
    })
  })

  it('rejects with WINNER_NOT_SCORED when winner has no scores (others do)', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'resp-A', 'agency-A')
    seedResponse(em, 'resp-B', 'agency-B')
    await recordScore(em, 'resp-B')
    const service = new RfpService(em as any)
    await expect(
      service.selectWinner(
        RFP_ID,
        {
          winner_rfp_response_id: 'resp-A',
          selection_reasoning: 'I want to pick A but A has no score.',
        },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.WINNER_NOT_SCORED,
      status: 409,
    })
  })

  it('rejects from invalid status (draft/published) with INVALID_RFP_TRANSITION', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    seedResponse(em, 'resp-A', 'agency-A')
    await recordScore(em, 'resp-A')
    const service = new RfpService(em as any)
    await expect(
      service.selectWinner(
        RFP_ID,
        {
          winner_rfp_response_id: 'resp-A',
          selection_reasoning: 'Selecting a published RFP should fail.',
        },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
      status: 409,
    })
  })

  it('rejects unknown winner response with 404', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'resp-A', 'agency-A')
    await recordScore(em, 'resp-A')
    const service = new RfpService(em as any)
    await expect(
      service.selectWinner(
        RFP_ID,
        {
          winner_rfp_response_id: 'resp-ghost',
          selection_reasoning: 'Trying to select a phantom response.',
        },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('RfpService.closeRfp', () => {
  it('closes from selection_made (with selection) — close_reason optional', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made')
    em.rfps[0]!.selectedAgencyId = 'agency-A'
    const service = new RfpService(em as any)
    const result = await service.closeRfp(RFP_ID, {}, { organizationId: ORG, userId: USER })
    expect(result.rfp.status).toBe('closed')
    expect(result.finalSelectedAgencyId).toBe('agency-A')
  })

  it('rejects close-without-selection without close_reason → 400', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    const service = new RfpService(em as any)
    await expect(
      service.closeRfp(RFP_ID, {}, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.CLOSE_REASON_REQUIRED,
      status: 400,
    })
  })

  it('closes from scoring with close_reason → no selection, status=closed', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    const service = new RfpService(em as any)
    const result = await service.closeRfp(
      RFP_ID,
      { close_reason: 'Client withdrew funding.' },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.status).toBe('closed')
    expect(result.finalSelectedAgencyId).toBeNull()
  })

  it('rejects close from draft → 409', async () => {
    const em = new FakeEm()
    seedRfp(em, 'draft')
    const service = new RfpService(em as any)
    await expect(
      service.closeRfp(RFP_ID, { close_reason: 'short test' }, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
      status: 409,
    })
  })
})

describe('RfpService.reopenRfp — invariant #17 hard guard', () => {
  function deadlineFuture() {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }
  function deadlinePast() {
    return new Date(Date.now() - 60_000)
  }

  it('happy path: selection_made → reopened with future deadline', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', false)
    const service = new RfpService(em as any)
    const result = await service.reopenRfp(
      RFP_ID,
      { reopen_reason: 'Client added a new requirement.', reopened_deadline_at: deadlineFuture() },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.status).toBe('reopened')
    expect(result.rfp.reopenedDeadlineAt).toBeInstanceOf(Date)
  })

  it('rejects with PATH_B_SIGNED_DEAL_LOCK on read-model true', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', /* isPathBLocked */ true)
    em.licenseDeals.push({ id: 'deal-1', rfpId: RFP_ID, status: 'signed', deletedAt: null })
    const service = new RfpService(em as any)
    await expect(
      service.reopenRfp(
        RFP_ID,
        { reopen_reason: 'Trying to reopen a locked RFP.', reopened_deadline_at: deadlineFuture() },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.PATH_B_SIGNED_DEAL_LOCK,
      status: 409,
      details: { license_deal_id: 'deal-1' },
    })
  })

  it('rejects via live re-check when read-model is stale (false but live row exists)', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', /* isPathBLocked */ false)
    em.licenseDeals.push({ id: 'deal-stale', rfpId: RFP_ID, status: 'signed', deletedAt: null })
    const service = new RfpService(em as any)
    await expect(
      service.reopenRfp(
        RFP_ID,
        { reopen_reason: 'Read-model lag scenario.', reopened_deadline_at: deadlineFuture() },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.PATH_B_SIGNED_DEAL_LOCK,
      status: 409,
      details: { license_deal_id: 'deal-stale' },
    })
  })

  it('rejects deadline in the past with 400', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', false)
    const service = new RfpService(em as any)
    await expect(
      service.reopenRfp(
        RFP_ID,
        { reopen_reason: 'Past deadline.', reopened_deadline_at: deadlinePast() },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.DEADLINE_IN_PAST,
      status: 400,
    })
  })

  it('rejects reopen from invalid status (e.g. draft)', async () => {
    const em = new FakeEm()
    seedRfp(em, 'draft', false)
    const service = new RfpService(em as any)
    await expect(
      service.reopenRfp(
        RFP_ID,
        { reopen_reason: 'Trying to reopen a draft.', reopened_deadline_at: deadlineFuture() },
        { organizationId: ORG, userId: USER },
      ),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
      status: 409,
    })
  })

  it('reopens from closed status with no Path-B lock', async () => {
    const em = new FakeEm()
    seedRfp(em, 'closed', false)
    const service = new RfpService(em as any)
    const result = await service.reopenRfp(
      RFP_ID,
      { reopen_reason: 'Client wants to revisit.', reopened_deadline_at: deadlineFuture() },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.status).toBe('reopened')
    expect(result.rfp.closedAt).toBeNull()
  })

  it('ignores churned/pending license deals — only signed/active lock', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', false)
    em.licenseDeals.push({ id: 'deal-pending', rfpId: RFP_ID, status: 'pending', deletedAt: null })
    em.licenseDeals.push({ id: 'deal-churned', rfpId: RFP_ID, status: 'churned', deletedAt: null })
    const service = new RfpService(em as any)
    const result = await service.reopenRfp(
      RFP_ID,
      { reopen_reason: 'No active lock present.', reopened_deadline_at: new Date(Date.now() + 86_400_000) },
      { organizationId: ORG, userId: USER },
    )
    expect(result.rfp.status).toBe('reopened')
  })
})

describe('RfpService.expireReopenedDeadline', () => {
  it('transitions reopened → scoring when deadline has passed', async () => {
    const em = new FakeEm()
    seedRfp(em, 'reopened', false)
    em.rfps[0]!.reopenedDeadlineAt = new Date(Date.now() - 1_000)
    const service = new RfpService(em as any)
    const result = await service.expireReopenedDeadline(RFP_ID, { organizationId: ORG })
    expect(result.expired).toBe(true)
    expect(result.rfp?.status).toBe('scoring')
    expect(result.rfp?.reopenedDeadlineAt).toBeNull()
  })

  it('is a no-op when deadline is in the future', async () => {
    const em = new FakeEm()
    seedRfp(em, 'reopened', false)
    em.rfps[0]!.reopenedDeadlineAt = new Date(Date.now() + 86_400_000)
    const service = new RfpService(em as any)
    const result = await service.expireReopenedDeadline(RFP_ID, { organizationId: ORG })
    expect(result.expired).toBe(false)
    expect(result.rfp?.status).toBe('reopened')
  })

  it('is a no-op when RFP is not in reopened status', async () => {
    const em = new FakeEm()
    seedRfp(em, 'selection_made', false)
    const service = new RfpService(em as any)
    const result = await service.expireReopenedDeadline(RFP_ID, { organizationId: ORG })
    expect(result.expired).toBe(false)
  })

  it('returns gracefully on unknown RFP', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    const result = await service.expireReopenedDeadline('nope', { organizationId: ORG })
    expect(result.expired).toBe(false)
    expect(result.rfp).toBeNull()
  })
})

describe('RfpService.sweepExpiredReopenedDeadlines', () => {
  it('sweeps every reopened RFP whose deadline has passed', async () => {
    const em = new FakeEm()
    em.rfps.push({
      id: 'rfp-A',
      organizationId: ORG,
      title: 'A',
      eligibilityFilter: 'all_active',
      status: 'reopened',
      reopenedDeadlineAt: new Date(Date.now() - 60_000),
      isPathBLocked: false,
      deletedAt: null,
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.rfps.push({
      id: 'rfp-B',
      organizationId: ORG,
      title: 'B',
      eligibilityFilter: 'all_active',
      status: 'reopened',
      reopenedDeadlineAt: new Date(Date.now() + 86_400_000), // future
      isPathBLocked: false,
      deletedAt: null,
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.rfps.push({
      id: 'rfp-C',
      organizationId: ORG,
      title: 'C',
      eligibilityFilter: 'all_active',
      status: 'reopened',
      reopenedDeadlineAt: new Date(Date.now() - 30_000),
      isPathBLocked: false,
      deletedAt: null,
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const service = new RfpService(em as any)
    const expiredIds = await service.sweepExpiredReopenedDeadlines({ organizationId: ORG })
    expect(expiredIds.sort()).toEqual(['rfp-A', 'rfp-C'])
    // The future-deadline RFP is untouched.
    const stillReopened = em.rfps.find((r) => r.id === 'rfp-B')
    expect(stillReopened?.status).toBe('reopened')
    // The expired RFPs got reset to scoring.
    expect(em.rfps.find((r) => r.id === 'rfp-A')?.status).toBe('scoring')
    expect(em.rfps.find((r) => r.id === 'rfp-C')?.status).toBe('scoring')
  })

  it('returns empty array when nothing to sweep', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)
    const expiredIds = await service.sweepExpiredReopenedDeadlines({ organizationId: ORG })
    expect(expiredIds).toEqual([])
  })
})
