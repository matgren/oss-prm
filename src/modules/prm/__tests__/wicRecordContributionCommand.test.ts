/**
 * Spec #4 §4.1 — `RecordWicContributionCommand` (undoable).
 *
 *   - execute happy path: row inserted + `prm.wic.contribution_recorded` emitted.
 *   - undo happy path: `archivedAt` set + `prm.wic.contribution_recorded.undone` emitted.
 *   - undo idempotency: second undo is a no-op + still re-emits compensation event.
 *   - undo on missing row → returns null (caller decides 404).
 */

jest.mock('../lib/safeEmit', () => ({
  safeEmit: jest.fn().mockResolvedValue(undefined),
  default: jest.fn().mockResolvedValue(undefined),
}))

// Collapse decryption helper to a plain findOne so the FakeEm below works.
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: async (em: any, Cls: any, where: any) => em.findOne(Cls, where),
}))

const { safeEmit } = jest.requireMock('../lib/safeEmit') as { safeEmit: jest.Mock }

import {
  execute,
  undo,
  RecordWicContributionCommand,
  type RecordWicContributionArgs,
} from '../commands/wic/recordWicContribution'
import { WicContribution } from '../data/entities'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const AGENCY = '33333333-3333-4333-8333-333333333333'
const MEMBER = '44444444-4444-4444-8444-444444444444'
const BATCH = '55555555-5555-4555-8555-555555555555'

let nextId = 1
function uuid(): string {
  return `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
}

class FakeEm {
  contributions: any[] = []
  inserted: any[] = []

  create(_cls: any, data: any) {
    const created = { ...data, id: data.id ?? uuid() }
    this.contributions.push(created)
    this.inserted.push(created)
    return created
  }

  persist(_row: any): this {
    return this
  }

  async flush(): Promise<void> {}

  async findOne(_cls: any, where: any) {
    return (
      this.contributions.find(
        (c) =>
          c.id === where.id &&
          (where.tenantId === undefined || c.tenantId === where.tenantId),
      ) ?? null
    )
  }
}

function buildArgs(): RecordWicContributionArgs {
  return {
    tenantId: TENANT,
    organizationId: ORG,
    agencyId: AGENCY,
    agencyMemberId: MEMBER,
    githubProfile: 'octocat',
    contributionMonth: new Date('2026-03-01T00:00:00.000Z'),
    wicLevel: 'L2',
    wicScore: '42.5000',
    contributionCount: 7,
    bountyBonus: '10.0000',
    whyBonus: 'landed PR #1234',
    whatIncluded: 'pull requests',
    whatExcluded: 'reviews',
    scriptVersion: '1.0-agent',
    importBatchId: BATCH,
    rowIndex: 0,
    computedAt: new Date('2026-04-02T08:30:00Z'),
  }
}

describe('RecordWicContributionCommand.execute', () => {
  beforeEach(() => {
    nextId = 1
    safeEmit.mockClear()
  })

  it('inserts a WicContribution and emits prm.wic.contribution_recorded', async () => {
    const em = new FakeEm()
    const result = await execute(buildArgs(), { em: em as any })

    expect(result.contributionId).toBeTruthy()
    expect(em.inserted).toHaveLength(1)
    const inserted = em.inserted[0]
    expect(inserted.agencyId).toBe(AGENCY)
    expect(inserted.agencyMemberId).toBe(MEMBER)
    expect(inserted.githubProfile).toBe('octocat')
    expect(inserted.wicLevel).toBe('L2')
    expect(inserted.wicScore).toBe('42.5000')
    expect(inserted.archivedAt ?? null).toBeNull()
    expect(inserted.supersededById ?? null).toBeNull()

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_recorded',
      expect.objectContaining({
        contributionId: result.contributionId,
        agencyId: AGENCY,
        agencyMemberId: MEMBER,
        githubProfile: 'octocat',
        wicLevel: 'L2',
        wicScore: '42.5000',
        importBatchId: BATCH,
        rowIndex: 0,
      }),
      expect.objectContaining({ container: null }),
    )
  })

  it('persists snapshot fields (agencyId, githubProfile) verbatim from args', async () => {
    const em = new FakeEm()
    await execute({ ...buildArgs(), agencyId: 'snapshot-agency-id' as any }, { em: em as any })
    const inserted = em.inserted[0]
    expect(inserted.agencyId).toBe('snapshot-agency-id')
  })

  it('returns the namespace export RecordWicContributionCommand with execute + undo', () => {
    expect(typeof RecordWicContributionCommand.execute).toBe('function')
    expect(typeof RecordWicContributionCommand.undo).toBe('function')
  })
})

describe('RecordWicContributionCommand.undo', () => {
  beforeEach(() => {
    nextId = 1
    safeEmit.mockClear()
  })

  it('soft-deletes the inserted row and emits the compensation event', async () => {
    const em = new FakeEm()
    const { contributionId } = await execute(buildArgs(), { em: em as any })
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, contributionId },
      { em: em as any },
    )
    expect(result).not.toBeNull()
    expect(result!.alreadyArchived).toBe(false)
    expect(result!.archivedAt).toBeTruthy()

    const row = em.contributions.find((c) => c.id === contributionId)
    expect(row?.archivedAt).toBeInstanceOf(Date)

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_recorded.undone',
      expect.objectContaining({
        contributionId,
        agencyId: AGENCY,
        agencyMemberId: MEMBER,
        alreadyArchived: false,
      }),
      expect.objectContaining({ container: null }),
    )
  })

  it('is idempotent — second undo still emits compensation event but does not re-archive', async () => {
    const em = new FakeEm()
    const { contributionId } = await execute(buildArgs(), { em: em as any })

    const first = await undo(
      { tenantId: TENANT, organizationId: ORG, contributionId },
      { em: em as any },
    )
    const firstArchivedAt = (em.contributions.find((c) => c.id === contributionId) as any)
      .archivedAt
    safeEmit.mockClear()

    const second = await undo(
      { tenantId: TENANT, organizationId: ORG, contributionId },
      { em: em as any },
    )
    expect(first!.alreadyArchived).toBe(false)
    expect(second!.alreadyArchived).toBe(true)

    // archivedAt is the SAME timestamp — undo did not overwrite it on the second call.
    const row = em.contributions.find((c) => c.id === contributionId) as any
    expect(row.archivedAt).toBe(firstArchivedAt)

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic.contribution_recorded.undone',
      expect.objectContaining({ contributionId, alreadyArchived: true }),
      expect.objectContaining({ container: null }),
    )
  })

  it('returns null when the contribution is not found', async () => {
    const em = new FakeEm()
    const result = await undo(
      {
        tenantId: TENANT,
        organizationId: ORG,
        contributionId: '99999999-9999-4999-8999-999999999999',
      },
      { em: em as any },
    )
    expect(result).toBeNull()
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('respects tenant scoping — undo of a cross-tenant id returns null', async () => {
    const em = new FakeEm()
    const { contributionId } = await execute(buildArgs(), { em: em as any })
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: 'OTHER-TENANT', organizationId: ORG, contributionId },
      { em: em as any },
    )
    expect(result).toBeNull()
    expect(safeEmit).not.toHaveBeenCalled()
  })
})

// Touch import so tree-shaker keeps the entity reference for type safety.
const _GUARD: typeof WicContribution = WicContribution
void _GUARD
