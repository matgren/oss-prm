import { LicenseDealService } from '../lib/licenseDealService'

/**
 * Unit test for `LicenseDealService.findGoldenRuleCandidates` (Spec #3 invariant #14).
 *
 * Invariant #14: the Golden Rule picker MUST surface ALL prospect statuses,
 * including `lost`, so the B5 license-deal page can render a "lost" badge on
 * the row. The default-pick semantics are: oldest non-lost row by
 * `registered_at`, falling back to the oldest row overall when ALL are lost.
 *
 * The picker is built on top of `prm_prospect_candidate_index` joined to
 * `prm_prospects`. We mock the knex chain rather than seeding a real DB
 * because the projection table is exercised end-to-end by
 * `prospectCandidateIndexProjection.test.ts`; this test only needs to verify
 * that the SHAPE of the returned rows respects the lost-row surfacing rule.
 */

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

const TENANT = 'tenant-1'
const ORG = 'org-1'
const AGENCY_QUALIFIED = 'agency-q'
const AGENCY_WON = 'agency-w'
const AGENCY_LOST = 'agency-l'

type IndexJoinRow = {
  prospect_id: string
  agency_id: string
  organization_id: string
  company_name: string
  contact_name: string
  contact_email: string
  status: string
  registered_at: Date
  registered_by_agency_member_id: string
}

/**
 * Build a chainable knex query builder mock that resolves (when awaited) to
 * the seeded rows. Mirrors the chain used in `findGoldenRuleCandidates`:
 *   knex(table).join(...).where(...).whereNull(...).where(...).orderBy(...).limit(...).select(...).orWhere(fn)
 */
function buildQueryBuilder(rows: IndexJoinRow[]) {
  const builder: any = {
    join: jest.fn(() => builder),
    where: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    select: jest.fn(() => builder),
    // Implementation calls .orWhere(function () { this.where(...).whereNull(...).where(...) })
    orWhere: jest.fn(function (fn: (this: any) => void) {
      const inner = {
        where: jest.fn(function (this: any) {
          return this
        }),
        whereNull: jest.fn(function (this: any) {
          return this
        }),
      }
      fn.call(inner)
      return builder
    }),
    // Awaiting the builder resolves to the seeded rows (knex pattern).
    then: (onFulfilled: (value: IndexJoinRow[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
  }
  return builder
}

class FakeEntityManager {
  private rows: IndexJoinRow[] = []

  setIndexRows(rows: IndexJoinRow[]): void {
    this.rows = rows
  }

  getKnex(): jest.Mock {
    return jest.fn(() => buildQueryBuilder(this.rows)) as unknown as jest.Mock
  }
}

function buildIndexRow(overrides: Partial<IndexJoinRow> = {}): IndexJoinRow {
  return {
    prospect_id: 'prospect-q',
    agency_id: AGENCY_QUALIFIED,
    organization_id: ORG,
    company_name: 'Acme Corp',
    contact_name: 'Jane Doe',
    contact_email: 'jane@acme.test',
    status: 'qualified',
    registered_at: new Date('2026-04-20T10:00:00Z'),
    registered_by_agency_member_id: 'member-q',
    ...overrides,
  }
}

describe('LicenseDealService.findGoldenRuleCandidates — invariant #14 (lost-row surfacing)', () => {
  it('returns ALL three statuses including lost (no `status != lost` filter)', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      // Oldest (default pick).
      buildIndexRow({ prospect_id: 'p-q', status: 'qualified', agency_id: AGENCY_QUALIFIED, registered_at: new Date('2026-04-20T10:00:00Z') }),
      // System-only state (post-attribution).
      buildIndexRow({ prospect_id: 'p-w', status: 'won', agency_id: AGENCY_WON, registered_at: new Date('2026-04-21T10:00:00Z') }),
      // Lost — MUST appear in the candidate set per invariant #14.
      buildIndexRow({ prospect_id: 'p-l', status: 'lost', agency_id: AGENCY_LOST, registered_at: new Date('2026-04-22T10:00:00Z') }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp', contactEmail: 'jane@acme.test' },
      { tenantId: TENANT },
    )

    expect(result).toHaveLength(3)
    expect(result.map((r) => r.status).sort()).toEqual(['lost', 'qualified', 'won'])
  })

  it('marks the lost row with isDefaultPick === false', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      buildIndexRow({ prospect_id: 'p-q', status: 'qualified', registered_at: new Date('2026-04-20T10:00:00Z') }),
      buildIndexRow({ prospect_id: 'p-w', status: 'won', registered_at: new Date('2026-04-21T10:00:00Z') }),
      buildIndexRow({ prospect_id: 'p-l', status: 'lost', registered_at: new Date('2026-04-22T10:00:00Z') }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp' },
      { tenantId: TENANT },
    )

    const lostRow = result.find((r) => r.status === 'lost')
    expect(lostRow).toBeDefined()
    expect(lostRow!.isDefaultPick).toBe(false)
  })

  it('preserves the literal `lost` status string so the B5 page can render the badge', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      buildIndexRow({ prospect_id: 'p-l', status: 'lost', agency_id: AGENCY_LOST }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp' },
      { tenantId: TENANT },
    )

    // The B5 license-deal page uses `status === 'lost'` to drive the badge
    // class name; confirm we surface the verbatim string rather than coercing.
    expect(result[0].status).toBe('lost')
    expect(result[0].agencyId).toBe(AGENCY_LOST)
    expect(result[0].prospectId).toBe('p-l')
  })

  it('selects the oldest non-lost row as default pick (qualified beats won + lost)', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      // The oldest registration is the lost row — it must NOT be picked.
      buildIndexRow({ prospect_id: 'p-l', status: 'lost', registered_at: new Date('2026-04-19T10:00:00Z') }),
      // Oldest non-lost = qualified row.
      buildIndexRow({ prospect_id: 'p-q', status: 'qualified', registered_at: new Date('2026-04-20T10:00:00Z') }),
      buildIndexRow({ prospect_id: 'p-w', status: 'won', registered_at: new Date('2026-04-21T10:00:00Z') }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp' },
      { tenantId: TENANT },
    )

    const defaults = result.filter((r) => r.isDefaultPick)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].prospectId).toBe('p-q')
    expect(defaults[0].status).toBe('qualified')
  })

  it('falls back to the oldest row overall when EVERY candidate is lost', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      buildIndexRow({ prospect_id: 'p-l1', status: 'lost', registered_at: new Date('2026-04-20T10:00:00Z') }),
      buildIndexRow({ prospect_id: 'p-l2', status: 'lost', registered_at: new Date('2026-04-21T10:00:00Z') }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp' },
      { tenantId: TENANT },
    )

    expect(result).toHaveLength(2)
    const defaults = result.filter((r) => r.isDefaultPick)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].prospectId).toBe('p-l1') // oldest of the lost-only set
  })

  it('returns an empty array when the normalized company name is empty', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([buildIndexRow()])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: '   ' },
      { tenantId: TENANT },
    )

    expect(result).toEqual([])
  })

  it('serializes registeredAt as ISO 8601 strings for the B5 row payload', async () => {
    const em = new FakeEntityManager()
    em.setIndexRows([
      buildIndexRow({
        prospect_id: 'p-q',
        status: 'qualified',
        registered_at: new Date('2026-04-20T10:00:00Z'),
      }),
    ])
    const service = new LicenseDealService(em as any)

    const result = await service.findGoldenRuleCandidates(
      { clientCompanyName: 'Acme Corp' },
      { tenantId: TENANT },
    )

    expect(result[0].registeredAt).toBe('2026-04-20T10:00:00.000Z')
  })
})
