import { LicenseDealService, type LicenseDealActor } from '../lib/licenseDealService'
import { Agency, AgencyMember, LicenseDeal, Prospect } from '../data/entities'
import { PRM_ERROR_CODES } from '../lib/errors'

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }

type Persisted = Record<string, unknown> & { id?: string }

class FakeEntityManager {
  rows = new Map<string, Persisted[]>()
  flushed = 0

  setSeed(table: string, rows: Persisted[]): void {
    this.rows.set(table, rows)
  }

  create<T extends Persisted>(EntityCtor: any, payload: T): T {
    const table = tableForCtor(EntityCtor)
    const row = { id: payload.id ?? `mock-${table}-${Math.random().toString(36).slice(2, 8)}`, ...payload }
    if (!this.rows.has(table)) this.rows.set(table, [])
    this.rows.get(table)!.push(row)
    return row as T
  }
  persist(_row: unknown): void {}
  async findOne(EntityCtor: any, where: Record<string, unknown>): Promise<Persisted | null> {
    const table = tableForCtor(EntityCtor)
    const rows = this.rows.get(table) ?? []
    return (
      rows.find((row) =>
        Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object' && '$ne' in (value as any)) {
            return row[key] !== (value as any).$ne
          }
          if (value === null) return row[key] === null || row[key] === undefined
          return row[key] === value
        }),
      ) ?? null
    )
  }
  async findAndCount(): Promise<[Persisted[], number]> {
    return [[], 0]
  }
  async flush(): Promise<void> {
    this.flushed += 1
  }
  getKnex(): any {
    return jest.fn()
  }
}

function tableForCtor(ctor: unknown): string {
  if (ctor === LicenseDeal) return 'license_deal'
  if (ctor === Prospect) return 'prospect'
  if (ctor === Agency) return 'agency'
  if (ctor === AgencyMember) return 'member'
  return 'unknown'
}

const TENANT = 'tenant-1'
const ORG = 'org-1'
const ACTOR: LicenseDealActor = { type: 'user', userId: 'u-1' }

function buildDeal(overrides: Partial<Persisted> = {}): Persisted {
  return {
    id: 'deal-1',
    tenantId: TENANT,
    organizationId: ORG,
    licenseIdentifier: 'OM-2026-0001',
    clientCompanyName: 'Acme Corp',
    clientIndustry: null,
    type: 'enterprise',
    status: 'pending',
    isRenewal: false,
    previousLicenseDealId: null,
    closedAt: null,
    signedAt: null,
    annualValueUsd: null,
    monthlyLicenseAmount: null,
    attributionPath: 'none',
    attributionSource: 'direct',
    prospectId: null,
    rfpId: null,
    attributedAgencyId: null,
    attributionReasoning: null,
    attributedAt: null,
    notes: null,
    deletedAt: null,
    version: 1,
    createdAt: new Date('2026-04-23T10:00:00Z'),
    updatedAt: new Date('2026-04-23T10:00:00Z'),
    ...overrides,
  }
}

function buildAgency(overrides: Partial<Persisted> = {}): Persisted {
  return {
    id: 'agency-1',
    tenantId: TENANT,
    organizationId: ORG,
    name: 'Acme Agency',
    slug: 'acme',
    status: 'active',
    tier: 'om_agency',
    deletedAt: null,
    ...overrides,
  }
}

function buildProspect(overrides: Partial<Persisted> = {}): Persisted {
  return {
    id: 'prospect-1',
    tenantId: TENANT,
    organizationId: ORG,
    agencyId: 'agency-1',
    registeredByAgencyMemberId: 'member-1',
    companyName: 'Acme Corp',
    contactName: 'Jane Doe',
    contactEmail: 'jane@acme.test',
    source: 'agency_owned',
    status: 'qualified',
    statusChangedAt: new Date('2026-04-23T10:00:00Z'),
    registeredAt: new Date('2026-04-22T10:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  safeEmit.mockClear()
})

describe('LicenseDealService.create', () => {
  it('creates a pending deal and emits prm.license_deal.created', async () => {
    const em = new FakeEntityManager()
    const service = new LicenseDealService(em as any)
    const deal = await service.create(
      { licenseIdentifier: 'OM-2026-0001', clientCompanyName: 'Acme', type: 'enterprise', isRenewal: false },
      { tenantId: TENANT, organizationId: ORG, actor: ACTOR },
    )
    expect(deal.status).toBe('pending')
    expect(deal.attributionPath).toBe('none')
    expect(em.flushed).toBeGreaterThanOrEqual(1)
    expect(safeEmit).toHaveBeenCalledWith(
      'prm.license_deal.created',
      expect.objectContaining({ licenseDealId: deal.id, status: 'pending' }),
      expect.anything(),
    )
  })

  it('rejects duplicate identifiers', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ licenseIdentifier: 'OM-2026-0099' })])
    const service = new LicenseDealService(em as any)
    await expect(
      service.create(
        { licenseIdentifier: 'OM-2026-0099', clientCompanyName: 'X', type: 'enterprise', isRenewal: false },
        { tenantId: TENANT, organizationId: ORG, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.LICENSE_IDENTIFIER_TAKEN })
  })
})

describe('LicenseDealService.attribute Path A', () => {
  it('snapshots agency_id and emits attribution + status_changed', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal()])
    em.setSeed('prospect', [buildProspect()])
    const service = new LicenseDealService(em as any)
    const result = await service.attribute(
      'deal-1',
      {
        attribution_path: 'A',
        prospect_id: 'prospect-1',
        golden_rule_default_prospect_id: 'prospect-1',
        competing_prospect_ids_to_retire: [],
      },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(result.licenseDeal.attributionPath).toBe('A')
    expect(result.licenseDeal.attributedAgencyId).toBe('agency-1')
    expect(result.licenseDeal.status).toBe('signed')
    expect(result.correlationKey).toBe('deal-1:prospect')
    expect(safeEmit).toHaveBeenCalledWith(
      'prm.license_deal.attributed',
      expect.objectContaining({ correlationKey: 'deal-1:prospect', attributionPath: 'A' }),
      expect.anything(),
    )
  })

  it('requires reasoning when override detected', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal()])
    em.setSeed('prospect', [
      buildProspect({ id: 'prospect-1' }),
      buildProspect({ id: 'prospect-2', agencyId: 'agency-2' }),
    ])
    const service = new LicenseDealService(em as any)
    await expect(
      service.attribute(
        'deal-1',
        {
          attribution_path: 'A',
          prospect_id: 'prospect-2',
          golden_rule_default_prospect_id: 'prospect-1',
          competing_prospect_ids_to_retire: [],
        },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.ATTRIBUTION_REASONING_REQUIRED })
  })

  it('emits attribution_overridden when reasoning is supplied for non-default pick', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal()])
    em.setSeed('prospect', [
      buildProspect({ id: 'prospect-1' }),
      buildProspect({ id: 'prospect-2', agencyId: 'agency-2' }),
    ])
    const service = new LicenseDealService(em as any)
    const result = await service.attribute(
      'deal-1',
      {
        attribution_path: 'A',
        prospect_id: 'prospect-2',
        golden_rule_default_prospect_id: 'prospect-1',
        attribution_reasoning: 'contact email matched the older registration',
        competing_prospect_ids_to_retire: [],
      },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(result.emittedEvents).toContain('prm.license_deal.attribution_overridden')
    const overrideCall = safeEmit.mock.calls.find(
      ([eventId]: [string, ...unknown[]]) => eventId === 'prm.license_deal.attribution_overridden',
    )
    expect(overrideCall).toBeTruthy()
    expect(overrideCall![1]).toMatchObject({
      defaultProspectId: 'prospect-1',
      selectedProspectId: 'prospect-2',
      fromAgencyId: 'agency-1',
      toAgencyId: 'agency-2',
    })
  })

  it('rejects attribution when status is frozen', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'active' })])
    em.setSeed('prospect', [buildProspect()])
    const service = new LicenseDealService(em as any)
    await expect(
      service.attribute(
        'deal-1',
        {
          attribution_path: 'A',
          prospect_id: 'prospect-1',
          golden_rule_default_prospect_id: 'prospect-1',
          competing_prospect_ids_to_retire: [],
        },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.ATTRIBUTION_FROZEN })
  })
})

describe('LicenseDealService.attribute Path C', () => {
  it('captures reasoning + sets agency directly', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal()])
    em.setSeed('agency', [buildAgency()])
    const service = new LicenseDealService(em as any)
    const result = await service.attribute(
      'deal-1',
      {
        attribution_path: 'C',
        attributed_agency_id: 'agency-1',
        attribution_reasoning: 'direct OM founder hand-off',
      },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(result.licenseDeal.attributionPath).toBe('C')
    expect(result.licenseDeal.attributedAgencyId).toBe('agency-1')
    expect(result.licenseDeal.attributionReasoning).toBe('direct OM founder hand-off')
    expect(result.correlationKey).toBe('deal-1:direct')
  })
})

describe('LicenseDealService.transitionStatus', () => {
  it('rejects illegal forward jumps (pending → active)', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal()])
    const service = new LicenseDealService(em as any)
    await expect(
      service.transitionStatus(
        'deal-1',
        { toStatus: 'active' },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.STATUS_CHANGE_NOT_ALLOWED })
  })
  it('allows signed → active', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'signed' })])
    const service = new LicenseDealService(em as any)
    const next = await service.transitionStatus(
      'deal-1',
      { toStatus: 'active' },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(next.status).toBe('active')
  })
  it('rejects writes when ifMatchVersion mismatches', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'signed', version: 5 })])
    const service = new LicenseDealService(em as any)
    await expect(
      service.transitionStatus(
        'deal-1',
        { toStatus: 'active', ifMatchVersion: 4 },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.STATUS_CONFLICT })
  })
})

describe('LicenseDealService.unreverseStatus', () => {
  it('rejects from-churned (terminal)', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'churned' })])
    const service = new LicenseDealService(em as any)
    await expect(
      service.unreverseStatus(
        'deal-1',
        { toStatus: 'signed', reason: 'attempted recovery' },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.CHURNED_IS_TERMINAL })
  })
  it('allows active → signed', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'active' })])
    const service = new LicenseDealService(em as any)
    const next = await service.unreverseStatus(
      'deal-1',
      { toStatus: 'signed', reason: 'contract corrected per CSM ticket' },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(next.status).toBe('signed')
  })
  it('allows signed → pending and clears attributedAt', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      buildDeal({ status: 'signed', attributedAt: new Date('2026-04-22T00:00:00Z') }),
    ])
    const service = new LicenseDealService(em as any)
    const next = await service.unreverseStatus(
      'deal-1',
      { toStatus: 'pending', reason: 'releasing rfp lock for re-selection' },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(next.status).toBe('pending')
    expect(next.attributedAt).toBeNull()
  })
})

describe('LicenseDealService.reverse', () => {
  it('emits reversal_started + reversed and resets the aggregate', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [
      buildDeal({
        status: 'signed',
        attributionPath: 'A',
        attributionSource: 'prospect',
        prospectId: 'prospect-1',
        attributedAgencyId: 'agency-1',
        attributedAt: new Date(),
        signedAt: new Date(),
      }),
    ])
    const service = new LicenseDealService(em as any)
    const result = await service.reverse(
      'deal-1',
      { reason: 'reassign per finance audit ticket #4567' },
      { tenantId: TENANT, actor: ACTOR },
    )
    expect(result.licenseDeal.status).toBe('pending')
    expect(result.licenseDeal.attributionPath).toBe('none')
    expect(result.licenseDeal.attributedAgencyId).toBeNull()
    expect(result.licenseDeal.signedAt).toBeNull()
    expect(result.emittedEvents).toEqual(
      expect.arrayContaining([
        'prm.license_deal.reversal_started',
        'prm.license_deal.reversed',
        'prm.license_deal.status_changed',
      ]),
    )
  })

  it('rejects when status is frozen', async () => {
    const em = new FakeEntityManager()
    em.setSeed('license_deal', [buildDeal({ status: 'active' })])
    const service = new LicenseDealService(em as any)
    await expect(
      service.reverse(
        'deal-1',
        { reason: 'attempt to reverse from active' },
        { tenantId: TENANT, actor: ACTOR },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.ATTRIBUTION_FROZEN })
  })
})
