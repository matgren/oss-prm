import { AgencyService } from '../lib/agencyService'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'
import { Agency } from '../data/entities'

type Persisted = Record<string, unknown> & { id?: string }

class FakeEntityManager {
  rows = new Map<string, Persisted[]>()
  flushed = 0
  shouldThrowOnFlush: Error | null = null

  setSeed(table: string, rows: Persisted[]): void {
    this.rows.set(table, rows)
  }

  create<T extends Persisted>(EntityCtor: any, payload: T): T {
    const table = EntityCtor === Agency ? 'agency' : EntityCtor?.name === 'Tenant' ? 'tenant' : 'organization'
    const row = { id: payload.id ?? `mock-${table}-${Math.random().toString(36).slice(2, 8)}`, ...payload }
    if (!this.rows.has(table)) this.rows.set(table, [])
    this.rows.get(table)!.push(row)
    return row as T
  }

  persist(_row: unknown): void {
    // no-op — create() already added it.
  }

  async findOne(EntityCtor: any, where: Record<string, unknown>): Promise<Persisted | null> {
    const table = EntityCtor === Agency ? 'agency' : EntityCtor?.name === 'Tenant' ? 'tenant' : 'organization'
    const rows = this.rows.get(table) ?? []
    const match = rows.find((row) => {
      return Object.entries(where).every(([key, value]) => {
        if (value === null) return row[key] === null || row[key] === undefined
        return row[key] === value
      })
    })
    return match ?? null
  }

  async flush(): Promise<void> {
    this.flushed += 1
    if (this.shouldThrowOnFlush) {
      const err = this.shouldThrowOnFlush
      this.shouldThrowOnFlush = null
      throw err
    }
  }
}

describe('AgencyService', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('rejects creation when slug already taken (409 path)', async () => {
    const em = new FakeEntityManager()
    em.setSeed('tenant', [{ id: 'tenant-1' }])
    em.setSeed('agency', [{ id: 'a-1', tenantId: 'tenant-1', slug: 'acme', deletedAt: null }])
    const svc = new AgencyService(em as any)
    await expect(
      svc.createAgencyWithOrganization(
        { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
        { tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.AGENCY_SLUG_TAKEN, status: 409 })
  })

  it('translates DB unique violation on flush into 409 slug taken', async () => {
    const em = new FakeEntityManager()
    em.setSeed('tenant', [{ id: 'tenant-1' }])
    em.shouldThrowOnFlush = Object.assign(new Error('dup'), { code: '23505' })
    const svc = new AgencyService(em as any)
    await expect(
      svc.createAgencyWithOrganization(
        { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
        { tenantId: 'tenant-1' },
      ),
    ).rejects.toBeInstanceOf(PrmDomainError)
  })

  it('rejects create when tenant is not seeded', async () => {
    const em = new FakeEntityManager()
    const svc = new AgencyService(em as any)
    await expect(
      svc.createAgencyWithOrganization(
        { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
        { tenantId: 'tenant-missing' },
      ),
    ).rejects.toMatchObject({ status: 403 })
  })
})
