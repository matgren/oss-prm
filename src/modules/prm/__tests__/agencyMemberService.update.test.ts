import { AgencyMemberService } from '../lib/agencyMemberService'
import { AgencyMember } from '../data/entities'

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }

class FakeEntityManager {
  flushed = 0
  persist(_row: unknown): void {
    // no-op
  }
  async flush(): Promise<void> {
    this.flushed += 1
  }
}

function buildMember(overrides: Partial<AgencyMember> = {}): AgencyMember {
  const base: any = {
    id: 'mem-1',
    agencyId: 'ag-1',
    tenantId: 'ten-1',
    customerUserId: 'cu-1',
    invitationId: null,
    email: 'a@b.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    roleInAgency: null,
    githubProfile: null,
    isActive: true,
    invitedAt: new Date('2026-01-01'),
    activatedAt: new Date('2026-01-02'),
    agencyStatus: 'active',
    roleSlug: 'partner_member',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  }
  return base as AgencyMember
}

describe('AgencyMemberService.update isActive transitions', () => {
  beforeEach(() => {
    safeEmit.mockClear()
  })

  it('emits prm.agency_member.removed when isActive flips true → false', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ isActive: true })

    await svc.update(member, { isActive: false } as any, { allowRoleChange: false })

    const calls = safeEmit.mock.calls.map((c) => c[0])
    expect(calls).toContain('prm.agency_member.removed')
    expect(calls).not.toContain('prm.agency_member.reactivated')

    const removedCall = safeEmit.mock.calls.find((c) => c[0] === 'prm.agency_member.removed')!
    expect(removedCall[1]).toMatchObject({
      agencyId: 'ag-1',
      tenantId: 'ten-1',
      agencyMemberId: 'mem-1',
      customerUserId: 'cu-1',
    })
  })

  it('emits prm.agency_member.reactivated when isActive flips false → true', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ isActive: false })

    await svc.update(member, { isActive: true } as any, { allowRoleChange: false })

    const calls = safeEmit.mock.calls.map((c) => c[0])
    expect(calls).toContain('prm.agency_member.reactivated')
    expect(calls).not.toContain('prm.agency_member.removed')

    const reactivatedCall = safeEmit.mock.calls.find(
      (c) => c[0] === 'prm.agency_member.reactivated',
    )!
    expect(reactivatedCall[1]).toMatchObject({
      agencyId: 'ag-1',
      tenantId: 'ten-1',
      agencyMemberId: 'mem-1',
      customerUserId: 'cu-1',
    })
  })

  it('does NOT emit removed/reactivated when isActive is unchanged', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ isActive: true, firstName: 'Old' })

    await svc.update(member, { firstName: 'New' } as any, { allowRoleChange: false })

    const calls = safeEmit.mock.calls.map((c) => c[0])
    expect(calls).not.toContain('prm.agency_member.removed')
    expect(calls).not.toContain('prm.agency_member.reactivated')
    expect(calls).toContain('prm.agency_member.updated')
  })

  it('passes customerUserId=null in payload when member is pre-accept (no CustomerUser yet)', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ isActive: true, customerUserId: null })

    await svc.update(member, { isActive: false } as any, { allowRoleChange: false })

    const removedCall = safeEmit.mock.calls.find((c) => c[0] === 'prm.agency_member.removed')!
    expect(removedCall[1]).toMatchObject({ customerUserId: null })
  })
})
