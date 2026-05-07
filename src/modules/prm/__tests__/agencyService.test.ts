import { AgencyService } from '../lib/agencyService'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'
import { Agency } from '../data/entities'

type Persisted = Record<string, unknown> & { id?: string }

class FakeEntityManager {
  rows = new Map<string, Persisted[]>()
  flushed = 0
  shouldThrowOnFlush: Error | null = null
  /**
   * When set, the EM throws on the next `create()` call for the matching table
   * (e.g. simulate a unique-violation race that surfaces on insert rather than
   * on flush). Used by the atomicity test to assert that the Organization is
   * rolled back together with the failing Agency insert.
   */
  failOnCreateForTable: string | null = null

  setSeed(table: string, rows: Persisted[]): void {
    this.rows.set(table, rows)
  }

  /**
   * Snapshot the rows map so a transactional callback can restore it on
   * throw — a faithful stand-in for Postgres BEGIN/ROLLBACK at the unit-test
   * level.
   */
  private snapshot(): Map<string, Persisted[]> {
    const next = new Map<string, Persisted[]>()
    for (const [table, rows] of this.rows.entries()) {
      next.set(table, [...rows])
    }
    return next
  }

  private restore(snapshot: Map<string, Persisted[]>): void {
    this.rows = snapshot
  }

  create<T extends Persisted>(EntityCtor: any, payload: T): T {
    const table = EntityCtor === Agency ? 'agency' : EntityCtor?.name === 'Tenant' ? 'tenant' : 'organization'
    if (this.failOnCreateForTable === table) {
      // Reset so the next create() (e.g. inside a retry) is not also rejected.
      this.failOnCreateForTable = null
      const err: Error & { code?: string } = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        { code: '23505' },
      )
      throw err
    }
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

  /**
   * Mirror MikroORM's `em.transactional` semantics at the unit-test level:
   * snapshot rows on entry, restore on throw, commit on success.
   */
  async transactional<T>(cb: (em: FakeEntityManager) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot()
    try {
      return await cb(this)
    } catch (err) {
      this.restore(snapshot)
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

  it(
    'rolls the Organization back when the Agency insert is rejected ' +
      '(atomicity guarantee — POST-MVP withAtomicFlush wrap)',
    async () => {
      // Simulates the documented race: pre-flight slug check passes, the
      // Organization is created/persisted, then the Agency insert is rejected
      // by the DB (unique-violation race on `prm_agencies_tenant_slug_uniq`).
      // Pre-fix this leaked an orphan Organization row. Post-fix the
      // `withAtomicFlush({ transaction: true })` wrapper rolls Organization
      // back together with the failing Agency insert.
      const em = new FakeEntityManager()
      em.setSeed('tenant', [{ id: 'tenant-1' }])
      em.failOnCreateForTable = 'agency'
      const svc = new AgencyService(em as any)

      await expect(
        svc.createAgencyWithOrganization(
          { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
          { tenantId: 'tenant-1' },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.AGENCY_SLUG_TAKEN, status: 409 })

      // Atomicity assertion: the Organization row written inside the failed
      // transaction MUST NOT survive. Pre-fix this assertion would fail
      // because the unwrapped persist() left a stranded Organization row.
      const organizations = em.rows.get('organization') ?? []
      expect(organizations).toHaveLength(0)
      const agencies = em.rows.get('agency') ?? []
      expect(agencies).toHaveLength(0)
    },
  )
})
