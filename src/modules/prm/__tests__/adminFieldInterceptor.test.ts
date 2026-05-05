import { interceptors } from '../api/interceptors'

const emitMock: jest.Mock = jest.fn(async (_eventId: string, _payload: unknown) => undefined)
jest.mock('../events', () => ({
  emitPrmEvent: (eventId: string, payload: unknown) => emitMock(eventId, payload),
}))

describe('Portal admin-only field interceptor (invariant #6)', () => {
  beforeEach(() => emitMock.mockClear())

  const guard = interceptors.find((i) => i.id === 'prm.portal-agency-admin-field-guard')!
  const AGENCY_UUID = '11111111-1111-1111-1111-111111111111'

  function makeReq(body: Record<string, unknown>): any {
    return {
      method: 'PATCH',
      url: `https://example.com/api/prm/portal/agency/${AGENCY_UUID}`,
      body,
      query: {},
      headers: {},
    }
  }

  it('passes through writes that touch only editable fields', async () => {
    const result = await guard.before!(makeReq({ name: 'New name', description: 'lorem' }), { userId: 'cu-1' } as any)
    expect(result.ok).toBe(true)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('rejects with 403 + diagnostic event when admin-only fields are present', async () => {
    const result = await guard.before!(makeReq({ name: 'X', tier: 'ai_native_core' }), { userId: 'cu-1' } as any)
    expect(result.ok).toBe(false)
    expect((result as any).statusCode).toBe(403)
    expect((result as any).body.error.code).toBe('admin_only_field')
    expect(emitMock).toHaveBeenCalledWith(
      'prm.agency.admin_field_access_rejected',
      expect.objectContaining({ agencyId: AGENCY_UUID, fieldName: 'tier', customerUserId: 'cu-1' }),
    )
  })

  it('handles snake_case field aliases for legacy clients', async () => {
    const result = await guard.before!(makeReq({ contract_signed: true }), { userId: null } as any)
    expect(result.ok).toBe(false)
    expect(((result as any).body.error.details.fields as string[])).toContain('contract_signed')
  })
})
