import { safeEmit } from '../lib/safeEmit'

jest.mock('../events', () => ({
  emitPrmEvent: jest.fn(),
}))

const { emitPrmEvent } = jest.requireMock('../events') as {
  emitPrmEvent: jest.Mock
}

describe('safeEmit', () => {
  let warnSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    emitPrmEvent.mockReset()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('forwards the event ID + payload to the underlying emitter on the happy path', async () => {
    emitPrmEvent.mockResolvedValueOnce(undefined)

    await safeEmit('prm.agency.created', { agencyId: 'a-1', tenantId: 't-1' })

    expect(emitPrmEvent).toHaveBeenCalledWith(
      'prm.agency.created',
      { agencyId: 'a-1', tenantId: 't-1' },
    )
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('does not throw and logs a warning when the emitter rejects', async () => {
    emitPrmEvent.mockRejectedValueOnce(new Error('event bus offline'))

    await expect(
      safeEmit('prm.agency.tier_changed', { agencyId: 'a-1' }),
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, detail] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('prm.agency.tier_changed')
    expect(message).toContain('event bus offline')
    expect(detail).toMatchObject({ eventId: 'prm.agency.tier_changed' })
  })

  it('routes warnings through the DI-resolved logger when a container is supplied', async () => {
    emitPrmEvent.mockRejectedValueOnce(new Error('boom'))
    const containerLogger = { warn: jest.fn(), error: jest.fn() }
    const container = { resolve: jest.fn().mockReturnValue(containerLogger) }

    await safeEmit(
      'prm.agency_member.role_changed',
      { agencyId: 'a-1' },
      { container, context: { reason: 'unit-test' } },
    )

    expect(container.resolve).toHaveBeenCalledWith('logger')
    expect(containerLogger.warn).toHaveBeenCalledTimes(1)
    expect(containerLogger.error).not.toHaveBeenCalled()
    const [message, detail] = containerLogger.warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('prm.agency_member.role_changed')
    expect(detail).toMatchObject({ eventId: 'prm.agency_member.role_changed', reason: 'unit-test' })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls back to console when the container does not expose a logger', async () => {
    emitPrmEvent.mockRejectedValueOnce(new Error('still broken'))
    const container = {
      resolve: jest.fn(() => {
        throw new Error('not registered')
      }),
    }

    await safeEmit('prm.agency.deleted', { agencyId: 'a-1' }, { container })

    expect(container.resolve).toHaveBeenCalledWith('logger')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('uses error-level logging when silent: false is passed', async () => {
    emitPrmEvent.mockRejectedValueOnce(new Error('critical'))
    const containerLogger = { warn: jest.fn(), error: jest.fn() }
    const container = { resolve: jest.fn().mockReturnValue(containerLogger) }

    await safeEmit(
      'prm.agency.admin_field_access_rejected',
      { agencyId: 'a-1', fieldName: 'tier' },
      { container, silent: false },
    )

    expect(containerLogger.error).toHaveBeenCalledTimes(1)
    expect(containerLogger.warn).not.toHaveBeenCalled()
  })
})
