import { revokePortalAccess, restorePortalAccess } from '../lib/portalAccessSync'

jest.mock('@open-mercato/shared/lib/encryption/find', () => {
  const findOneWithDecryption = jest.fn()
  return { findOneWithDecryption, findWithDecryption: jest.fn() }
})

const { findOneWithDecryption } = jest.requireMock('@open-mercato/shared/lib/encryption/find') as {
  findOneWithDecryption: jest.Mock
}

function buildContainer(opts: {
  user?: { id: string; isActive: boolean; deletedAt?: Date | null }
  revokeSpy?: jest.Mock
}) {
  const flushMock = jest.fn(async () => undefined)
  const persistMock = jest.fn()
  const em = { persist: persistMock, flush: flushMock }
  const sessionService = { revokeAllUserSessions: opts.revokeSpy ?? jest.fn(async () => undefined) }
  return {
    em,
    flushMock,
    persistMock,
    sessionService,
    container: {
      resolve: (key: string): any => {
        if (key === 'em') return em
        if (key === 'customerSessionService') return sessionService
        throw new Error(`Unexpected DI key: ${key}`)
      },
    },
  }
}

beforeEach(() => {
  findOneWithDecryption.mockReset()
})

describe('revokePortalAccess', () => {
  it('flips isActive=false, persists, and revokes all sessions', async () => {
    const user = { id: 'cu-1', isActive: true, deletedAt: null }
    findOneWithDecryption.mockResolvedValue(user)
    const ctx = buildContainer({ user })

    const result = await revokePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: true, effect: 'revoked' })
    expect(user.isActive).toBe(false)
    expect(ctx.persistMock).toHaveBeenCalledTimes(1)
    expect(ctx.flushMock).toHaveBeenCalledTimes(1)
    expect(ctx.sessionService.revokeAllUserSessions).toHaveBeenCalledWith('cu-1')
  })

  it('returns missing_user_id when customerUserId is null (pre-accept member)', async () => {
    const ctx = buildContainer({})

    const result = await revokePortalAccess({
      customerUserId: null,
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: false, reason: 'missing_user_id' })
    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(ctx.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it('returns user_not_found when CustomerUser does not exist', async () => {
    findOneWithDecryption.mockResolvedValue(null)
    const ctx = buildContainer({})

    const result = await revokePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: false, reason: 'user_not_found' })
    expect(ctx.flushMock).not.toHaveBeenCalled()
    expect(ctx.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it('still revokes sessions when user is already inactive (idempotent retry path)', async () => {
    const user = { id: 'cu-1', isActive: false, deletedAt: null }
    findOneWithDecryption.mockResolvedValue(user)
    const ctx = buildContainer({ user })

    const result = await revokePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: true, effect: 'revoked' })
    expect(ctx.flushMock).not.toHaveBeenCalled() // no flip needed
    expect(ctx.sessionService.revokeAllUserSessions).toHaveBeenCalledWith('cu-1')
  })

  it('scopes the CustomerUser lookup by tenantId + deletedAt: null', async () => {
    const user = { id: 'cu-1', isActive: true, deletedAt: null }
    findOneWithDecryption.mockResolvedValue(user)
    const ctx = buildContainer({ user })

    await revokePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    const [, , whereArg, , decryptionScope] = findOneWithDecryption.mock.calls[0]
    expect(whereArg).toMatchObject({ id: 'cu-1', tenantId: 'ten-1', deletedAt: null })
    expect(decryptionScope).toEqual({ tenantId: 'ten-1' })
  })
})

describe('restorePortalAccess', () => {
  it('flips isActive=true and persists when previously inactive', async () => {
    const user = { id: 'cu-1', isActive: false, deletedAt: null }
    findOneWithDecryption.mockResolvedValue(user)
    const ctx = buildContainer({ user })

    const result = await restorePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: true, effect: 'restored' })
    expect(user.isActive).toBe(true)
    expect(ctx.flushMock).toHaveBeenCalledTimes(1)
    expect(ctx.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it('returns no-op when user is already active', async () => {
    const user = { id: 'cu-1', isActive: true, deletedAt: null }
    findOneWithDecryption.mockResolvedValue(user)
    const ctx = buildContainer({ user })

    const result = await restorePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: true, effect: 'no-op' })
    expect(ctx.flushMock).not.toHaveBeenCalled()
  })

  it('returns missing_user_id when customerUserId is null', async () => {
    const ctx = buildContainer({})

    const result = await restorePortalAccess({
      customerUserId: null,
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: false, reason: 'missing_user_id' })
    expect(findOneWithDecryption).not.toHaveBeenCalled()
  })

  it('returns user_not_found when user is hard-deleted upstream', async () => {
    findOneWithDecryption.mockResolvedValue(null)
    const ctx = buildContainer({})

    const result = await restorePortalAccess({
      customerUserId: 'cu-1',
      tenantId: 'ten-1',
      container: ctx.container,
    })

    expect(result).toEqual({ ok: false, reason: 'user_not_found' })
  })
})
