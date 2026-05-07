/**
 * Spec #4 §4.1 — `ResolveWicImportAuditLogCommand` (undoable).
 *
 *   - execute happy path: 4 fields written + `prm.wic_import.resolved` emitted.
 *   - execute on missing row → `WicAuditLogNotFoundError`.
 *   - execute on already-resolved row → `WicAuditLogAlreadyResolvedError` (handler maps to 409).
 *   - undo happy path: 4 fields cleared + `prm.wic_import.resolved.undone` emitted.
 *   - undo idempotency: second undo is a no-op + still re-emits compensation event.
 *   - undo on missing row → null.
 *   - tenant scoping: cross-tenant id returns null on undo, throws not-found on execute.
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
  undo,
  ResolveWicImportAuditLogCommand,
  WicAuditLogAlreadyResolvedError,
  WicAuditLogNotFoundError,
} from '../commands/wic/resolveWicImportAuditLog'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const USER = '99999999-9999-4999-8999-999999999999'

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

function seedAuditLog(em: FakeEm, id: string, overrides: Record<string, any> = {}): any {
  const row = {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    importBatchId: 'batch-1',
    rowIndex: 0,
    rawPayload: { github_profile: 'octocat' },
    rejectionReason: 'unknown_github_profile',
    rejectionDetail: null,
    resolvedAgencyId: null,
    scriptVersion: '1.0-test',
    month: '2026-03',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionAction: null,
    resolutionNote: null,
    ...overrides,
  }
  em.rows.push(row)
  return row
}

describe('ResolveWicImportAuditLogCommand.execute', () => {
  beforeEach(() => safeEmit.mockClear())

  it('writes the four resolution fields and emits prm.wic_import.resolved', async () => {
    const em = new FakeEm()
    const row = seedAuditLog(em, 'audit-1')
    const result = await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        auditLogId: 'audit-1',
        action: 'accepted_after_fix',
        resolvedByUserId: USER,
        note: 'fixed by hand',
      },
      { em: em as any },
    )
    expect(row.resolvedAt).toBeInstanceOf(Date)
    expect(row.resolutionAction).toBe('accepted_after_fix')
    expect(row.resolvedByUserId).toBe(USER)
    expect(row.resolutionNote).toBe('fixed by hand')

    expect(result.auditLogId).toBe('audit-1')
    expect(result.resolutionAction).toBe('accepted_after_fix')

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic_import.resolved',
      expect.objectContaining({
        auditLogId: 'audit-1',
        action: 'accepted_after_fix',
        resolvedByUserId: USER,
      }),
      expect.objectContaining({ container: null }),
    )
  })

  it('throws WicAuditLogNotFoundError on missing id', async () => {
    const em = new FakeEm()
    await expect(
      execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          auditLogId: 'missing',
          action: 'ignored',
          resolvedByUserId: USER,
        },
        { em: em as any },
      ),
    ).rejects.toBeInstanceOf(WicAuditLogNotFoundError)
  })

  it('throws WicAuditLogAlreadyResolvedError on a row that is already resolved', async () => {
    const em = new FakeEm()
    seedAuditLog(em, 'audit-1', {
      resolvedAt: new Date('2026-04-15T00:00:00Z'),
      resolutionAction: 'rolled_back',
      resolvedByUserId: USER,
    })
    await expect(
      execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          auditLogId: 'audit-1',
          action: 'accepted_after_fix',
          resolvedByUserId: USER,
        },
        { em: em as any },
      ),
    ).rejects.toBeInstanceOf(WicAuditLogAlreadyResolvedError)
  })

  it('throws WicAuditLogNotFoundError when the row exists in another tenant', async () => {
    const em = new FakeEm()
    seedAuditLog(em, 'audit-cross', { tenantId: 'OTHER-TENANT' })
    await expect(
      execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          auditLogId: 'audit-cross',
          action: 'ignored',
          resolvedByUserId: USER,
        },
        { em: em as any },
      ),
    ).rejects.toBeInstanceOf(WicAuditLogNotFoundError)
  })

  it('honours null/undefined note (writes null)', async () => {
    const em = new FakeEm()
    const row = seedAuditLog(em, 'audit-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        auditLogId: 'audit-1',
        action: 'ignored',
        resolvedByUserId: USER,
      },
      { em: em as any },
    )
    expect(row.resolutionNote).toBeNull()
  })
})

describe('ResolveWicImportAuditLogCommand.undo', () => {
  beforeEach(() => safeEmit.mockClear())

  it('clears the four resolution fields and emits the compensation event', async () => {
    const em = new FakeEm()
    const row = seedAuditLog(em, 'audit-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        auditLogId: 'audit-1',
        action: 'rolled_back',
        resolvedByUserId: USER,
        note: 'rollback note',
      },
      { em: em as any },
    )
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, auditLogId: 'audit-1' },
      { em: em as any },
    )
    expect(row.resolvedAt).toBeNull()
    expect(row.resolutionAction).toBeNull()
    expect(row.resolvedByUserId).toBeNull()
    expect(row.resolutionNote).toBeNull()

    expect(result?.alreadyUnresolved).toBe(false)
    expect(result?.clearedAction).toBe('rolled_back')
    expect(result?.clearedResolvedByUserId).toBe(USER)

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic_import.resolved.undone',
      expect.objectContaining({
        auditLogId: 'audit-1',
        clearedAction: 'rolled_back',
        clearedResolvedByUserId: USER,
        alreadyUnresolved: false,
      }),
      expect.any(Object),
    )
  })

  it('is idempotent — second undo still emits compensation event but does not re-write fields', async () => {
    const em = new FakeEm()
    seedAuditLog(em, 'audit-1')
    await execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        auditLogId: 'audit-1',
        action: 'accepted_after_fix',
        resolvedByUserId: USER,
      },
      { em: em as any },
    )
    await undo(
      { tenantId: TENANT, organizationId: ORG, auditLogId: 'audit-1' },
      { em: em as any },
    )
    safeEmit.mockClear()

    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, auditLogId: 'audit-1' },
      { em: em as any },
    )
    expect(result?.alreadyUnresolved).toBe(true)
    expect(result?.clearedAction).toBeNull()

    expect(safeEmit).toHaveBeenCalledWith(
      'prm.wic_import.resolved.undone',
      expect.objectContaining({
        auditLogId: 'audit-1',
        alreadyUnresolved: true,
      }),
      expect.any(Object),
    )
  })

  it('returns null on missing id', async () => {
    const em = new FakeEm()
    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, auditLogId: 'missing' },
      { em: em as any },
    )
    expect(result).toBeNull()
    expect(safeEmit).not.toHaveBeenCalled()
  })

  it('respects tenant scoping — undo of cross-tenant id returns null', async () => {
    const em = new FakeEm()
    seedAuditLog(em, 'audit-cross', { tenantId: 'OTHER-TENANT' })
    const result = await undo(
      { tenantId: TENANT, organizationId: ORG, auditLogId: 'audit-cross' },
      { em: em as any },
    )
    expect(result).toBeNull()
  })
})

it('exposes ResolveWicImportAuditLogCommand namespace + sentinel error classes', () => {
  expect(typeof ResolveWicImportAuditLogCommand.execute).toBe('function')
  expect(typeof ResolveWicImportAuditLogCommand.undo).toBe('function')
  expect(WicAuditLogNotFoundError.prototype).toBeInstanceOf(Error)
  expect(WicAuditLogAlreadyResolvedError.prototype).toBeInstanceOf(Error)
})
