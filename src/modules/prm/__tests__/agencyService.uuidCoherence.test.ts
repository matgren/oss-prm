/**
 * Pre-flush UUID coherence test — POST-MVP-FOLLOW-UPS Tracker
 * "Unit-test coverage for the two PR #1 resume bugs (T0 Agency)" — bug (b):
 *
 *   PR #1 originally read `(organization as any).id` BEFORE `em.flush()` and
 *   wrote that value into `Agency.organizationId`. The Organization PK is
 *   declared with `defaultRaw: 'gen_random_uuid()'` (DB-side default), so
 *   MikroORM does not populate `organization.id` until after the flush
 *   round-trip. Reading it pre-flush yields `undefined`, and MikroORM rejects
 *   the Agency insert with
 *   `Value for Agency.organizationId is required, 'undefined' found`. Fix
 *   landed in commits d0141c2 + c488dbb — the service now pre-generates the
 *   UUID with `randomUUID()` and threads it into both Organization and
 *   Agency creates.
 *
 * Why the existing tests missed this: `agencyService.test.ts` uses a
 * `FakeEntityManager` that auto-assigns `id` inside `create()` (`payload.id ??
 * \`mock-${table}-${random}\``). That masks both this bug AND the DI proxy
 * bug: any `(organization as any).id` read returns the auto-assigned mock id
 * even pre-flush, so the assertion shape never surfaces.
 *
 * Strategy here: build a deliberately strict EM that mirrors the actual
 * Postgres `defaultRaw` semantics — `create()` does NOT touch `id`, so
 * `organization.id` is `undefined` until flush. A pre-fix
 * `createAgencyWithOrganization` would trip the `Value for Agency.organizationId
 * is required` invariant we model below; the post-fix one passes because the
 * service supplies a `randomUUID()` value to BOTH inserts.
 *
 * The fake EM is local to this test file on purpose — the shared
 * `FakeEntityManager` in `agencyService.test.ts` is intentionally lenient and
 * is relied on by other tests. Modifying it would make those tests stricter
 * than they need to be for their own assertions.
 */

import { Agency } from '../data/entities'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { AgencyService } from '../lib/agencyService'

type Persisted = Record<string, unknown> & { id?: string }

const TABLE_AGENCY = 'agency'
const TABLE_ORG = 'organization'
const TABLE_TENANT = 'tenant'

function tableFor(EntityCtor: any): string {
  if (EntityCtor === Agency) return TABLE_AGENCY
  if (EntityCtor === Organization) return TABLE_ORG
  if (EntityCtor === Tenant) return TABLE_TENANT
  // Soft fallback — keeps the fake forward-compatible if a future agencyService
  // changeset persists an additional entity type. Tests assert on table-keyed
  // rows; a missing mapping would surface as a missing-row failure not a crash.
  return EntityCtor?.name ? String(EntityCtor.name).toLowerCase() : 'unknown'
}

/**
 * `StrictPostgresishEntityManager` — minimal MikroORM-shaped fake that mirrors
 * the production "PK is assigned by Postgres on flush" behaviour:
 *
 *   - `create(EntityCtor, payload)` returns the payload UNCHANGED. If the
 *     payload omits `id`, the resulting row's `id` stays `undefined` until
 *     the explicit `flush()` call.
 *   - `flush()` walks every row in every table and lazy-assigns a synthetic
 *     id when missing — modelling the moment Postgres returns the `RETURNING
 *     id` row from the actual INSERT. Until then any caller reading `.id` on
 *     a freshly-created row gets `undefined` (the bug shape).
 *   - `findOne(EntityCtor, where)` honors the seeded tenant + post-create
 *     agency slug check.
 *   - `transactional(cb)` snapshots and restores rows on throw — same as the
 *     existing `FakeEntityManager` so atomicity is preserved end-to-end.
 *
 * Critically: `create()` does NOT set `payload.id` if it is missing. That is
 * the entire point of this fake.
 */
class StrictPostgresishEntityManager {
  rows = new Map<string, Persisted[]>()
  flushed = 0

  /**
   * The original PR #1 bug was a "missing organizationId on Agency insert"
   * error thrown by MikroORM when `payload.organizationId` was `undefined`.
   * Real Postgres + MikroORM enforces this via `nullable: false`. We model
   * the same invariant here so the bug shape surfaces inside this fake.
   */
  static enforceNotNullColumns: Record<string, string[]> = {
    [TABLE_AGENCY]: ['organizationId'],
  }

  setSeed(table: string, rows: Persisted[]): void {
    this.rows.set(table, rows)
  }

  private snapshot(): Map<string, Persisted[]> {
    const next = new Map<string, Persisted[]>()
    for (const [table, rows] of this.rows.entries()) {
      next.set(table, rows.map((row) => ({ ...row })))
    }
    return next
  }

  private restore(snapshot: Map<string, Persisted[]>): void {
    this.rows = snapshot
  }

  create<T extends Persisted>(EntityCtor: any, payload: T): T {
    const table = tableFor(EntityCtor)
    // KEY DIFFERENCE FROM THE LENIENT `FakeEntityManager` IN THE OTHER FILE:
    // we do NOT auto-assign an id when payload.id is absent. This mirrors the
    // production behaviour for entities whose PK uses
    // `defaultRaw: 'gen_random_uuid()'` (Organization, Tenant). The id stays
    // undefined until the synthetic flush() lazy-assigns it below.
    const row: Persisted = { ...payload }
    if (!this.rows.has(table)) this.rows.set(table, [])
    this.rows.get(table)!.push(row)
    return row as T
  }

  persist(_row: unknown): void {
    // No-op — create() already added it to the rows table. Mirrors the
    // existing FakeEntityManager.
  }

  async findOne(EntityCtor: any, where: Record<string, unknown>): Promise<Persisted | null> {
    const table = tableFor(EntityCtor)
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
    // Validate not-null invariants BEFORE assigning ids — that mirrors how
    // Postgres + MikroORM rejects the Agency insert in the original PR #1
    // bug shape (the `organizationId` undefined check fires at INSERT time,
    // not at COMMIT time).
    for (const [table, columns] of Object.entries(StrictPostgresishEntityManager.enforceNotNullColumns)) {
      const rows = this.rows.get(table) ?? []
      for (const row of rows) {
        for (const col of columns) {
          if (row[col] === undefined || row[col] === null) {
            throw new Error(
              `[StrictPostgresishEntityManager] Value for ${table}.${col} is required, ` +
                `'${row[col]}' found — pre-flush UUID coherence violated`,
            )
          }
        }
      }
    }
    // Now lazy-assign ids to mirror Postgres returning gen_random_uuid()
    // values from each INSERT. We use a deterministic counter per-flush so
    // tests asserting on equality vs. a captured pre-flush id can still match
    // (post-fix the pre-flush id IS already set by the service via
    // randomUUID(), so this synthetic id is never observed by the assertion).
    let counter = 0
    for (const rows of this.rows.values()) {
      for (const row of rows) {
        if (row.id === undefined || row.id === null) {
          counter += 1
          row.id = `pg-flush-${this.flushed}-${counter}`
        }
      }
    }
  }

  async transactional<T>(cb: (em: StrictPostgresishEntityManager) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot()
    try {
      return await cb(this)
    } catch (err) {
      this.restore(snapshot)
      throw err
    }
  }
}

const TENANT_ID = 'tenant-1'

function makeServiceWithStrictEm(): {
  em: StrictPostgresishEntityManager
  svc: AgencyService
} {
  const em = new StrictPostgresishEntityManager()
  // Seed Tenant row — agencyService.findOne(Tenant, { id, deletedAt: null })
  // must succeed for the create path to proceed. Note we DO assign an id here
  // (it's a seed, not a runtime insert) — the bug shape only affects rows
  // created mid-request via em.create().
  em.setSeed(TABLE_TENANT, [{ id: TENANT_ID, deletedAt: null }])
  const svc = new AgencyService(em as any)
  return { em, svc }
}

describe('AgencyService.createAgencyWithOrganization — UUID coherence (POST-MVP-FOLLOW-UPS — PR #1 resume bug b)', () => {
  it('persists Agency.organizationId equal to Organization.id (post-fix invariant)', async () => {
    const { em, svc } = makeServiceWithStrictEm()

    const agency = await svc.createAgencyWithOrganization(
      { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
      { tenantId: TENANT_ID },
    )

    const organizations = em.rows.get(TABLE_ORG) ?? []
    const agencies = em.rows.get(TABLE_AGENCY) ?? []
    expect(organizations).toHaveLength(1)
    expect(agencies).toHaveLength(1)

    const organization = organizations[0]!
    const persistedAgency = agencies[0]!

    // Coherence: Agency.organizationId points at Organization.id, both are
    // strings (not undefined), and the in-memory entity returned by the
    // service exposes the same value.
    expect(typeof organization.id).toBe('string')
    expect(typeof persistedAgency.organizationId).toBe('string')
    expect(persistedAgency.organizationId).toBe(organization.id)
    expect(agency.organizationId).toBe(organization.id)
  })

  it('Agency.organizationId is set BEFORE flush — proves randomUUID() pre-generation', async () => {
    // This is the assertion that would have surfaced the original bug.
    // Pre-fix the service read `(organization as any).id` before flush, which
    // was `undefined` under the strict EM (and under real Postgres). The
    // strict EM's flush() throws when Agency.organizationId is null/undefined
    // at flush-time, so the bug shape manifests as a thrown error from
    // createAgencyWithOrganization rather than silent corruption.
    const { em, svc } = makeServiceWithStrictEm()

    await svc.createAgencyWithOrganization(
      { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
      { tenantId: TENANT_ID },
    )

    // Sanity: flush ran successfully → organizationId was set BEFORE flush.
    expect(em.flushed).toBeGreaterThan(0)
    const persistedAgency = (em.rows.get(TABLE_AGENCY) ?? [])[0]
    expect(persistedAgency).toBeDefined()
    expect(persistedAgency!.organizationId).not.toBeUndefined()
    expect(persistedAgency!.organizationId).not.toBeNull()
    // Stronger: matches a UUIDv4-ish shape (randomUUID() output). We don't
    // hard-pin the exact format because Node's crypto.randomUUID() returns
    // RFC4122 v4 UUIDs — match the canonical 8-4-4-4-12 shape with the
    // version 4 nibble in slot 14.
    expect(persistedAgency!.organizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('Organization.id is set BEFORE flush — pre-generated by the service, not by Postgres', async () => {
    // The post-fix service supplies the same pre-generated UUID to BOTH the
    // Organization and the Agency inserts. This test asserts the Organization
    // row has its `id` populated at create-time (i.e. before our strict EM's
    // flush() runs the lazy-assign loop). Pre-fix, Organization.id was left
    // to the DB-side default and was undefined at create-time.
    const { em, svc } = makeServiceWithStrictEm()

    await svc.createAgencyWithOrganization(
      { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
      { tenantId: TENANT_ID },
    )

    const organization = (em.rows.get(TABLE_ORG) ?? [])[0]
    expect(organization).toBeDefined()
    // Match the same UUIDv4 shape — randomUUID() output. If post-flush lazy
    // assignment had been the only path that set this id, the value would
    // start with `pg-flush-` (the synthetic prefix used by the strict EM).
    expect(organization!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(String(organization!.id).startsWith('pg-flush-')).toBe(false)
  })

  it('Two consecutive creates produce distinct, persisted Organization↔Agency UUID pairs', async () => {
    // Defense in depth — guards against a future regression where the service
    // accidentally caches or reuses a single UUID across calls.
    const { em, svc } = makeServiceWithStrictEm()

    await svc.createAgencyWithOrganization(
      { name: 'Acme', slug: 'acme', tier: 'om_agency', headquartersCountry: 'US' },
      { tenantId: TENANT_ID },
    )
    await svc.createAgencyWithOrganization(
      { name: 'Beta', slug: 'beta', tier: 'om_agency', headquartersCountry: 'US' },
      { tenantId: TENANT_ID },
    )

    const orgs = em.rows.get(TABLE_ORG) ?? []
    const agencies = em.rows.get(TABLE_AGENCY) ?? []
    expect(orgs).toHaveLength(2)
    expect(agencies).toHaveLength(2)

    const orgIds = new Set(orgs.map((o) => o.id))
    expect(orgIds.size).toBe(2)
    // Each Agency.organizationId points at its respective Organization.id.
    for (const agency of agencies) {
      expect(orgIds.has(agency.organizationId as string)).toBe(true)
    }
  })

  it("StrictPostgresishEntityManager fake actually rejects undefined FK on flush — proves the test's pre-condition", async () => {
    // Self-test: assert the strict EM would have surfaced the original bug
    // shape. If someone neuters this assertion by relaxing the strict EM's
    // not-null enforcement, the regression coverage above silently degrades.
    const em = new StrictPostgresishEntityManager()
    em.create(Agency, {
      tenantId: TENANT_ID,
      // organizationId intentionally omitted — mirrors PR #1 pre-fix shape.
      name: 'Acme',
      slug: 'acme',
    } as any)
    await expect(em.flush()).rejects.toThrow(/Value for agency.organizationId is required/)
  })
})
