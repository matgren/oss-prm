/**
 * Spec #6 — `ChallengeRoundRevisionUnlocker` subscriber tests.
 *
 * Mocks `safeEmit` to capture the per-response signals and verifies the
 * subscriber emits exactly one `prm.rfp_response.available_for_revision`
 * for each previously-submitted response on the re-opened RFP.
 */

const safeEmitMock = jest.fn()
jest.mock('../lib/safeEmit', () => ({
  safeEmit: (...args: unknown[]) => safeEmitMock(...args),
}))

import handleChallengeRoundEvent from '../subscribers/rfp-challenge-round-unlocker'

type AnyRow = Record<string, any>

class FakeForkedEm {
  __responses: AnyRow[] = []
  async find(Ctor: any, where: AnyRow): Promise<AnyRow[]> {
    if (Ctor?.name !== 'RfpResponse') return []
    return this.__responses.filter((r) => r.rfpId === where.rfpId)
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

describe('RfpChallengeRoundUnlocker subscriber', () => {
  beforeEach(() => {
    safeEmitMock.mockReset()
  })

  it('emits available_for_revision per submitted response', async () => {
    const em = new FakeBaseEm()
    em.__forked.__responses = [
      { id: 'resp-A', rfpId: 'rfp-1', agencyId: 'agency-A', status: 'submitted' },
      { id: 'resp-B', rfpId: 'rfp-1', agencyId: 'agency-B', status: 'submitted' },
    ]
    await handleChallengeRoundEvent(
      {
        rfp_id: 'rfp-1',
        trigger: 'client_reopen',
        reopened_by_user_id: 'staff-1',
        reopened_deadline_at: '2026-06-30T12:00:00.000Z',
      },
      makeCtx(em),
    )
    expect(safeEmitMock).toHaveBeenCalledTimes(2)
    const calls = safeEmitMock.mock.calls
    const eventIds = calls.map((c) => c[0])
    expect(eventIds.every((id) => id === 'prm.rfp_response.available_for_revision')).toBe(true)
    const respIds = calls.map((c) => c[1].rfp_response_id).sort()
    expect(respIds).toEqual(['resp-A', 'resp-B'])
  })

  it('skips draft responses', async () => {
    const em = new FakeBaseEm()
    em.__forked.__responses = [
      { id: 'resp-A', rfpId: 'rfp-1', agencyId: 'agency-A', status: 'submitted' },
      { id: 'resp-draft', rfpId: 'rfp-1', agencyId: 'agency-D', status: 'draft' },
    ]
    await handleChallengeRoundEvent(
      {
        rfp_id: 'rfp-1',
        trigger: 'client_reopen',
        reopened_deadline_at: '2026-06-30T12:00:00.000Z',
      },
      makeCtx(em),
    )
    expect(safeEmitMock).toHaveBeenCalledTimes(1)
    expect(safeEmitMock.mock.calls[0]?.[1].rfp_response_id).toBe('resp-A')
  })

  it('is a no-op when no responses match', async () => {
    const em = new FakeBaseEm()
    em.__forked.__responses = []
    await handleChallengeRoundEvent(
      {
        rfp_id: 'rfp-1',
        trigger: 'client_reopen',
        reopened_deadline_at: '2026-06-30T12:00:00.000Z',
      },
      makeCtx(em),
    )
    expect(safeEmitMock).not.toHaveBeenCalled()
  })
})
