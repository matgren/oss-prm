import handler from '../subscribers/agency-member-status-readmodel'

const flushMock = jest.fn(async () => undefined)
const findMock = jest.fn()
const persistMock = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') return { find: findMock, flush: flushMock, persist: persistMock }
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

beforeEach(() => {
  findMock.mockReset()
  flushMock.mockClear()
  persistMock.mockClear()
})

describe('AgencyMemberStatusReadModelSubscriber (Vernon C3)', () => {
  it('skips when payload is incomplete', async () => {
    await handler({} as any)
    expect(findMock).not.toHaveBeenCalled()
  })

  it('updates each member row to the new agency_status', async () => {
    const member1: any = { id: 'm1', agencyStatus: 'active', updatedAt: new Date(0) }
    const member2: any = { id: 'm2', agencyStatus: 'active', updatedAt: new Date(0) }
    findMock.mockResolvedValue([member1, member2])
    await handler({
      agencyId: 'a-1',
      tenantId: 't-1',
      fromStatus: 'active',
      toStatus: 'historical',
    })
    expect(member1.agencyStatus).toBe('historical')
    expect(member2.agencyStatus).toBe('historical')
    expect(persistMock).toHaveBeenCalledTimes(2)
    expect(flushMock).toHaveBeenCalledTimes(1)
  })
})
