import { AgencyMemberService } from '../lib/agencyMemberService'
import { AgencyMember, Agency } from '../data/entities'
import { PrmDomainError, PRM_ERROR_CODES } from '../lib/errors'

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/services/customerInvitationService', () => ({
  CustomerInvitationService: jest.fn().mockImplementation(() => ({
    createInvitation: jest.fn().mockResolvedValue({
      invitation: {
        id: 'inv-new',
        email: 'invited@example.test',
        cancelledAt: null,
        expiresAt: new Date('2026-06-01'),
      },
      rawToken: 'raw-token-new',
    }),
  })),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }
const findOne = jest.requireMock('@open-mercato/shared/lib/encryption/find').findOneWithDecryption as jest.Mock

class FakeEntityManager {
  flushed = 0
  persisted: unknown[] = []
  persist(row: unknown): void {
    this.persisted.push(row)
  }
  async flush(): Promise<void> {
    this.flushed += 1
  }
}

function buildAgency(overrides: Partial<Agency> = {}): Agency {
  return {
    id: 'ag-1',
    tenantId: 'ten-1',
    organizationId: 'org-1',
    name: 'Acme Partners',
    slug: 'acme',
    status: 'active',
    ...overrides,
  } as unknown as Agency
}

function buildMember(overrides: Partial<AgencyMember> = {}): AgencyMember {
  const base: any = {
    id: 'mem-1',
    agencyId: 'ag-1',
    tenantId: 'ten-1',
    customerUserId: null,
    invitationId: 'inv-old',
    email: 'invited@example.test',
    firstName: 'Wojtek',
    lastName: 'Gren',
    roleInAgency: null,
    githubProfile: null,
    isActive: true,
    invitedAt: new Date('2026-04-01'),
    activatedAt: null,
    agencyStatus: 'active',
    roleSlug: 'partner_member',
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...overrides,
  }
  return base as AgencyMember
}

describe('AgencyMemberService.resendInvite', () => {
  beforeEach(() => {
    safeEmit.mockClear()
    findOne.mockReset()
  })

  it('cancels the prior invitation, mints a new one, and points the member at it', async () => {
    const oldInvitation = { id: 'inv-old', cancelledAt: null }
    findOne
      .mockResolvedValueOnce(oldInvitation) // CustomerUserInvitation lookup
      .mockResolvedValueOnce({ id: 'role-1', slug: 'partner_member' }) // CustomerRole lookup

    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember()
    const agency = buildAgency()

    const result = await svc.resendInvite({ member, agency, invitedByCustomerUserId: 'cu-admin' })

    expect(oldInvitation.cancelledAt).toBeInstanceOf(Date)
    expect(result.invitation.id).toBe('inv-new')
    expect(result.rawToken).toBe('raw-token-new')
    expect(member.invitationId).toBe('inv-new')
    expect(member.invitedAt).toBeInstanceOf(Date)
    expect(member.invitedAt.getTime()).toBeGreaterThan(new Date('2026-04-01').getTime())
    expect(em.flushed).toBe(1)

    const events = safeEmit.mock.calls.map((c) => c[0])
    expect(events).toContain('prm.agency_member.invite_resent')
    const resentCall = safeEmit.mock.calls.find((c) => c[0] === 'prm.agency_member.invite_resent')!
    expect(resentCall[1]).toMatchObject({
      agencyId: 'ag-1',
      tenantId: 'ten-1',
      agencyMemberId: 'mem-1',
      invitationId: 'inv-new',
      roleSlug: 'partner_member',
    })
  })

  it('refuses to resend for an already-activated member (409)', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ customerUserId: 'cu-1', activatedAt: new Date('2026-04-15') })

    await expect(svc.resendInvite({ member, agency: buildAgency() })).rejects.toMatchObject({
      code: PRM_ERROR_CODES.VALIDATION_FAILED,
      status: 409,
    })
    expect(em.flushed).toBe(0)
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('refuses to resend for a deactivated member (409)', async () => {
    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ isActive: false })

    await expect(svc.resendInvite({ member, agency: buildAgency() })).rejects.toMatchObject({
      code: PRM_ERROR_CODES.VALIDATION_FAILED,
      status: 409,
    })
    expect(em.flushed).toBe(0)
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('throws ROLE_SLUG_NOT_SEEDED when the partner_member role is missing', async () => {
    findOne
      .mockResolvedValueOnce({ id: 'inv-old', cancelledAt: null }) // invitation
      .mockResolvedValueOnce(null) // role lookup returns nothing

    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember()

    await expect(svc.resendInvite({ member, agency: buildAgency() })).rejects.toBeInstanceOf(PrmDomainError)
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('skips cancelling an invitation row that is already cancelled', async () => {
    const cancelledInvitation = { id: 'inv-old', cancelledAt: new Date('2026-04-10') }
    findOne
      .mockResolvedValueOnce(cancelledInvitation)
      .mockResolvedValueOnce({ id: 'role-1', slug: 'partner_member' })

    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember()

    await svc.resendInvite({ member, agency: buildAgency() })

    expect(cancelledInvitation.cancelledAt).toEqual(new Date('2026-04-10'))
  })

  it('handles a member with no prior invitation row (defensive — never happens in practice)', async () => {
    // With invitationId=null the service skips the invitation lookup entirely,
    // so the role lookup is the first findOne call.
    findOne.mockResolvedValueOnce({ id: 'role-1', slug: 'partner_member' })

    const em = new FakeEntityManager() as any
    const svc = new AgencyMemberService(em)
    const member = buildMember({ invitationId: null })

    const result = await svc.resendInvite({ member, agency: buildAgency() })

    expect(result.invitation.id).toBe('inv-new')
    expect(member.invitationId).toBe('inv-new')
    expect(findOne).toHaveBeenCalledTimes(1)
  })
})
