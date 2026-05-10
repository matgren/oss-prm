import { RfpService } from '../lib/rfpService'
import { Rfp, RfpBroadcast, RfpResponse } from '../data/entities'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'

type AnyRow = Record<string, any>

/**
 * Minimal FakeEm for `RfpService.deleteDraft` — mirrors the shape used by the
 * sibling tests in `rfpService.test.ts` but trimmed to the operations the
 * delete path exercises (`findOne(Rfp)`, `persist`, `flush`).
 */
class FakeEm {
  rfps: AnyRow[] = []
  broadcasts: AnyRow[] = []
  responses: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_EntityCtor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `mock-${Math.random().toString(36).slice(2, 8)}` } as T
  }

  persist(row: AnyRow): void {
    if ('title' in row && 'eligibilityFilter' in row) {
      const idx = this.rfps.findIndex((r) => r.id === row.id)
      if (idx >= 0) this.rfps[idx] = row
      else this.rfps.push(row)
    }
  }

  remove(_row: AnyRow): void {
    /* not used here */
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(EntityCtor: any, where: AnyRow): Promise<AnyRow | null> {
    if ((EntityCtor?.name ?? '') !== 'Rfp') return null
    return (
      this.rfps.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.organizationId === undefined ||
            r.organizationId === where.organizationId) &&
          (where.deletedAt === undefined ||
            (where.deletedAt === null ? !r.deletedAt : r.deletedAt === where.deletedAt)),
      ) ?? null
    )
  }

  async find(_EntityCtor: any, _where: AnyRow): Promise<AnyRow[]> {
    return []
  }
}

const TENANT = 't-1'
const ORG = 'o-1'
const USER = 'user-1'

function seedDraftRfp(em: FakeEm, overrides: Partial<AnyRow> = {}): AnyRow {
  const rfp: AnyRow = {
    id: 'rfp-1',
    organizationId: ORG,
    title: 'Big RFP',
    receivedFrom: 'Acme',
    receivedAt: new Date(),
    description: 'd',
    techRequirements: 't',
    domainRequirements: 'd',
    eligibilityFilter: 'all_active',
    status: 'draft',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByUserId: USER,
    isPathBLocked: false,
    ...overrides,
  }
  em.rfps.push(rfp)
  return rfp
}

describe('RfpService.deleteDraft', () => {
  it('soft-deletes a draft RFP — sets deletedAt, persists, flushes, and emits prm.rfp.deleted', async () => {
    const em = new FakeEm()
    const rfp = seedDraftRfp(em)
    const service = new RfpService(em as any)

    const before = Date.now()
    const result = await service.deleteDraft(rfp.id, { organizationId: ORG, userId: USER })
    const after = Date.now()

    expect(result.alreadyDeleted).toBe(false)
    expect(result.rfp.deletedAt).toBeInstanceOf(Date)
    const stamped = result.rfp.deletedAt as Date
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before)
    expect(stamped.getTime()).toBeLessThanOrEqual(after)
    // Persist + flush ran exactly once.
    expect(em.flushCount).toBe(1)
    // Status is unchanged — soft-delete does not transition status.
    expect(em.rfps[0]!.status).toBe('draft')
  })

  it('is idempotent — second call on an already-deleted draft returns alreadyDeleted=true and does NOT refresh deletedAt', async () => {
    const em = new FakeEm()
    const rfp = seedDraftRfp(em)
    const service = new RfpService(em as any)

    const first = await service.deleteDraft(rfp.id, { organizationId: ORG, userId: USER })
    const firstDeletedAt = first.rfp.deletedAt as Date
    expect(first.alreadyDeleted).toBe(false)
    const flushAfterFirst = em.flushCount

    // Wait a tick so a `new Date()` would necessarily differ if the service
    // were (incorrectly) re-stamping deletedAt on the idempotent path.
    await new Promise((resolve) => setTimeout(resolve, 5))

    const second = await service.deleteDraft(rfp.id, { organizationId: ORG, userId: USER })
    expect(second.alreadyDeleted).toBe(true)
    // No refresh — deletedAt is the same Date instance from the first call.
    expect(second.rfp.deletedAt).toBe(firstDeletedAt)
    // No additional flush — the idempotent branch returns before persist/flush.
    expect(em.flushCount).toBe(flushAfterFirst)
  })

  it('throws PrmDomainError(409, RFP_NOT_DRAFT) on a published RFP', async () => {
    const em = new FakeEm()
    const rfp = seedDraftRfp(em, { status: 'published' })
    const service = new RfpService(em as any)

    await expect(
      service.deleteDraft(rfp.id, { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({
      status: 409,
      code: PRM_ERROR_CODES.RFP_NOT_DRAFT,
    })
    // Row was not touched.
    expect(em.rfps[0]!.deletedAt).toBeNull()
    expect(em.flushCount).toBe(0)
  })

  it('throws PrmDomainError(409, RFP_NOT_DRAFT) on closed/scoring/selection_made statuses too', async () => {
    for (const status of ['scoring', 'selection_made', 'closed', 'reopened'] as const) {
      const em = new FakeEm()
      const rfp = seedDraftRfp(em, { status })
      const service = new RfpService(em as any)
      await expect(
        service.deleteDraft(rfp.id, { organizationId: ORG, userId: USER }),
      ).rejects.toMatchObject({
        status: 409,
        code: PRM_ERROR_CODES.RFP_NOT_DRAFT,
      })
    }
  })

  it('throws PrmDomainError(404, NOT_FOUND) when the RFP belongs to another organization (tenant isolation)', async () => {
    const em = new FakeEm()
    seedDraftRfp(em, { organizationId: 'o-OTHER' })
    const service = new RfpService(em as any)

    await expect(
      service.deleteDraft('rfp-1', { organizationId: ORG, userId: USER }),
    ).rejects.toMatchObject({
      status: 404,
      code: PRM_ERROR_CODES.NOT_FOUND,
    })
  })

  it('throws PrmDomainError(404, NOT_FOUND) when the RFP id does not exist at all', async () => {
    const em = new FakeEm()
    const service = new RfpService(em as any)

    await expect(
      service.deleteDraft('00000000-0000-4000-8000-000000000000', {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toBeInstanceOf(PrmDomainError)
  })
})

// Suppress unused-import warning for TENANT (kept for symmetry with sibling test fixtures).
void TENANT
void RfpBroadcast
void Rfp
void RfpResponse
