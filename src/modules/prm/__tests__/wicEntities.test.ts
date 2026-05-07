import {
  ServiceIdempotencyKey,
  WicContribution,
  WicImportAuditLog,
} from '../data/entities'

/**
 * Phase 1 smoke — verifies the WIC ingestion entity classes load and can be instantiated.
 * The schema migration depends on these being importable; if this regresses, `db generate`
 * cannot diff against the entity model.
 *
 * Deeper schema invariants (column types, NOT NULL, defaults, FKs, partial-unique index)
 * are exercised end-to-end by the §9 IT-1 happy-path Playwright spec
 * (`.ai/qa/tests/integration/TC-PRM-T3-001-*`) once Phase 4 lands.
 */
describe('WIC ingestion entities (Spec #4 Phase 1)', () => {
  it('WicContribution class is constructable and shapes match', () => {
    const row = new WicContribution()
    row.id = '00000000-0000-0000-0000-000000000000'
    row.tenantId = '00000000-0000-0000-0000-000000000001'
    row.organizationId = '00000000-0000-0000-0000-000000000002'
    row.agencyId = '00000000-0000-0000-0000-000000000003'
    row.agencyMemberId = '00000000-0000-0000-0000-000000000004'
    row.githubProfile = 'octocat'
    row.contributionMonth = new Date('2026-03-01T00:00:00Z')
    row.wicScore = '42.5'
    row.scriptVersion = '1.0-agent'
    row.importBatchId = '00000000-0000-0000-0000-000000000005'
    row.rowIndex = 0
    row.computedAt = new Date()

    expect(row).toBeInstanceOf(WicContribution)
    expect(row.contributionCount).toBe(0)
    expect(row.bountyBonus).toBe('0')
    expect(row.supersededById ?? null).toBeNull()
    expect(row.archivedAt ?? null).toBeNull()
  })

  it('WicImportAuditLog class is constructable with required fields', () => {
    const row = new WicImportAuditLog()
    row.id = '00000000-0000-0000-0000-000000000000'
    row.tenantId = '00000000-0000-0000-0000-000000000001'
    row.organizationId = '00000000-0000-0000-0000-000000000002'
    row.importBatchId = '00000000-0000-0000-0000-000000000003'
    row.rowIndex = 7
    row.rawPayload = { github_profile: 'ghost-user', wic_level: 'L2' }
    row.rejectionReason = 'unknown_github_profile'
    row.scriptVersion = '1.0-agent'
    row.month = '2026-03'

    expect(row).toBeInstanceOf(WicImportAuditLog)
    expect(row.resolvedAt ?? null).toBeNull()
    expect(row.resolutionAction ?? null).toBeNull()
    expect(row.rawPayload).toMatchObject({ github_profile: 'ghost-user' })
  })

  it('ServiceIdempotencyKey class is constructable with composite-key fields', () => {
    const row = new ServiceIdempotencyKey()
    row.endpoint = 'POST /api/prm/service/wic/imports/:batchId'
    row.idempotencyKey = '00000000-0000-0000-0000-000000000000'
    row.tenantId = '00000000-0000-0000-0000-000000000001'
    row.organizationId = '00000000-0000-0000-0000-000000000002'
    row.payloadHash = 'sha256:deadbeef'
    row.responseHash = 'sha256:cafebabe'
    row.responseStatus = 200
    row.responseBody = { import_batch_id: 'abc', accepted_count: 3 }

    expect(row).toBeInstanceOf(ServiceIdempotencyKey)
    expect(row.responseStatus).toBe(200)
    expect(row.responseBody).toMatchObject({ accepted_count: 3 })
  })
})
