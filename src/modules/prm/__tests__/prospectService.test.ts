import { ProspectService, type ProspectActor } from '../lib/prospectService'
import { Prospect, Agency, AgencyMember } from '../data/entities'
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
    const row = {
      id: payload.id ?? `mock-${table}-${Math.random().toString(36).slice(2, 8)}`,
      ...payload,
    }
    if (!this.rows.has(table)) this.rows.set(table, [])
    this.rows.get(table)!.push(row)
    return row as T
  }

  persist(_row: unknown): void {
    // no-op
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
    // ProspectService.findCandidatesByNormalizedKey uses knex; tests below don't exercise it.
    return jest.fn()
  }
}

function tableForCtor(ctor: unknown): string {
  if (ctor === Prospect) return 'prospect'
  if (ctor === Agency) return 'agency'
  if (ctor === AgencyMember) return 'member'
  return 'unknown'
}

const TENANT = 'tenant-1'
const ORG = 'org-1'
const AGENCY = 'agency-1'
const MEMBER_AUTHOR = 'member-author'
const MEMBER_OTHER = 'member-other'
const CUSTOMER_USER = 'cu-author'

function authorActor(): ProspectActor {
  return {
    type: 'customer_user',
    customerUserId: CUSTOMER_USER,
    agencyMemberId: MEMBER_AUTHOR,
    isPartnerAdmin: false,
  }
}

function partnerAdminActor(): ProspectActor {
  return {
    type: 'customer_user',
    customerUserId: 'cu-admin',
    agencyMemberId: 'member-admin',
    isPartnerAdmin: true,
  }
}

function systemActor(): ProspectActor {
  return { type: 'system', reason: 'attribution' }
}

function buildProspect(overrides?: Partial<Persisted>): Persisted {
  return {
    id: 'prospect-1',
    tenantId: TENANT,
    organizationId: ORG,
    agencyId: AGENCY,
    registeredByAgencyMemberId: MEMBER_AUTHOR,
    companyName: 'Acme Corp',
    contactName: 'Jane',
    contactEmail: 'jane@acme.io',
    source: 'agency_owned',
    status: 'new',
    lostReason: null,
    notes: null,
    registeredAt: new Date('2026-01-01T00:00:00Z'),
    statusChangedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

describe('ProspectService', () => {
  beforeEach(() => {
    safeEmit.mockClear()
  })

  describe('register', () => {
    it('creates a Prospect, stamps registered_at + status_changed_at, emits prm.prospect.registered', async () => {
      const em = new FakeEntityManager()
      em.setSeed('agency', [{ id: AGENCY, tenantId: TENANT, status: 'active', deletedAt: null }])
      em.setSeed('member', [
        { id: MEMBER_AUTHOR, tenantId: TENANT, agencyId: AGENCY, deletedAt: null },
      ])
      const svc = new ProspectService(em as any)

      const prospect = await svc.register(
        {
          companyName: '  Acme-Corp,  Inc. ',
          contactName: 'Jane',
          contactEmail: 'JANE@acme.IO',
          source: 'agency_owned',
        },
        {
          tenantId: TENANT,
          organizationId: ORG,
          agencyId: AGENCY,
          registeredByAgencyMemberId: MEMBER_AUTHOR,
        },
      )
      expect(prospect.status).toBe('new')
      expect(prospect.registeredAt).toBeInstanceOf(Date)
      expect(prospect.statusChangedAt).toBeInstanceOf(Date)
      expect(safeEmit).toHaveBeenCalledTimes(1)
      const [eventId, payload] = safeEmit.mock.calls[0] as [string, Record<string, unknown>]
      expect(eventId).toBe('prm.prospect.registered')
      expect(payload).toMatchObject({
        prospectId: prospect.id,
        normalizedCompanyName: 'acme corp inc',
        lowercasedContactEmail: 'jane@acme.io',
      })
    })

    it('rejects when agency is historical (invariant cascade)', async () => {
      const em = new FakeEntityManager()
      em.setSeed('agency', [{ id: AGENCY, tenantId: TENANT, status: 'historical', deletedAt: null }])
      em.setSeed('member', [
        { id: MEMBER_AUTHOR, tenantId: TENANT, agencyId: AGENCY, deletedAt: null },
      ])
      const svc = new ProspectService(em as any)
      await expect(
        svc.register(
          {
            companyName: 'Acme',
            contactName: 'Jane',
            contactEmail: 'jane@acme.io',
            source: 'agency_owned',
          },
          {
            tenantId: TENANT,
            organizationId: ORG,
            agencyId: AGENCY,
            registeredByAgencyMemberId: MEMBER_AUTHOR,
          },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.AGENCY_HISTORICAL, status: 409 })
      expect(safeEmit).not.toHaveBeenCalled()
    })

    it('rejects when registering member is not in the agency', async () => {
      const em = new FakeEntityManager()
      em.setSeed('agency', [{ id: AGENCY, tenantId: TENANT, status: 'active', deletedAt: null }])
      const svc = new ProspectService(em as any)
      await expect(
        svc.register(
          {
            companyName: 'Acme',
            contactName: 'Jane',
            contactEmail: 'jane@acme.io',
            source: 'agency_owned',
          },
          {
            tenantId: TENANT,
            organizationId: ORG,
            agencyId: AGENCY,
            registeredByAgencyMemberId: 'unknown-member',
          },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND, status: 403 })
    })
  })

  describe('transitionStatus — invariant #12 state machine', () => {
    function setup(prospectOverrides?: Partial<Persisted>) {
      const em = new FakeEntityManager()
      em.setSeed('prospect', [buildProspect(prospectOverrides)])
      return { em, svc: new ProspectService(em as any) }
    }

    it('allows new → qualified by author', async () => {
      const { svc } = setup({ status: 'new' })
      const updated = await svc.transitionStatus(
        'prospect-1',
        { toStatus: 'qualified' },
        { tenantId: TENANT, actor: authorActor() },
      )
      expect(updated.status).toBe('qualified')
      expect(safeEmit).toHaveBeenCalledWith(
        'prm.prospect.status_changed',
        expect.objectContaining({ fromStatus: 'new', toStatus: 'qualified' }),
        expect.any(Object),
      )
    })

    it('blocks lost → qualified (terminal state)', async () => {
      const { svc } = setup({ status: 'lost', lostReason: 'They went with another vendor.' })
      await expect(
        svc.transitionStatus(
          'prospect-1',
          { toStatus: 'qualified' },
          { tenantId: TENANT, actor: authorActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.INVALID_TRANSITION, status: 409 })
    })

    it('blocks new → won when actor is not system', async () => {
      const { svc } = setup({ status: 'new' })
      await expect(
        svc.transitionStatus(
          'prospect-1',
          { toStatus: 'won' as any },
          { tenantId: TENANT, actor: partnerAdminActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.WON_IS_OM_ONLY, status: 403 })
    })

    it('allows qualified → won when actor is system', async () => {
      const { svc } = setup({ status: 'qualified' })
      const updated = await svc.transitionStatus(
        'prospect-1',
        { toStatus: 'won' },
        { tenantId: TENANT, actor: systemActor() },
      )
      expect(updated.status).toBe('won')
    })

    it('rejects partner_member transition on Prospect authored by another member', async () => {
      const { svc } = setup({ status: 'new', registeredByAgencyMemberId: MEMBER_OTHER })
      await expect(
        svc.transitionStatus(
          'prospect-1',
          { toStatus: 'qualified' },
          { tenantId: TENANT, actor: authorActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.NOT_AUTHOR_OR_ADMIN, status: 403 })
    })

    it('allows partner_admin transition on Prospect authored by another member', async () => {
      const { svc } = setup({ status: 'new', registeredByAgencyMemberId: MEMBER_OTHER })
      const updated = await svc.transitionStatus(
        'prospect-1',
        { toStatus: 'qualified' },
        { tenantId: TENANT, actor: partnerAdminActor() },
      )
      expect(updated.status).toBe('qualified')
    })

    it('requires lost_reason length >= 10 when target is lost', async () => {
      const { svc } = setup({ status: 'qualified' })
      await expect(
        svc.transitionStatus(
          'prospect-1',
          { toStatus: 'lost', lostReason: 'short' },
          { tenantId: TENANT, actor: authorActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.LOST_REASON_REQUIRED, status: 400 })
    })

    it('persists lost_reason and emits status_changed when target is lost with valid reason', async () => {
      const { svc } = setup({ status: 'qualified' })
      const updated = await svc.transitionStatus(
        'prospect-1',
        { toStatus: 'lost', lostReason: 'They picked a competitor with cheaper pricing.' },
        { tenantId: TENANT, actor: authorActor() },
      )
      expect(updated.status).toBe('lost')
      expect(updated.lostReason).toBe('They picked a competitor with cheaper pricing.')
    })

    it('rejects transition when optimistic concurrency token mismatches', async () => {
      const { svc } = setup({ status: 'new', statusChangedAt: new Date('2026-01-01T00:00:00Z') })
      await expect(
        svc.transitionStatus(
          'prospect-1',
          {
            toStatus: 'qualified',
            ifMatchStatusChangedAt: '2025-12-01T00:00:00.000Z',
          },
          { tenantId: TENANT, actor: authorActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.STATUS_CONFLICT, status: 409 })
    })
  })

  describe('update', () => {
    it('returns no-op when nothing changes', async () => {
      const em = new FakeEntityManager()
      em.setSeed('prospect', [buildProspect()])
      const svc = new ProspectService(em as any)
      const { changedFields } = await svc.update(
        'prospect-1',
        { companyName: 'Acme Corp' },
        { tenantId: TENANT, actor: authorActor() },
      )
      expect(changedFields).toEqual([])
      expect(safeEmit).not.toHaveBeenCalled()
    })

    it('emits updated with changedFields when fields change', async () => {
      const em = new FakeEntityManager()
      em.setSeed('prospect', [buildProspect()])
      const svc = new ProspectService(em as any)
      const { changedFields } = await svc.update(
        'prospect-1',
        { companyName: 'Acme Global' },
        { tenantId: TENANT, actor: authorActor() },
      )
      expect(changedFields).toEqual(['companyName'])
      expect(safeEmit).toHaveBeenCalledWith(
        'prm.prospect.updated',
        expect.objectContaining({ changedFields: ['companyName'], normalizedCompanyName: 'acme global' }),
        expect.any(Object),
      )
    })

    it('rejects partner_member edit on Prospect authored by another member', async () => {
      const em = new FakeEntityManager()
      em.setSeed('prospect', [buildProspect({ registeredByAgencyMemberId: MEMBER_OTHER })])
      const svc = new ProspectService(em as any)
      await expect(
        svc.update(
          'prospect-1',
          { companyName: 'Acme Global' },
          { tenantId: TENANT, actor: authorActor() },
        ),
      ).rejects.toMatchObject({ code: PRM_ERROR_CODES.NOT_AUTHOR_OR_ADMIN, status: 403 })
    })
  })

  describe('computeAllowedTransitions', () => {
    it('omits won for customer_user actors', () => {
      const em = new FakeEntityManager()
      const svc = new ProspectService(em as any)
      const prospect = buildProspect({ status: 'qualified' }) as unknown as Prospect
      expect(svc.computeAllowedTransitions(prospect, partnerAdminActor())).toEqual(
        expect.arrayContaining(['contacted', 'lost']),
      )
      expect(svc.computeAllowedTransitions(prospect, partnerAdminActor())).not.toContain('won')
    })

    it('returns empty for terminal won/lost states', () => {
      const em = new FakeEntityManager()
      const svc = new ProspectService(em as any)
      const wonProspect = buildProspect({ status: 'won' }) as unknown as Prospect
      const lostProspect = buildProspect({ status: 'lost' }) as unknown as Prospect
      expect(svc.computeAllowedTransitions(wonProspect, partnerAdminActor())).toEqual([])
      expect(svc.computeAllowedTransitions(lostProspect, partnerAdminActor())).toEqual([])
    })

    it('restricts partner_member to author-owned transitions', () => {
      const em = new FakeEntityManager()
      const svc = new ProspectService(em as any)
      const owned = buildProspect({ status: 'new' }) as unknown as Prospect
      const other = buildProspect({
        status: 'new',
        registeredByAgencyMemberId: MEMBER_OTHER,
      }) as unknown as Prospect
      expect(svc.computeAllowedTransitions(owned, authorActor())).toContain('qualified')
      expect(svc.computeAllowedTransitions(other, authorActor())).toEqual([])
    })
  })
})
