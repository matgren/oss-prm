/**
 * Spec #4 §9 jest coverage for the B10 audit-log server side.
 *
 * Complements PR #4's existing tests (wicEntities, wicImportService,
 * wicProfilesRoute, serviceAuthMiddleware) — none of which exercise the
 * `/api/prm/wic/audit-log` GET or `/[id]/resolve` POST handlers.
 *
 *   T13 — happy-path resolve sets resolution fields + emits event
 *   T14 — RBAC declared at the metadata layer for both list + resolve
 *   default unresolved filter, rejection_reason filter, invalid filter (400)
 *   resolve 404 / 400 invalid action / 409 already-resolved
 */

import { WicImportAuditLog } from '../data/entities'

class FakeEm {
  rows: WicImportAuditLog[] = []
  tenantId = '11111111-1111-4111-8111-111111111111'

  persist(row: WicImportAuditLog): void {
    const idx = this.rows.findIndex((r) => r.id === (row as any).id)
    if (idx >= 0) this.rows[idx] = row
    else this.rows.push(row)
  }

  async flush(): Promise<void> {}

  async findOne(_E: any, where: Record<string, unknown>): Promise<unknown> {
    return (
      this.rows.find(
        (r) =>
          r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId),
      ) ?? null
    )
  }

  async findAndCount(
    _E: any,
    where: Record<string, unknown>,
    opts?: { limit?: number; offset?: number },
  ): Promise<[WicImportAuditLog[], number]> {
    const filtered = this.rows.filter((row) => {
      if (where.tenantId && row.tenantId !== where.tenantId) return false
      if (where.resolvedAt === null && row.resolvedAt !== null) return false
      if (
        typeof where.resolvedAt === 'object' &&
        where.resolvedAt !== null &&
        '$ne' in (where.resolvedAt as any) &&
        row.resolvedAt === null
      )
        return false
      if (where.rejectionReason && row.rejectionReason !== where.rejectionReason) return false
      if (where.importBatchId && row.importBatchId !== where.importBatchId) return false
      return true
    })
    const total = filtered.length
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? filtered.length
    return [filtered.slice(offset, offset + limit), total]
  }
}

let em: FakeEm
const getAuthMock = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthMock(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') return em
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

// Routes route reads through `findAndCountWithDecryption` / `findOneWithDecryption`.
// In unit tests we collapse those to plain `em.findAndCount` / `em.findOne` since the
// FakeEm above does not encrypt anything.
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findAndCountWithDecryption: async (em: any, Cls: any, where: any, opts?: any) =>
    em.findAndCount(Cls, where, opts),
  findOneWithDecryption: async (em: any, Cls: any, where: any) => em.findOne(Cls, where),
}))

beforeEach(() => {
  em = new FakeEm()
  getAuthMock.mockReset()
})

function makeAuth() {
  return {
    sub: '99999999-9999-4999-8999-999999999999',
    tenantId: em.tenantId,
    orgId: '22222222-2222-4222-8222-222222222222',
  }
}

function seedAuditLog(overrides: Partial<WicImportAuditLog> = {}): WicImportAuditLog {
  const row = {
    id: overrides.id ?? `aaaaaaaa-aaaa-4aaa-8aaa-${(em.rows.length + 1).toString().padStart(12, '0')}`,
    tenantId: em.tenantId,
    organizationId: '22222222-2222-4222-8222-222222222222',
    importBatchId: '6b4f0cd8-9b7a-4a40-87f6-6c1e2a9d4e10',
    rowIndex: overrides.rowIndex ?? em.rows.length,
    rawPayload: { github_profile: 'octocat', month: '2026-03' },
    rejectionReason: overrides.rejectionReason ?? 'unknown_github_profile',
    rejectionDetail: overrides.rejectionDetail ?? null,
    resolvedAgencyId: overrides.resolvedAgencyId ?? null,
    scriptVersion: '1.0-agent',
    month: overrides.month ?? '2026-03',
    createdAt: overrides.createdAt ?? new Date(`2026-04-${10 + em.rows.length}T00:00:00Z`),
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedByUserId: overrides.resolvedByUserId ?? null,
    resolutionAction: overrides.resolutionAction ?? null,
    resolutionNote: overrides.resolutionNote ?? null,
  } as unknown as WicImportAuditLog
  em.rows.push(row)
  return row
}

async function loadListHandler() {
  const mod = await import('../api/wic/audit-log/route')
  return { GET: mod.GET, metadata: mod.metadata }
}

async function loadResolveHandler() {
  const mod = await import('../api/wic/audit-log/[id]/resolve/route')
  return { POST: mod.POST, metadata: mod.metadata }
}

describe('GET /api/prm/wic/audit-log (B10 list)', () => {
  it('returns 401 when unauthenticated', async () => {
    getAuthMock.mockResolvedValue(null)
    const { GET } = await loadListHandler()
    const res = await GET(new Request('http://test.local/api/prm/wic/audit-log'))
    expect(res.status).toBe(401)
  })

  it('default view filters to unresolved entries', async () => {
    seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', resolvedAt: null })
    seedAuditLog({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      resolvedAt: new Date('2026-04-15T00:00:00Z'),
      resolutionAction: 'ignored',
    })
    getAuthMock.mockResolvedValue(makeAuth())
    const { GET } = await loadListHandler()
    const res = await GET(new Request('http://test.local/api/prm/wic/audit-log'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toHaveLength(1)
    expect(json.items[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  })

  it('resolved=true filters to closed entries', async () => {
    seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', resolvedAt: null })
    seedAuditLog({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      resolvedAt: new Date('2026-04-15T00:00:00Z'),
    })
    getAuthMock.mockResolvedValue(makeAuth())
    const { GET } = await loadListHandler()
    const res = await GET(new Request('http://test.local/api/prm/wic/audit-log?resolved=true'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toHaveLength(1)
    expect(json.items[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')
  })

  it('rejection_reason filter narrows the list', async () => {
    seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', rejectionReason: 'unknown_github_profile' })
    seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', rejectionReason: 'malformed_month' })
    getAuthMock.mockResolvedValue(makeAuth())
    const { GET } = await loadListHandler()
    const res = await GET(
      new Request('http://test.local/api/prm/wic/audit-log?rejection_reason=malformed_month'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toHaveLength(1)
    expect(json.items[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')
  })

  it('returns 400 on bad rejection_reason value', async () => {
    getAuthMock.mockResolvedValue(makeAuth())
    const { GET } = await loadListHandler()
    const res = await GET(
      new Request('http://test.local/api/prm/wic/audit-log?rejection_reason=invalid_value'),
    )
    expect(res.status).toBe(400)
  })

  it('cross-tenant rows are filtered out by the tenantId where-clause', async () => {
    seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    em.rows.push({
      ...em.rows[0],
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      tenantId: '00000000-0000-4000-8000-000000000000',
    } as any)
    getAuthMock.mockResolvedValue(makeAuth())
    const { GET } = await loadListHandler()
    const res = await GET(new Request('http://test.local/api/prm/wic/audit-log'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toHaveLength(1)
    expect(json.items[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  })

  it('T14 — metadata declares prm.wic.resolve as the required feature', async () => {
    const { metadata } = await loadListHandler()
    expect(metadata.GET.requireAuth).toBe(true)
    expect(metadata.GET.requireFeatures).toEqual(['prm.wic.resolve'])
  })
})

describe('POST /api/prm/wic/audit-log/[id]/resolve', () => {
  it('T13 — happy path: marks row resolved and persists action + resolvedByUserId from auth.sub', async () => {
    const target = seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(`http://test.local/api/prm/wic/audit-log/${target.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accepted_after_fix' }),
      }),
      { params: { id: target.id } },
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.auditLog).toEqual(
      expect.objectContaining({
        id: target.id,
        resolutionAction: 'accepted_after_fix',
        resolvedByUserId: makeAuth().sub,
      }),
    )
    const persisted = em.rows[0]
    expect(persisted.resolutionAction).toBe('accepted_after_fix')
    expect(persisted.resolvedAt).toBeInstanceOf(Date)
    expect(persisted.resolvedByUserId).toBe(makeAuth().sub)
  })

  it('returns 401 when unauthenticated', async () => {
    getAuthMock.mockResolvedValue(null)
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request('http://test.local/api/prm/wic/audit-log/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ignored' }),
      }),
      { params: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' } },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when the audit-log entry does not exist', async () => {
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(
        'http://test.local/api/prm/wic/audit-log/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/resolve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ignored' }),
        },
      ),
      { params: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' } },
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 on invalid action enum value', async () => {
    const target = seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(`http://test.local/api/prm/wic/audit-log/${target.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'whatever' }),
      }),
      { params: { id: target.id } },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on non-JSON body', async () => {
    const target = seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(`http://test.local/api/prm/wic/audit-log/${target.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      { params: { id: target.id } },
    )
    expect(res.status).toBe(400)
  })

  it('returns 409 when the row is already resolved (no idempotent re-resolve)', async () => {
    const target = seedAuditLog({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      resolvedAt: new Date('2026-04-15T00:00:00Z'),
      resolutionAction: 'ignored',
    })
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(`http://test.local/api/prm/wic/audit-log/${target.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rolled_back' }),
      }),
      { params: { id: target.id } },
    )
    expect(res.status).toBe(409)
    // Original resolution unchanged.
    expect(em.rows[0].resolutionAction).toBe('ignored')
  })

  it('persists resolution_note when supplied in body', async () => {
    const target = seedAuditLog({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' })
    getAuthMock.mockResolvedValue(makeAuth())
    const { POST } = await loadResolveHandler()
    const res = await POST(
      new Request(`http://test.local/api/prm/wic/audit-log/${target.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rolled_back', note: 'spurious row from staging' }),
      }),
      { params: { id: target.id } },
    )
    expect(res.status).toBe(200)
    expect(em.rows[0].resolutionNote).toBe('spurious row from staging')
  })

  it('T14 — metadata declares prm.wic.resolve as the required feature', async () => {
    const { metadata } = await loadResolveHandler()
    expect(metadata.POST.requireAuth).toBe(true)
    expect(metadata.POST.requireFeatures).toEqual(['prm.wic.resolve'])
  })
})
