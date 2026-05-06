import type { EntityManager } from '@mikro-orm/postgresql'
import { AgencyMember, WicContribution, WicImportAuditLog } from '../data/entities'
import {
  isFirstOfMonth,
  monthFromDate,
  WIC_LEVELS,
  wicImportRowSchema,
  type WicImportRow,
  type WicLevel,
  type WicRejectionReason,
} from '../data/validators'
import type { PrmEventId } from '../events'
import { safeEmit } from './safeEmit'

type ContainerLike = { resolve?: <T = unknown>(name: string) => T }

/** Container-bound emit helper — keeps call sites tidy and matches existing PRM patterns. */
function emitWithContainer(
  container: ContainerLike | null | undefined,
  eventId: PrmEventId,
  payload: Record<string, unknown>,
): Promise<void> {
  return safeEmit(eventId, payload, { container: container ?? null })
}

/**
 * WIC ingest service (Spec #4 §1.4.6 + §4).
 *
 * Owns the Anti-Corruption Layer that converts raw n8n payloads into PRM
 * `WicContribution` rows. Per-row failures are recorded in `WicImportAuditLog`
 * with the appropriate `rejection_reason`; the batch as a whole still commits
 * (per-row transactionality is the whole point of the ACL).
 *
 * Invariants enforced here:
 *   - #3 (idempotent supersession): `(agency_member_id, contribution_month)` resolves to
 *     a single active row. Re-import flips the previous row's `superseded_by_id` +
 *     `archived_at` and inserts a new active row. Partial-unique index in the schema is
 *     the defence-in-depth.
 *   - #13 (snapshot agency_id + github_profile): both columns are written from the
 *     resolved `AgencyMember` AT IMPORT TIME and never updated afterwards.
 *
 * Out of scope here:
 *   - Service-identity auth (lives in `serviceAuthMiddleware.ts`).
 *   - Idempotency replay (also middleware).
 *   - Envelope-level Zod (route handler does this; envelope failures are 422s).
 *
 * Spec deviation from §4.1 "undoable" command pattern: v1 wraps the batch in a single
 * transaction at the route layer. If the txn rolls back, no rows persist — equivalent
 * to executing `undo()` on every recorded contribution. The aspirational
 * `RecordWicContributionCommand.undo` for selective abort-recovery is deferred to v2.
 */

export type WicAcceptedRow = {
  status: 'accepted'
  rowIndex: number
  contributionId: string
}

export type WicRejectedRow = {
  status: 'rejected'
  rowIndex: number
  auditLogId: string
  rejectionReason: WicRejectionReason
  rejectionDetail: string | null
}

export type WicSupersededRow = {
  status: 'superseded'
  rowIndex: number
  contributionId: string
  previousContributionId: string
}

export type WicProcessedRow = WicAcceptedRow | WicRejectedRow | WicSupersededRow

export type WicProcessBatchInput = {
  importBatchId: string
  envelopeMonth: string // YYYY-MM
  scriptVersion: string
  rawRows: unknown[]
  tenantId: string
  organizationId: string
}

export type WicProcessBatchResult = {
  importBatchId: string
  acceptedCount: number
  rejectedCount: number
  supersededCount: number
  rows: WicProcessedRow[]
}

type ResolvedMember = {
  id: string
  agencyId: string
  githubProfile: string
}

async function resolveMemberByGithub(
  em: EntityManager,
  githubProfile: string,
): Promise<{ status: 'unique'; member: ResolvedMember } | { status: 'none' } | { status: 'ambiguous' }> {
  const matches = await em.find(AgencyMember, {
    githubProfile,
    isActive: true,
    deletedAt: null,
  } as any)
  if (matches.length === 0) return { status: 'none' }
  if (matches.length > 1) return { status: 'ambiguous' }
  const m = matches[0]!
  if (!m.githubProfile) return { status: 'none' }
  return { status: 'unique', member: { id: m.id, agencyId: m.agencyId, githubProfile: m.githubProfile } }
}

async function findActiveContribution(
  em: EntityManager,
  agencyMemberId: string,
  contributionMonth: Date,
): Promise<WicContribution | null> {
  return em.findOne(WicContribution, {
    agencyMemberId,
    contributionMonth,
    supersededById: null,
    archivedAt: null,
  } as any)
}

function buildAuditLogFromRaw(
  em: EntityManager,
  args: {
    importBatchId: string
    rowIndex: number
    rawPayload: Record<string, unknown>
    rejectionReason: WicRejectionReason
    rejectionDetail: string | null
    resolvedAgencyId: string | null
    scriptVersion: string
    month: string
    tenantId: string
    organizationId: string
  },
): WicImportAuditLog {
  const row = em.create(WicImportAuditLog, {
    importBatchId: args.importBatchId,
    rowIndex: args.rowIndex,
    rawPayload: args.rawPayload,
    rejectionReason: args.rejectionReason,
    rejectionDetail: args.rejectionDetail,
    resolvedAgencyId: args.resolvedAgencyId,
    scriptVersion: args.scriptVersion,
    month: args.month,
    tenantId: args.tenantId,
    organizationId: args.organizationId,
    createdAt: new Date(),
  } as any)
  em.persist(row)
  return row
}

/**
 * Run the ACL pipeline for a single row. Caller is responsible for `em.flush()`-ing
 * the resulting INSERTs (one per call) inside the batch txn.
 *
 * Return `WicProcessedRow` so the route handler can build the response payload.
 *
 * Side effects:
 *   - Persists exactly one of: a new `WicContribution`, a `WicImportAuditLog`, OR
 *     (for supersession) a new `WicContribution` AND a status flip on the previous row.
 *   - Emits domain events via `safeEmit` (best-effort — never blocks the import on
 *     event-bus failure).
 */
export async function processWicRow(
  em: EntityManager,
  ctx: {
    importBatchId: string
    envelopeMonth: string
    scriptVersion: string
    tenantId: string
    organizationId: string
    container?: { resolve?: <T = unknown>(name: string) => T }
  },
  rawRow: unknown,
  rawIndex: number,
): Promise<WicProcessedRow> {
  const rawPayload = (typeof rawRow === 'object' && rawRow !== null
    ? (rawRow as Record<string, unknown>)
    : { _row: String(rawRow) }) as Record<string, unknown>

  // Row-level Zod (failures = audit log, not 422 — per §3.3).
  const parsed = wicImportRowSchema.safeParse(rawRow)
  if (!parsed.success) {
    const detail = JSON.stringify(parsed.error.flatten().fieldErrors)
    const audit = buildAuditLogFromRaw(em, {
      importBatchId: ctx.importBatchId,
      rowIndex: rawIndex,
      rawPayload,
      rejectionReason: 'invalid_payload',
      rejectionDetail: detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail,
      resolvedAgencyId: null,
      scriptVersion: ctx.scriptVersion,
      month: ctx.envelopeMonth,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic_import.row_rejected', {
      importBatchId: ctx.importBatchId,
      rowIndex: rawIndex,
      rejectionReason: 'invalid_payload',
      rejectionDetail: audit.rejectionDetail ?? null,
      rawPayload,
      resolvedAgencyId: null,
    })
    return {
      status: 'rejected',
      rowIndex: rawIndex,
      auditLogId: audit.id,
      rejectionReason: 'invalid_payload',
      rejectionDetail: audit.rejectionDetail ?? null,
    }
  }
  const row: WicImportRow = parsed.data

  // First-of-month check (defence-in-depth — DB CHECK also enforces this).
  if (!isFirstOfMonth(row.contribution_month)) {
    const audit = buildAuditLogFromRaw(em, {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rawPayload,
      rejectionReason: 'malformed_month',
      rejectionDetail: `contribution_month=${row.contribution_month} is not first-of-month`,
      resolvedAgencyId: null,
      scriptVersion: ctx.scriptVersion,
      month: ctx.envelopeMonth,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic_import.row_rejected', {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rejectionReason: 'malformed_month',
      rejectionDetail: audit.rejectionDetail ?? null,
      rawPayload,
      resolvedAgencyId: null,
    })
    return {
      status: 'rejected',
      rowIndex: row.row_index,
      auditLogId: audit.id,
      rejectionReason: 'malformed_month',
      rejectionDetail: audit.rejectionDetail ?? null,
    }
  }

  // Envelope month vs row month consistency. Row's YYYY-MM must match envelope's `month`.
  const rowMonth = monthFromDate(row.contribution_month)
  if (rowMonth !== ctx.envelopeMonth) {
    const audit = buildAuditLogFromRaw(em, {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rawPayload,
      rejectionReason: 'malformed_month',
      rejectionDetail: `contribution_month=${row.contribution_month} mismatches envelope month=${ctx.envelopeMonth}`,
      resolvedAgencyId: null,
      scriptVersion: ctx.scriptVersion,
      month: ctx.envelopeMonth,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic_import.row_rejected', {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rejectionReason: 'malformed_month',
      rejectionDetail: audit.rejectionDetail ?? null,
      rawPayload,
      resolvedAgencyId: null,
    })
    return {
      status: 'rejected',
      rowIndex: row.row_index,
      auditLogId: audit.id,
      rejectionReason: 'malformed_month',
      rejectionDetail: audit.rejectionDetail ?? null,
    }
  }

  // wic_level enum check.
  if (!(WIC_LEVELS as readonly string[]).includes(row.wic_level)) {
    const audit = buildAuditLogFromRaw(em, {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rawPayload,
      rejectionReason: 'unknown_level',
      rejectionDetail: `wic_level=${row.wic_level}`,
      resolvedAgencyId: null,
      scriptVersion: ctx.scriptVersion,
      month: ctx.envelopeMonth,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic_import.row_rejected', {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rejectionReason: 'unknown_level',
      rejectionDetail: audit.rejectionDetail ?? null,
      rawPayload,
      resolvedAgencyId: null,
    })
    return {
      status: 'rejected',
      rowIndex: row.row_index,
      auditLogId: audit.id,
      rejectionReason: 'unknown_level',
      rejectionDetail: audit.rejectionDetail ?? null,
    }
  }

  // Resolve github_profile → AgencyMember.
  const resolved = await resolveMemberByGithub(em, row.github_profile)
  if (resolved.status === 'none' || resolved.status === 'ambiguous') {
    const reason: WicRejectionReason =
      resolved.status === 'ambiguous' ? 'ambiguous_github_profile' : 'unknown_github_profile'
    const audit = buildAuditLogFromRaw(em, {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rawPayload,
      rejectionReason: reason,
      rejectionDetail: `github_profile=${row.github_profile}`,
      resolvedAgencyId: null,
      scriptVersion: ctx.scriptVersion,
      month: ctx.envelopeMonth,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic_import.row_rejected', {
      importBatchId: ctx.importBatchId,
      rowIndex: row.row_index,
      rejectionReason: reason,
      rejectionDetail: audit.rejectionDetail ?? null,
      rawPayload,
      resolvedAgencyId: null,
    })
    return {
      status: 'rejected',
      rowIndex: row.row_index,
      auditLogId: audit.id,
      rejectionReason: reason,
      rejectionDetail: audit.rejectionDetail ?? null,
    }
  }

  // Snapshot the contribution.
  const contributionMonth = new Date(`${row.contribution_month}T00:00:00.000Z`)
  const previous = await findActiveContribution(em, resolved.member.id, contributionMonth)

  const newContribution = em.create(WicContribution, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    agencyId: resolved.member.agencyId, // SNAPSHOT — invariant #13
    agencyMemberId: resolved.member.id,
    githubProfile: resolved.member.githubProfile, // SNAPSHOT — invariant #13
    contributionMonth,
    wicLevel: row.wic_level as WicLevel,
    wicScore: row.wic_score.toString(),
    contributionCount: row.contribution_count,
    bountyBonus: row.bounty_bonus.toString(),
    whyBonus: row.why_bonus ?? null,
    whatIncluded: row.what_included ?? null,
    whatExcluded: row.what_excluded ?? null,
    scriptVersion: ctx.scriptVersion,
    importBatchId: ctx.importBatchId,
    rowIndex: row.row_index,
    computedAt: new Date(row.computed_at),
    importedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any)
  em.persist(newContribution)

  if (previous) {
    previous.supersededById = newContribution.id
    previous.archivedAt = new Date()
    em.persist(previous)
    await em.flush()
    emitWithContainer(ctx.container ?? null, 'prm.wic.contribution_superseded', {
      previousContributionId: previous.id,
      newContributionId: newContribution.id,
      agencyId: previous.agencyId,
      agencyMemberId: previous.agencyMemberId,
      contributionMonth: previous.contributionMonth.toISOString(),
    })
    emitWithContainer(ctx.container ?? null, 'prm.wic.contribution_recorded', {
      contributionId: newContribution.id,
      agencyId: newContribution.agencyId,
      agencyMemberId: newContribution.agencyMemberId,
      githubProfile: newContribution.githubProfile,
      contributionMonth: newContribution.contributionMonth.toISOString(),
      wicLevel: newContribution.wicLevel ?? null,
      wicScore: newContribution.wicScore,
      importBatchId: newContribution.importBatchId,
      rowIndex: newContribution.rowIndex,
      importedAt: newContribution.importedAt.toISOString(),
    })
    return {
      status: 'superseded',
      rowIndex: row.row_index,
      contributionId: newContribution.id,
      previousContributionId: previous.id,
    }
  }

  await em.flush()
  emitWithContainer(ctx.container ?? null, 'prm.wic.contribution_recorded', {
    contributionId: newContribution.id,
    agencyId: newContribution.agencyId,
    agencyMemberId: newContribution.agencyMemberId,
    githubProfile: newContribution.githubProfile,
    contributionMonth: newContribution.contributionMonth.toISOString(),
    wicLevel: newContribution.wicLevel ?? null,
    wicScore: newContribution.wicScore,
    importBatchId: newContribution.importBatchId,
    rowIndex: newContribution.rowIndex,
    importedAt: newContribution.importedAt.toISOString(),
  })
  return { status: 'accepted', rowIndex: row.row_index, contributionId: newContribution.id }
}

/**
 * Process an entire batch. Caller is responsible for wrapping the call site in a
 * transaction-disposed EM and committing/rolling back. On success, emits
 * `prm.wic_import.batch_completed` exactly once.
 */
export async function processWicBatch(
  em: EntityManager,
  input: WicProcessBatchInput,
  container?: { resolve?: <T = unknown>(name: string) => T },
): Promise<WicProcessBatchResult> {
  const ctx = {
    importBatchId: input.importBatchId,
    envelopeMonth: input.envelopeMonth,
    scriptVersion: input.scriptVersion,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    container,
  }
  const rows: WicProcessedRow[] = []
  let acceptedCount = 0
  let rejectedCount = 0
  let supersededCount = 0

  for (let i = 0; i < input.rawRows.length; i++) {
    const result = await processWicRow(em, ctx, input.rawRows[i], i)
    rows.push(result)
    if (result.status === 'accepted') acceptedCount++
    else if (result.status === 'superseded') {
      acceptedCount++
      supersededCount++
    } else if (result.status === 'rejected') {
      rejectedCount++
    }
  }

  emitWithContainer(container ?? null, 'prm.wic_import.batch_completed', {
    importBatchId: input.importBatchId,
    scriptVersion: input.scriptVersion,
    month: input.envelopeMonth,
    acceptedCount,
    rejectedCount,
    supersededCount,
    completedAt: new Date().toISOString(),
  })

  return {
    importBatchId: input.importBatchId,
    acceptedCount,
    rejectedCount,
    supersededCount,
    rows,
  }
}

