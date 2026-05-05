import { handleProspectCandidateIndex } from '../lib/prospectCandidateIndexProjection'
import { Prospect, ProspectCandidateIndex } from '../data/entities'

const findOneMock = jest.fn()
const containerResolve = jest.fn()
const removeAndFlushMock = jest.fn().mockResolvedValue(undefined)
const knexMock = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn().mockResolvedValue({
    resolve: (name: string) => containerResolve(name),
  }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneMock(...args),
}))

const TENANT = 'tenant-1'

describe('handleProspectCandidateIndex', () => {
  let upsertCalls: any[] = []
  beforeEach(() => {
    findOneMock.mockReset()
    containerResolve.mockReset()
    removeAndFlushMock.mockClear()
    knexMock.mockReset()
    upsertCalls = []

    const fakeKnex = (table: string) => {
      const chain: Record<string, any> = {}
      chain.insert = (row: any) => {
        upsertCalls.push({ table, action: 'insert', row })
        return chain
      }
      chain.onConflict = () => chain
      chain.merge = (patch: any) => {
        upsertCalls.push({ table, action: 'merge', patch })
        return Promise.resolve()
      }
      return chain
    }

    const fakeEm = {
      getKnex: () => fakeKnex,
      findOne: jest.fn(async (Ctor: any, where: any) => {
        if (Ctor === ProspectCandidateIndex && where?.prospectId === 'p-existing') {
          return { prospectId: 'p-existing' }
        }
        return null
      }),
      removeAndFlush: removeAndFlushMock,
    }
    containerResolve.mockImplementation((name: string) => {
      if (name === 'em') return fakeEm
      throw new Error(`unexpected container resolve: ${name}`)
    })
  })

  it('upserts the projection row using normalized keys derived from the canonical Prospect', async () => {
    findOneMock.mockResolvedValueOnce({
      id: 'p-1',
      tenantId: TENANT,
      organizationId: 'org-1',
      agencyId: 'agency-1',
      companyName: '  Acme-Corp,  Inc. ',
      contactEmail: 'LEAD@Acme-Corp.IO',
      status: 'qualified',
      registeredAt: new Date('2026-04-01T00:00:00Z'),
    })
    await handleProspectCandidateIndex(
      { prospectId: 'p-1', tenantId: TENANT },
      'upsert',
    )
    expect(findOneMock).toHaveBeenCalledTimes(1)
    expect(upsertCalls).toHaveLength(2)
    const insertCall = upsertCalls.find((c) => c.action === 'insert')!
    expect(insertCall.table).toBe('prm_prospect_candidate_index')
    expect(insertCall.row).toMatchObject({
      prospect_id: 'p-1',
      organization_id: 'org-1',
      agency_id: 'agency-1',
      normalized_company_name: 'acme corp inc',
      lowercased_contact_email: 'lead@acme-corp.io',
      current_status: 'qualified',
    })
    const mergeCall = upsertCalls.find((c) => c.action === 'merge')!
    expect(mergeCall.patch).toMatchObject({
      normalized_company_name: 'acme corp inc',
      current_status: 'qualified',
    })
  })

  it('is a no-op upsert when the canonical Prospect was concurrently soft-deleted', async () => {
    findOneMock.mockResolvedValueOnce(null)
    await handleProspectCandidateIndex({ prospectId: 'p-deleted', tenantId: TENANT }, 'upsert')
    expect(upsertCalls).toEqual([])
  })

  it('deletes the projection row on registration_reverted', async () => {
    await handleProspectCandidateIndex(
      { prospectId: 'p-existing', tenantId: TENANT },
      'delete',
    )
    expect(removeAndFlushMock).toHaveBeenCalledTimes(1)
  })

  it('is idempotent on delete when the projection row is already gone', async () => {
    await handleProspectCandidateIndex(
      { prospectId: 'p-missing', tenantId: TENANT },
      'delete',
    )
    expect(removeAndFlushMock).not.toHaveBeenCalled()
  })

  it('ignores payloads missing prospect_id or tenant_id', async () => {
    await handleProspectCandidateIndex({ prospectId: '', tenantId: TENANT } as any, 'upsert')
    expect(findOneMock).not.toHaveBeenCalled()
  })
})

// Ensure the imported entity classes are referenced so static analyzers don't strip them
// from the test bundle (Prospect/ProspectCandidateIndex are used as identity-comparison
// keys in the EM mocks above).
const _PROSPECT_REF = Prospect
const _INDEX_REF = ProspectCandidateIndex
void _PROSPECT_REF
void _INDEX_REF
