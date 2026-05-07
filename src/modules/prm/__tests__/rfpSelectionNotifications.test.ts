/**
 * Spec #6 — `RfpSelectionNotifier` subscriber dispatch tests.
 *
 * The subscriber resolves recipients, calls `buildBatchNotificationFromType`,
 * and writes via `notificationService.createBatch`. We mock those framework
 * boundaries and a forked EM so the test focuses on the fan-out shape.
 */

const createBatchMock = jest.fn()

jest.mock('@open-mercato/core/modules/notifications/lib/notificationService', () => ({
  resolveNotificationService: () => ({
    createBatch: createBatchMock,
  }),
}))

jest.mock('@open-mercato/core/modules/notifications/lib/notificationBuilder', () => ({
  buildBatchNotificationFromType: jest.fn((typeDef: any, opts: any) => ({
    typeDef,
    opts,
  })),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async (_em: any, Ctor: any, where: any) => {
    // Each test sets `__members` on the EM stub; we filter by the agency-id
    // predicate to mimic the subscriber's intent.
    const ctorName = Ctor?.name ?? ''
    if (ctorName !== 'AgencyMember') return []
    const stub = (_em as any).__members ?? []
    const target = where?.agencyId?.$in as string[] | undefined
    return stub.filter((m: any) =>
      m.isActive !== false &&
      (Array.isArray(target) ? target.includes(m.agencyId) : true) &&
      m.customerUserId,
    )
  }),
}))

import handleSelectionEvent from '../subscribers/rfp-selection-notifications'

type AnyRow = Record<string, any>

class FakeForkedEm {
  __members: AnyRow[] = []
  __broadcasts: AnyRow[] = []
  __rfp: AnyRow | null = null
  __roles: AnyRow[] = []

  async findOne(Ctor: any, where: AnyRow): Promise<AnyRow | null> {
    if (Ctor?.name === 'Rfp') {
      if (this.__rfp && where.id === this.__rfp.id) return this.__rfp
      return null
    }
    return null
  }

  async find(Ctor: any, where: AnyRow): Promise<AnyRow[]> {
    if (Ctor?.name === 'RfpBroadcast') {
      return this.__broadcasts.filter((b) => b.rfpId === where.rfpId)
    }
    if (Ctor?.name === 'CustomerUserRole') {
      const target = where?.customerUserId?.$in as string[] | undefined
      return this.__roles.filter((r) =>
        Array.isArray(target) ? target.includes(r.customerUserId) : true,
      )
    }
    return []
  }
}

class FakeBaseEm {
  fork(_opts: any) {
    return this.__forked
  }
  __forked = new FakeForkedEm()
}

function makeCtx(em: FakeBaseEm) {
  return {
    resolve: <T = unknown>(name: string): T => {
      if (name === 'em') return em as unknown as T
      throw new Error(`unexpected resolve("${name}")`)
    },
  }
}

function seed(em: FakeBaseEm) {
  em.__forked.__rfp = {
    id: 'rfp-1',
    organizationId: 'o-1',
    title: 'RFP',
    receivedFrom: 'Acme',
    deadlineToRespond: null,
    deletedAt: null,
  }
  em.__forked.__broadcasts = [
    { rfpId: 'rfp-1', agencyId: 'agency-A' },
    { rfpId: 'rfp-1', agencyId: 'agency-B' },
    { rfpId: 'rfp-1', agencyId: 'agency-C' },
  ]
  em.__forked.__members = [
    { agencyId: 'agency-A', customerUserId: 'cu-A1', isActive: true },
    { agencyId: 'agency-A', customerUserId: 'cu-A2', isActive: true },
    { agencyId: 'agency-B', customerUserId: 'cu-B1', isActive: true },
    { agencyId: 'agency-C', customerUserId: 'cu-C1', isActive: true },
  ]
  em.__forked.__roles = [
    { customerUserId: 'cu-A1', roleSlug: 'partner_admin' },
    { customerUserId: 'cu-A2', roleSlug: 'partner_member' },
    { customerUserId: 'cu-B1', roleSlug: 'partner_admin' },
    { customerUserId: 'cu-C1', roleSlug: 'partner_admin' },
  ]
}

describe('RfpSelectionNotifier subscriber', () => {
  beforeEach(() => {
    createBatchMock.mockReset()
  })

  it('selection_made: winner gets prm.rfp.selected, non-winners get prm.rfp.not_selected', async () => {
    const em = new FakeBaseEm()
    seed(em)
    await handleSelectionEvent(
      {
        rfp_id: 'rfp-1',
        winner_agency_id: 'agency-A',
        winner_rfp_response_id: 'resp-A',
        runners_up_agency_ids: ['agency-B', 'agency-C'],
        selection_reasoning: 'Strong tech depth + named-client evidence.',
        decided_by_user_id: 'staff-1',
      },
      makeCtx(em),
    )
    // Two batch calls — winner + non-winner.
    expect(createBatchMock).toHaveBeenCalledTimes(2)
    const calls = createBatchMock.mock.calls.map((c) => c[0])
    const winnerCall = calls.find((c: any) => c.typeDef.type === 'prm.rfp.selected')
    const notSelectedCall = calls.find((c: any) => c.typeDef.type === 'prm.rfp.not_selected')
    expect(winnerCall).toBeTruthy()
    expect(notSelectedCall).toBeTruthy()
    expect(winnerCall.opts.recipientUserIds.sort()).toEqual(['cu-A1', 'cu-A2'])
    expect(notSelectedCall.opts.recipientUserIds.sort()).toEqual(['cu-B1', 'cu-C1'])
  })

  it('selection_changed: prior winner moves into the not_selected pool', async () => {
    const em = new FakeBaseEm()
    seed(em)
    await handleSelectionEvent(
      {
        rfp_id: 'rfp-1',
        from_agency_id: 'agency-A',
        to_agency_id: 'agency-B',
        from_rfp_response_id: 'resp-A',
        to_rfp_response_id: 'resp-B',
        reason: 'Re-selecting after challenge round.',
        changed_by_user_id: 'staff-1',
      },
      makeCtx(em),
    )
    expect(createBatchMock).toHaveBeenCalledTimes(2)
    const calls = createBatchMock.mock.calls.map((c) => c[0])
    const winnerCall = calls.find((c: any) => c.typeDef.type === 'prm.rfp.selected')
    const notSelectedCall = calls.find((c: any) => c.typeDef.type === 'prm.rfp.not_selected')
    expect(winnerCall.opts.recipientUserIds.sort()).toEqual(['cu-B1'])
    // Prior winner (agency-A) is now in the not_selected pool — both A1 and A2.
    expect(notSelectedCall.opts.recipientUserIds.sort()).toEqual(['cu-A1', 'cu-A2', 'cu-C1'])
  })

  it('no-op when RFP not found', async () => {
    const em = new FakeBaseEm()
    // No __rfp seeded.
    em.__forked.__broadcasts = [{ rfpId: 'rfp-1', agencyId: 'agency-A' }]
    await handleSelectionEvent(
      {
        rfp_id: 'rfp-1',
        winner_agency_id: 'agency-A',
        winner_rfp_response_id: 'resp-A',
        runners_up_agency_ids: [],
        selection_reasoning: 'irrelevant',
        decided_by_user_id: 'staff-1',
      },
      makeCtx(em),
    )
    expect(createBatchMock).not.toHaveBeenCalled()
  })

  it('only PartnerAdmin / PartnerMember CustomerUserRoles are eligible recipients', async () => {
    const em = new FakeBaseEm()
    seed(em)
    // Add an unrelated role for cu-A1 — should still be allowed because we
    // also have a valid partner_admin role for them. Add a non-partner role
    // to the only customer user of agency C — they should be filtered out.
    em.__forked.__roles = [
      { customerUserId: 'cu-A1', roleSlug: 'partner_admin' },
      { customerUserId: 'cu-A2', roleSlug: 'partner_member' },
      { customerUserId: 'cu-B1', roleSlug: 'partner_admin' },
      { customerUserId: 'cu-C1', roleSlug: 'something_else' },
    ]
    await handleSelectionEvent(
      {
        rfp_id: 'rfp-1',
        winner_agency_id: 'agency-A',
        winner_rfp_response_id: 'resp-A',
        runners_up_agency_ids: ['agency-B', 'agency-C'],
        selection_reasoning: 'Strong tech depth + named-client evidence.',
        decided_by_user_id: 'staff-1',
      },
      makeCtx(em),
    )
    const calls = createBatchMock.mock.calls.map((c) => c[0])
    const notSelectedCall = calls.find((c: any) => c.typeDef.type === 'prm.rfp.not_selected')
    // cu-C1 has only `something_else` so they should be filtered out.
    expect(notSelectedCall.opts.recipientUserIds).not.toContain('cu-C1')
    expect(notSelectedCall.opts.recipientUserIds).toContain('cu-B1')
  })
})
