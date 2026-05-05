import handler from '../subscribers/prm-invitation-accepted'

const flushMock = jest.fn(async () => undefined)
const findOneMock = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') {
        return { findOne: findOneMock, flush: flushMock }
      }
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

jest.mock('../events', () => ({
  emitPrmEvent: jest.fn(async () => undefined),
}))

beforeEach(() => {
  flushMock.mockClear()
  findOneMock.mockReset()
})

describe('PrmInvitationAcceptedSubscriber', () => {
  it('skips when payload is incomplete', async () => {
    await handler({ invitationId: '', userId: '', tenantId: '' } as any)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  it('is a no-op when no placeholder member exists (idempotent)', async () => {
    findOneMock.mockResolvedValue(null)
    await handler({ invitationId: 'inv-1', userId: 'user-1', tenantId: 'tenant-1' })
    expect(flushMock).not.toHaveBeenCalled()
  })

  it('links placeholder, sets activated_at, and emits prm.agency_member.activated', async () => {
    const member: any = {
      id: 'mem-1',
      agencyId: 'agency-1',
      tenantId: 'tenant-1',
      customerUserId: null,
      activatedAt: null,
      updatedAt: new Date(0),
    }
    findOneMock.mockResolvedValueOnce(member)
    await handler({ invitationId: 'inv-1', userId: 'user-1', tenantId: 'tenant-1' })
    expect(member.customerUserId).toBe('user-1')
    expect(member.activatedAt).toBeInstanceOf(Date)
    expect(flushMock).toHaveBeenCalled()
    const events = require('../events')
    expect(events.emitPrmEvent).toHaveBeenCalledWith(
      'prm.agency_member.activated',
      expect.objectContaining({ agencyMemberId: 'mem-1', customerUserId: 'user-1' }),
    )
  })
})
