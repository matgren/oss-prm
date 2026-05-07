/**
 * Spec #4 §4.1 — `SupersedeWicContributionCommand` (undoable).
 *
 *   - execute happy path: previous flagged + `prm.wic.contribution_superseded` emitted.
 *   - undo happy path: supersession cleared + `prm.wic.contribution_superseded.undone` emitted.
 *   - undo idempotency: second undo is a no-op + still re-emits compensation event.
 *   - missing-row: execute throws / undo returns null.
 *   - chain safety: undo of inner supersession in a chain does NOT touch the outer row.
 *   - re-running execute with the SAME newContributionId is allowed (replay safe).
 *   - re-running execute with a DIFFERENT newContributionId throws (chain corruption guard).
 */

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: async (em: any, Cls: any, where: any) => em.findOne(Cls, where),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }

import {
  execute,
  executeById,
  undo,
  SupersedeWicContributionCommand,
} from '../commands/wic/supersedeWicContribution'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const AGENCY = '33333333-3333-4333-8333-333333333333'
const MEMBER = '44444444-4444-4444-8444-444444444444'

class FakeEm {
  rows: any[] = []

  persist(_row: any): this {
    return this
  }

  async flush(): Promise<void> {}

  async findOne(_cls: any, where: any) {
    return (
      this.rows.find(
        (r) => r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId),
      ) ?? null
    )
  }
}

function seedActiveRow(em: FakeEm, id: string): any {
  const row = {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    agencyId: AGENCY,
    agencyMemberId: MEMBER,
    contributionMonth: new Date('2026-03-01T00:00:00.000Z'),
    supersededById: null,
    archivedAt: null,
    updatedAt: new Date('2026-04-01T00:00:00Z'),
  }
  em.rows.push(row)
  return row
}

describe('SupersedeWicContributionCommand.execute', () => {
  beforeEach(() => safeEmit.mockClear())

  it('flips supersededById + archivedAt on the previous row and emits the event', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    const result = await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )
    expect(prev.supersededById).toBe('new-1')
    expect(prev.archivedAt).toBeInstanceOf(Date)
    expect(result.previousContributionId).toBe('prev-1')
    expect(result.newContributionId).toBe('new-1')
    expect(result.archivedAt).toBe(prev.archivedAt!.toISOString())

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_superseded',
      expect.objectContaining({
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        agencyId: AGENCY,
        agencyMemberId: MEMBER,
        contributionMonth: '2026-03-01T00:00:00.000Z',
      }),
      expect.objectContaining({ container: null }),
    )
  })

  it('executeById throws when the previous row is missing', async () => {
    const em = new FakeEm()
    await expect(
      executeById(
        {
          tenantId: TENANT,
          organizationId: ORG,
          previousContributionId: 'missing',
          newContributionId: 'new-1',
        },
        { em: em as any },
      ),
    ).rejects.toThrow(/previous contribution missing not found/)
  })

  it('executeById loads the previous row by id then delegates to execute', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await executeById(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
      },
      { em: em as any },
    )
    expect(prev.supersededById).toBe('new-1')
  })

  it('execute throws if previous.id mismatches previousContributionId', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await expect(
      execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          previousContributionId: 'different-id',
          newContributionId: 'new-1',
          previous: prev,
        },
        { em: em as any },
      ),
    ).rejects.toThrow(/previous\.id .* does not match/)
  })

  it('is replay-safe — re-executing with the SAME newContributionId is fine', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )
    const firstArchivedAt = prev.archivedAt
    safeEmit.mockClear()

    // Replay with the same args — should not throw + should not overwrite archivedAt.
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )
    expect(prev.supersededById).toBe('new-1')
    expect(prev.archivedAt).toBe(firstArchivedAt) // unchanged on replay
  })

  it('throws when re-executing with a DIFFERENT newContributionId (chain corruption guard)', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )
    await expect(
      execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          previousContributionId: 'prev-1',
          newContributionId: 'new-2',
          previous: prev,
        },
        { em: em as any },
      ),
    ).rejects.toThrow(/already superseded by new-1/)
  })
})

describe('SupersedeWicContributionCommand.undo', () => {
  beforeEach(() => safeEmit.mockClear())

  it('clears supersededById + archivedAt and emits the compensation event', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, previousContributionId: 'prev-1' },
      { em: em as any },
    )
    expect(prev.supersededById).toBeNull()
    expect(prev.archivedAt).toBeNull()
    expect(result?.alreadyUnsuperseded).toBe(false)
    expect(result?.clearedSupersedingContributionId).toBe('new-1')

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_superseded.undone',
      expect.objectContaining({
        previousContributionId: 'prev-1',
        clearedSupersedingContributionId: 'new-1',
        alreadyUnsuperseded: false,
      }),
      expect.any(Object),
    )
  })

  it('is idempotent — second undo still emits compensation event but does not re-write fields', async () => {
    const em = new FakeEm()
    const prev = seedActiveRow(em, 'prev-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'prev-1',
        newContributionId: 'new-1',
        previous: prev,
      },
      { em: em as any },
    )

    await undo(
      { tenantId: TENANT, organizationId: ORG, previousContributionId: 'prev-1' },
      { em: em as any },
    )
    const updatedAtAfterFirstUndo = prev.updatedAt
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, previousContributionId: 'prev-1' },
      { em: em as any },
    )
    expect(result?.alreadyUnsuperseded).toBe(true)
    expect(result?.clearedSupersedingContributionId).toBeNull()
    expect(prev.updatedAt).toBe(updatedAtAfterFirstUndo) // unchanged on second undo

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_superseded.undone',
      expect.objectContaining({
        previousContributionId: 'prev-1',
        alreadyUnsuperseded: true,
      }),
      expect.any(Object),
    )
  })

  it('returns null when the previous row is not found', async () => {
    const em = new FakeEm()
    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, previousContributionId: 'missing' },
      { em: em as any },
    )
    expect(result).toBeNull()
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('chain safety — undo of inner supersession does NOT touch outer chain link', async () => {
    // Setup: gen1 ← superseded by gen2 ← superseded by gen3.
    // Undoing gen1's supersession (gen1 ← gen2) should leave gen2's row state alone:
    //   - gen1 becomes "live" again (the undo target).
    //   - gen2 remains superseded by gen3 (its own state is untouched).
    const em = new FakeEm()
    const gen1 = seedActiveRow(em, 'gen1')
    const gen2 = seedActiveRow(em, 'gen2')

    // Step 1: gen2 supersedes gen1.
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'gen1',
        newContributionId: 'gen2',
        previous: gen1,
      },
      { em: em as any },
    )
    // Step 2: gen3 supersedes gen2.
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        previousContributionId: 'gen2',
        newContributionId: 'gen3',
        previous: gen2,
      },
      { em: em as any },
    )
    expect(gen1.supersededById).toBe('gen2')
    expect(gen2.supersededById).toBe('gen3')

    // Step 3: undo gen1 ← gen2. Should ONLY un-supersede gen1.
    safeEmit.mockClear()
    await undo(
      { tenantId: TENANT, organizationId: ORG, previousContributionId: 'gen1' },
      { em: em as any },
    )
    expect(gen1.supersededById).toBeNull()
    expect(gen1.archivedAt).toBeNull()
    // gen2 is still superseded by gen3 — outer chain intact.
    expect(gen2.supersededById).toBe('gen3')
    expect(gen2.archivedAt).toBeInstanceOf(Date)
  })
})

it('exposes the namespace SupersedeWicContributionCommand with execute + executeById + undo', () => {
  expect(typeof SupersedeWicContributionCommand.execute).toBe('function')
  expect(typeof SupersedeWicContributionCommand.executeById).toBe('function')
  expect(typeof SupersedeWicContributionCommand.undo).toBe('function')
})
