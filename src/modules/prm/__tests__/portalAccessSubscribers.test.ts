import revokeHandler, { metadata as revokeMeta } from '../subscribers/agency-member-portal-access-revoke'
import restoreHandler, { metadata as restoreMeta } from '../subscribers/agency-member-portal-access-restore'

const revokeMock = jest.fn<Promise<{ ok: true; effect: 'revoked' }>, [unknown]>(async () => ({
  ok: true,
  effect: 'revoked',
}))
const restoreMock = jest.fn<Promise<{ ok: true; effect: 'restored' }>, [unknown]>(async () => ({
  ok: true,
  effect: 'restored',
}))

jest.mock('../lib/portalAccessSync', () => ({
  revokePortalAccess: (args: any) => revokeMock(args),
  restorePortalAccess: (args: any) => restoreMock(args),
}))

const containerStub = { resolve: () => ({}) }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => containerStub),
}))

beforeEach(() => {
  revokeMock.mockClear()
  restoreMock.mockClear()
})

describe('agency-member-portal-access-revoke subscriber', () => {
  it('exports correct metadata', () => {
    expect(revokeMeta.event).toBe('prm.agency_member.removed')
    expect(revokeMeta.persistent).toBe(true)
    expect(revokeMeta.id).toBe('prm-agency-member-portal-access-revoke')
  })

  it('calls revokePortalAccess with payload customerUserId + tenantId', async () => {
    await revokeHandler({
      tenantId: 'ten-1',
      customerUserId: 'cu-1',
      agencyId: 'ag-1',
      agencyMemberId: 'mem-1',
    })
    expect(revokeMock).toHaveBeenCalledWith({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: containerStub,
    })
  })

  it('no-ops when customerUserId is null (pre-accept member)', async () => {
    await revokeHandler({
      tenantId: 'ten-1',
      customerUserId: null,
      agencyMemberId: 'mem-1',
    })
    expect(revokeMock).not.toHaveBeenCalled()
  })

  it('no-ops when tenantId is missing', async () => {
    await revokeHandler({ customerUserId: 'cu-1' })
    expect(revokeMock).not.toHaveBeenCalled()
  })
})

describe('agency-member-portal-access-restore subscriber', () => {
  it('exports correct metadata', () => {
    expect(restoreMeta.event).toBe('prm.agency_member.reactivated')
    expect(restoreMeta.persistent).toBe(true)
    expect(restoreMeta.id).toBe('prm-agency-member-portal-access-restore')
  })

  it('calls restorePortalAccess with payload customerUserId + tenantId', async () => {
    await restoreHandler({
      tenantId: 'ten-1',
      customerUserId: 'cu-1',
      agencyId: 'ag-1',
      agencyMemberId: 'mem-1',
    })
    expect(restoreMock).toHaveBeenCalledWith({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: containerStub,
    })
  })

  it('no-ops when customerUserId is null', async () => {
    await restoreHandler({
      tenantId: 'ten-1',
      customerUserId: null,
    })
    expect(restoreMock).not.toHaveBeenCalled()
  })
})
