import {
  compensateAttributionSaga,
  executeAttributionSaga,
  type AttributionSagaArgs,
} from '../lib/attributionSaga'
import { LicenseDeal, Prospect } from '../data/entities'

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }

type Persisted = Record<string, unknown> & { id?: string }

class FakeEntityManager {
  rows = new Map<string, Persisted[]>()
  flushed = 0
  knexMock = jest.fn()

  setSeed(table: string, rows: Persisted[]): void {
    this.rows.set(table, rows)
  }
  async findOne(EntityCtor: any, where: Record<string, unknown>): Promise<Persisted | null> {
    const table = tableForCtor(EntityCtor)
    const rows = this.rows.get(table) ?? []
    return (
      rows.find((row) =>
        Object.entries(where).every(([key, value]) => {
          if (value === null) return row[key] === null || row[key] === undefined
          return row[key] === value
        }),
      ) ?? null
    )
  }
  async flush(): Promise<void> {
    this.flushed += 1
  }
  getKnex(): any {
    return this.knexMock
  }
}

function tableForCtor(ctor: unknown): string {
  if (ctor === LicenseDeal) return 'license_deal'
  if (ctor === Prospect) return 'prospect'
  return 'unknown'
}

const TENANT = 'tenant-1'
const ORG = 'org-1'

beforeEach(() => {
  safeEmit.mockClear()
})

describe('executeAttributionSaga (forward)', () => {
  it('Path A: snapshots agency_id when missing then triggers prospect→won', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      {
        id: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'A',
        attributionSource: 'prospect',
        prospectId: 'prospect-1',
        attributedAgencyId: null,
        version: 2,
        deletedAt: null,
      },
    ])
    em.setSeed('prospect', [
      {
        id: 'prospect-1',
        tenantId: TENANT,
        organizationId: ORG,
        agencyId: 'agency-1',
        status: 'qualified',
        statusChangedAt: new Date(),
        deletedAt: null,
      },
    ])
    const transitionStatus = jest.fn().mockResolvedValue({ id: 'prospect-1', status: 'won' })
    const containerStub = {
      resolve: (name: string) => {
        if (name === 'prospectService') return { transitionStatus }
        throw new Error(`unknown DI key ${name}`)
      },
    } as any

    const args: AttributionSagaArgs = {
      licenseDealId: 'deal-1',
      tenantId: TENANT,
      organizationId: ORG,
      attributionPath: 'A',
      attributionSource: 'prospect',
      prospectId: 'prospect-1',
      rfpId: null,
      attributedAgencyId: null,
      correlationKey: 'deal-1:prospect',
    }

    const result = await executeAttributionSaga(args, { em: em as any, container: containerStub })
    expect(result.applied).toBe(true)
    expect(result.activitiesRun).toEqual(['snapshotProspect', 'markProspectWon'])
    expect(transitionStatus).toHaveBeenCalledWith(
      'prospect-1',
      expect.objectContaining({ toStatus: 'won' }),
      expect.objectContaining({ actor: expect.objectContaining({ type: 'system' }) }),
    )
    const refreshed = em.rows.get('license_deal')![0]
    expect(refreshed.attributedAgencyId).toBe('agency-1')
  })

  it('Path A: idempotent re-fire — snapshot already set, prospect already won', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      {
        id: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'A',
        attributionSource: 'prospect',
        prospectId: 'prospect-1',
        attributedAgencyId: 'agency-1',
        version: 5,
        deletedAt: null,
      },
    ])
    em.setSeed('prospect', [
      {
        id: 'prospect-1',
        tenantId: TENANT,
        organizationId: ORG,
        agencyId: 'agency-1',
        status: 'won',
        statusChangedAt: new Date(),
        deletedAt: null,
      },
    ])
    const transitionStatus = jest.fn()
    const containerStub = {
      resolve: () => ({ transitionStatus }),
    } as any
    const result = await executeAttributionSaga(
      {
        licenseDealId: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'A',
        attributionSource: 'prospect',
        prospectId: 'prospect-1',
        attributedAgencyId: 'agency-1',
        correlationKey: 'deal-1:prospect',
      },
      { em: em as any, container: containerStub },
    )
    expect(result.applied).toBe(true)
    expect(result.activitiesRun).toEqual([]) // both steps are no-ops
    expect(transitionStatus).not.toHaveBeenCalled()
  })

  it('Path C: noop (no activities to run)', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      {
        id: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'C',
        attributionSource: 'direct',
        attributedAgencyId: 'agency-1',
        version: 2,
        deletedAt: null,
      },
    ])
    const result = await executeAttributionSaga(
      {
        licenseDealId: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'C',
        attributionSource: 'direct',
        attributedAgencyId: 'agency-1',
        correlationKey: 'deal-1:direct',
      },
      { em: em as any },
    )
    expect(result.applied).toBe(true)
    expect(result.pathInvoked).toBe('C')
  })

  it('skips when the LicenseDeal attribution_path no longer matches the event', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      {
        id: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'none',
        attributionSource: 'direct',
        version: 7,
        deletedAt: null,
      },
    ])
    const result = await executeAttributionSaga(
      {
        licenseDealId: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        attributionPath: 'A',
        attributionSource: 'prospect',
        prospectId: 'prospect-1',
        correlationKey: 'deal-1:prospect',
      },
      { em: em as any },
    )
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('attribution-path-changed')
  })
})

describe('compensateAttributionSaga (reverse)', () => {
  it('Path A: prospect won → qualified runs BEFORE the snapshot clear (LIFO)', async () => {
    const em = new FakeEntityManager()
    em.setSeed('prospect', [
      {
        id: 'prospect-1',
        tenantId: TENANT,
        organizationId: ORG,
        agencyId: 'agency-1',
        status: 'won',
        statusChangedAt: new Date(),
        deletedAt: null,
      },
    ])
    // Mock the knex chain used by the compensation handler.
    const updateMock = jest.fn().mockResolvedValue(1)
    const knex = jest.fn(() => ({
      where() {
        return this
      },
      update: updateMock,
    }))
    em.knexMock = knex as any
    const containerStub = {
      resolve: () => ({}),
    } as any

    const result = await compensateAttributionSaga(
      {
        licenseDealId: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        previousAttribution: {
          path: 'A',
          source: 'prospect',
          prospectId: 'prospect-1',
          rfpId: null,
          attributedAgencyId: 'agency-1',
        },
        reason: 'reassign per finance audit ticket',
      },
      { em: em as any, container: containerStub },
    )
    expect(result.applied).toBe(true)
    expect(result.activitiesRun).toEqual([
      'compensate.markProspectQualified',
      'compensate.unsnapshotProspect',
    ])
  })

  it('Path C: noop', async () => {
    const em = new FakeEntityManager()
    const result = await compensateAttributionSaga(
      {
        licenseDealId: 'deal-1',
        tenantId: TENANT,
        organizationId: ORG,
        previousAttribution: {
          path: 'C',
          source: 'direct',
          prospectId: null,
          rfpId: null,
          attributedAgencyId: 'agency-1',
        },
        reason: 'cancel direct attribution',
      },
      { em: em as any },
    )
    expect(result.applied).toBe(true)
    expect(result.activitiesRun).toEqual([])
  })
})
