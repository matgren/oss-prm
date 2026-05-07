import { RfpService } from '../lib/rfpService'
import { RfpResponseScoreRepo } from '../lib/rfpResponseScoreRepo'
import {
  Rfp,
  RfpResponse,
  RfpResponseScore,
} from '../data/entities'
import { PRM_ERROR_CODES } from '../lib/errors'

type AnyRow = Record<string, any>

/**
 * Spec #6 — RfpResponseScore append-only repo + RfpService.recordScore.
 *
 * Uses a focused FakeEm that supports the subset of MikroORM surface used
 * by the score code paths: `find`, `findOne`, `create`, `persist`, `flush`,
 * and `getConnection().execute(...)` for the next-version MAX query.
 */
class FakeEm {
  rfps: AnyRow[] = []
  responses: AnyRow[] = []
  scores: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_Ctor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `mock-${Math.random().toString(36).slice(2, 8)}` } as T
  }

  persist(row: AnyRow): void {
    if (row.title !== undefined && row.eligibilityFilter !== undefined) {
      this.upsert(this.rfps, row)
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
      if (opts?.orderBy?.version === 'desc') {
        rows = rows.slice().sort((a, b) => b.version - a.version)
      }
      if (opts?.orderBy?.version === 'asc') {
        rows = rows.slice().sort((a, b) => a.version - b.version)
      }
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
    return []
  }

  getConnection() {
    const self = this
    return {
      async execute<T = any>(sql: string, params?: unknown[]): Promise<T> {
        // We only support the single MAX query the repo uses.
        if (sql.includes('max(version)') && params && params.length > 0) {
          const responseId = params[0] as string
          const peers = self.scores.filter((s) => s.rfpResponseId === responseId)
          const max = peers.length === 0 ? null : Math.max(...peers.map((p) => p.version))
          return [{ max }] as unknown as T
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
const RESPONSE_ID = 'resp-1'
const AGENCY_ID = 'agency-1'

function seedRfp(em: FakeEm, status: string = 'published') {
  em.rfps.push({
    id: RFP_ID,
    organizationId: ORG,
    title: 'RFP',
    eligibilityFilter: 'all_active',
    status,
    isPathBLocked: false,
    deletedAt: null,
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

function seedResponse(em: FakeEm, status: string = 'submitted') {
  em.responses.push({
    id: RESPONSE_ID,
    rfpId: RFP_ID,
    organizationId: ORG,
    agencyId: AGENCY_ID,
    submittedByMemberId: 'mem-1',
    status,
    techExperience: 'tech',
    domainExperience: 'domain',
    differentiators: null,
    attachedCaseStudyIds: [],
    firstSubmittedAt: new Date(),
    lastUpdatedAt: new Date(),
    createdAt: new Date(),
  })
}

function makeManualPayload(overrides: Partial<any> = {}) {
  return {
    tech_fit_score: 4,
    domain_fit_score: 3,
    optional_score: null,
    include_optional: false,
    reasoning: 'Strong tech depth + relevant domain experience cited.',
    source: 'manual' as const,
    llm_model_id: null,
    ...overrides,
  }
}

describe('RfpResponseScoreRepo (append-only)', () => {
  it('first insertNextVersion → version=1', async () => {
    const em = new FakeEm()
    const repo = new RfpResponseScoreRepo(em as any)
    const row = await repo.insertNextVersion({
      rfpResponseId: RESPONSE_ID,
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
    expect(row.version).toBe(1)
    expect(em.scores).toHaveLength(1)
  })

  it('second insertNextVersion → version=2 (append-only)', async () => {
    const em = new FakeEm()
    const repo = new RfpResponseScoreRepo(em as any)
    await repo.insertNextVersion({
      rfpResponseId: RESPONSE_ID,
      organizationId: ORG,
      scoredByUserId: USER,
      techFitScore: 4,
      domainFitScore: 3,
      optionalScore: null,
      includeOptional: false,
      reasoning: 'first version',
      source: 'manual',
      llmModelId: null,
      changeReason: null,
    })
    const row2 = await repo.insertNextVersion({
      rfpResponseId: RESPONSE_ID,
      organizationId: ORG,
      scoredByUserId: USER,
      techFitScore: 5,
      domainFitScore: 4,
      optionalScore: null,
      includeOptional: false,
      reasoning: 'corrected after agency clarification',
      source: 'manual',
      llmModelId: null,
      changeReason: 'undo of v1: missed evidence',
    })
    expect(row2.version).toBe(2)
    expect(em.scores).toHaveLength(2)
    // Both rows are still readable (append-only).
    const history = await repo.findHistory(RESPONSE_ID, { organizationId: ORG })
    expect(history).toHaveLength(2)
    expect(history[0]?.version).toBe(1)
    expect(history[1]?.version).toBe(2)
  })

  it('exposes only insertNextVersion / findLatest / findHistory / findLatestForResponses (append-only contract)', () => {
    const repo: any = new RfpResponseScoreRepo({} as any)
    expect(typeof repo.insertNextVersion).toBe('function')
    expect(typeof repo.findLatest).toBe('function')
    expect(typeof repo.findHistory).toBe('function')
    expect(typeof repo.findLatestForResponses).toBe('function')
    // No update / remove surface — invariant #18.
    expect(repo.update).toBeUndefined()
    expect(repo.remove).toBeUndefined()
  })

  it('findLatest returns the highest-version row', async () => {
    const em = new FakeEm()
    const repo = new RfpResponseScoreRepo(em as any)
    for (let i = 0; i < 3; i++) {
      await repo.insertNextVersion({
        rfpResponseId: RESPONSE_ID,
        organizationId: ORG,
        scoredByUserId: USER,
        techFitScore: i,
        domainFitScore: i,
        optionalScore: null,
        includeOptional: false,
        reasoning: 'reasoning string here',
        source: 'manual',
        llmModelId: null,
        changeReason: i === 0 ? null : `undo of v${i}`,
      })
    }
    const latest = await repo.findLatest(RESPONSE_ID, { organizationId: ORG })
    expect(latest?.version).toBe(3)
    expect(latest?.techFitScore).toBe(2)
  })
})

describe('RfpService.recordScore', () => {
  it('first score on a published RFP transitions status to scoring', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    const result = await service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
      organizationId: ORG,
      userId: USER,
    })
    expect(result.score.version).toBe(1)
    expect(result.rfp.status).toBe('scoring')
    expect(result.isInitialScoreOnRfp).toBe(true)
  })

  it('subsequent score on a scoring RFP keeps status="scoring" (no double-transition)', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    const result = await service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
      organizationId: ORG,
      userId: USER,
    })
    expect(result.rfp.status).toBe('scoring')
    expect(result.isInitialScoreOnRfp).toBe(false)
  })

  it('re-score without change_reason → 409 CHANGE_REASON_REQUIRED', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    await service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
      organizationId: ORG,
      userId: USER,
    })
    await expect(
      service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload({ tech_fit_score: 5 }), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.CHANGE_REASON_REQUIRED,
      status: 409,
    })
  })

  it('re-score with change_reason → v2 inserted', async () => {
    const em = new FakeEm()
    seedRfp(em, 'scoring')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    await service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
      organizationId: ORG,
      userId: USER,
    })
    const result = await service.recordScore(
      RFP_ID,
      RESPONSE_ID,
      makeManualPayload({ tech_fit_score: 5, change_reason: 'corrected after evidence review' }),
      { organizationId: ORG, userId: USER },
    )
    expect(result.score.version).toBe(2)
    expect(result.score.changeReason).toBe('corrected after evidence review')
  })

  it('rejects scoring on a closed RFP → 409 RFP_NOT_ACCEPTING_SCORES', async () => {
    const em = new FakeEm()
    seedRfp(em, 'closed')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    await expect(
      service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.RFP_NOT_ACCEPTING_SCORES,
      status: 409,
    })
  })

  it('rejects scoring a draft response → 409 RESPONSE_NOT_SUBMITTED', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    seedResponse(em, 'draft')
    const service = new RfpService(em as any)

    await expect(
      service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.RESPONSE_NOT_SUBMITTED,
      status: 409,
    })
  })

  it('rejects unknown response → 404 RFP_RESPONSE_NOT_FOUND', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    const service = new RfpService(em as any)

    await expect(
      service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
      status: 404,
    })
  })

  it('rejects unknown RFP → 404 NOT_FOUND', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)

    await expect(
      service.recordScore(RFP_ID, RESPONSE_ID, makeManualPayload(), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('records llm_assisted source with llm_model_id captured', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    const result = await service.recordScore(
      RFP_ID,
      RESPONSE_ID,
      makeManualPayload({
        source: 'llm_assisted',
        llm_model_id: 'anthropic:claude-sonnet-4-test',
      }),
      { organizationId: ORG, userId: USER },
    )
    expect(result.score.source).toBe('llm_assisted')
    expect(result.score.llmModelId).toBe('anthropic:claude-sonnet-4-test')
  })

  it('total_score includes optional_score only when include_optional=true', async () => {
    const em = new FakeEm()
    seedRfp(em, 'published')
    seedResponse(em, 'submitted')
    const service = new RfpService(em as any)

    const result = await service.recordScore(
      RFP_ID,
      RESPONSE_ID,
      makeManualPayload({ tech_fit_score: 4, domain_fit_score: 3, optional_score: 5, include_optional: true }),
      { organizationId: ORG, userId: USER },
    )
    expect(result.score.optionalScore).toBe(5)
    expect(result.score.includeOptional).toBe(true)
  })
})
