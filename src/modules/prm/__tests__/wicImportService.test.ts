import { processWicBatch, processWicRow } from '../lib/wicImportService'
import type { AgencyMember, WicContribution, WicImportAuditLog } from '../data/entities'

let nextId = 1
function uuid(): string {
  return `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`
}

class FakeEm {
  members: Partial<AgencyMember>[] = []
  activeContributions: Partial<WicContribution>[] = []
  inserted: Array<{ kind: 'WicContribution' | 'WicImportAuditLog'; row: any }> = []

  async find(cls: unknown, where: any) {
    if ((cls as { name?: string })?.name === 'AgencyMember') {
      return this.members.filter((m) => {
        if (where.tenantId && (m as any).tenantId && (m as any).tenantId !== where.tenantId) return false
        if (where.githubProfile && m.githubProfile !== where.githubProfile) return false
        if (where.isActive !== undefined && m.isActive !== where.isActive) return false
        if (where.deletedAt === null && m.deletedAt) return false
        return true
      })
    }
    return []
  }

  async findOne(cls: unknown, where: any) {
    if ((cls as { name?: string })?.name === 'WicContribution') {
      return (
        this.activeContributions.find(
          (c) =>
            (where.tenantId === undefined ||
              (c as any).tenantId === undefined ||
              (c as any).tenantId === where.tenantId) &&
            c.agencyMemberId === where.agencyMemberId &&
            c.contributionMonth?.getTime() === where.contributionMonth?.getTime() &&
            !c.supersededById &&
            !c.archivedAt,
        ) ?? null
      )
    }
    return null
  }

  create(cls: any, data: any) {
    const kind = cls?.name as 'WicContribution' | 'WicImportAuditLog'
    const created = { ...data, id: data.id ?? uuid() }
    if (kind === 'WicContribution') {
      // Mark as active so subsequent processWicRow calls can find it as the previous active row.
      this.activeContributions.push(created)
    }
    this.inserted.push({ kind, row: created })
    return created
  }

  persist(_row: any) {
    return this
  }

  async flush() {
    /* no-op */
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111'
const ORG = '22222222-2222-2222-2222-222222222222'
const BATCH = '33333333-3333-3333-3333-333333333333'

const VALID_ROW = {
  row_index: 0,
  github_profile: 'octocat',
  person_display_name: 'Octo Cat',
  contribution_month: '2026-03-01',
  wic_level: 'L2',
  wic_score: 42.5,
  contribution_count: 7,
  bounty_bonus: 10,
  why_bonus: 'landed PR #1234',
  what_included: 'pull requests',
  what_excluded: 'reviews',
  computed_at: '2026-04-02T08:30:00Z',
}

const ctx = {
  importBatchId: BATCH,
  envelopeMonth: '2026-03',
  scriptVersion: '1.0-agent',
  tenantId: TENANT,
  organizationId: ORG,
}

describe('WIC ACL — processWicRow (Spec #4 §1.4.6)', () => {
  beforeEach(() => {
    nextId = 1
  })

  it('T1 (happy) — accepts a well-formed row that resolves to an active member', async () => {
    const em = new FakeEm()
    em.members.push({
      id: 'm1',
      agencyId: 'a1',
      githubProfile: 'octocat',
      isActive: true,
      deletedAt: null,
    })
    const result = await processWicRow(em as any, ctx, VALID_ROW, 0)
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') return
    expect(result.contributionId).toBeTruthy()
    const insertedContribution = em.inserted.find((i) => i.kind === 'WicContribution')
    expect(insertedContribution?.row.agencyId).toBe('a1') // SNAPSHOT — invariant #13
    expect(insertedContribution?.row.githubProfile).toBe('octocat')
    expect(insertedContribution?.row.wicLevel).toBe('L2')
  })

  it('T2 (malformed_month) — non-first-of-month is rejected with rejection_reason=malformed_month', async () => {
    const em = new FakeEm()
    em.members.push({ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null })
    const row = { ...VALID_ROW, contribution_month: '2026-03-15' }
    const result = await processWicRow(em as any, ctx, row, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('malformed_month')
    expect(em.inserted.find((i) => i.kind === 'WicContribution')).toBeUndefined()
  })

  it('T3 (unknown_github_profile) — unresolvable github_profile lands in audit log', async () => {
    const em = new FakeEm() // no members
    const result = await processWicRow(em as any, ctx, VALID_ROW, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('unknown_github_profile')
  })

  it('T4 (supersession) — re-import of same (member, month) supersedes the previous active row', async () => {
    const em = new FakeEm()
    em.members.push({ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null })
    em.activeContributions.push({
      id: 'prev-id',
      agencyMemberId: 'm1',
      agencyId: 'a1',
      contributionMonth: new Date('2026-03-01T00:00:00Z'),
      supersededById: null,
      archivedAt: null,
    })

    const row = { ...VALID_ROW, wic_score: 50 }
    const result = await processWicRow(em as any, ctx, row, 0)
    expect(result.status).toBe('superseded')
    if (result.status !== 'superseded') return
    expect(result.previousContributionId).toBe('prev-id')
    expect(result.contributionId).toBeTruthy()

    // Previous row should now have supersededById + archivedAt set.
    const prev = em.activeContributions.find((c) => c.id === 'prev-id')
    expect(prev?.supersededById).toBe(result.contributionId)
    expect(prev?.archivedAt).toBeInstanceOf(Date)
  })

  it('T (unknown_level) — unknown wic_level is rejected', async () => {
    const em = new FakeEm()
    em.members.push({ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null })
    const row = { ...VALID_ROW, wic_level: 'L5' }
    const result = await processWicRow(em as any, ctx, row, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('unknown_level')
  })

  it('envelope-month mismatch — row month differs from envelope month → malformed_month', async () => {
    const em = new FakeEm()
    em.members.push({ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null })
    const row = { ...VALID_ROW, contribution_month: '2026-04-01' }
    const result = await processWicRow(em as any, { ...ctx, envelopeMonth: '2026-03' }, row, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('malformed_month')
  })

  it('invalid_payload — missing required fields → rejection_reason=invalid_payload', async () => {
    const em = new FakeEm()
    em.members.push({ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null })
    const row = { row_index: 0, github_profile: 'octocat' } // missing many required fields
    const result = await processWicRow(em as any, ctx, row, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('invalid_payload')
  })

  it('tenant isolation — github_profile in another tenant is NOT resolved (rejected as unknown)', async () => {
    const em = new FakeEm()
    // Member in a different tenant carries the same github_profile.
    em.members.push({
      id: 'cross-tenant-m1',
      agencyId: 'cross-tenant-a1',
      githubProfile: 'octocat',
      isActive: true,
      deletedAt: null,
      tenantId: 'OTHER-TENANT',
    } as any)
    const result = await processWicRow(em as any, ctx, VALID_ROW, 0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') return
    expect(result.rejectionReason).toBe('unknown_github_profile')
    // Crucially, NO contribution row written.
    expect(em.inserted.find((i) => i.kind === 'WicContribution')).toBeUndefined()
  })

  it('snapshot — agency_id + github_profile come from resolved member regardless of payload mismatch', async () => {
    const em = new FakeEm()
    em.members.push({
      id: 'm1',
      agencyId: 'snapshot-agency',
      githubProfile: 'octocat',
      isActive: true,
      deletedAt: null,
    })
    const result = await processWicRow(em as any, ctx, VALID_ROW, 0)
    expect(result.status).toBe('accepted')
    const inserted = em.inserted.find((i) => i.kind === 'WicContribution')
    expect(inserted?.row.agencyId).toBe('snapshot-agency') // From resolved member, not from payload.
  })
})

describe('WIC batch — per-row commit semantics (Spec §3.3 R2)', () => {
  it('row N+1 failure does NOT roll back rows 0..N (per-row commit + UNIQUE replay design)', async () => {
    // Setup: a happy row 0 + a row 1 that will throw mid-flush.
    const em = new FakeEm()
    em.members.push({
      id: 'member-1',
      tenantId: TENANT,
      githubProfile: 'octocat',
      agencyId: 'agency-1',
      isActive: true,
      deletedAt: null,
    } as any)

    let flushCalls = 0
    const originalFlush = em.flush.bind(em)
    em.flush = async function () {
      flushCalls += 1
      if (flushCalls === 2) {
        // Simulate a database failure on the second flush (row 1).
        throw new Error('simulated DB connection drop on row 1')
      }
      return originalFlush()
    }

    const rows = [
      { ...VALID_ROW, row_index: 0, github_profile: 'octocat' },
      { ...VALID_ROW, row_index: 1, github_profile: 'octocat' }, // would supersede row 0
    ]

    let caughtError: unknown = null
    try {
      await processWicBatch(em as any, {
        importBatchId: BATCH,
        envelopeMonth: '2026-03',
        scriptVersion: '1.0-test',
        rawRows: rows,
        tenantId: TENANT,
        organizationId: ORG,
      })
    } catch (err) {
      caughtError = err
    }

    // Row 0 succeeded BEFORE row 1's failure — and stays committed.
    expect(caughtError).toBeTruthy()
    const contributions = em.inserted.filter((i) => i.kind === 'WicContribution')
    expect(contributions.length).toBeGreaterThanOrEqual(1)
    expect(contributions[0].row.rowIndex).toBe(0)
    expect(contributions[0].row.importBatchId).toBe(BATCH)
    // Row 0's audit-log assertion would also hold; the key invariant is "earlier rows
    // are NOT rolled back". Retry with the same import_batch_id is a no-op on row 0
    // (UNIQUE (import_batch_id, row_index)) and resumes at row 1.
  })
})
