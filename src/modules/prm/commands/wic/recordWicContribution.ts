import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { WicContribution } from '../../data/entities'
import type { WicLevel } from '../../data/validators'
import { safeEmit } from '../../lib/safeEmit'

/**
 * `RecordWICContributionCommand` (Spec #4 §4.1 — undoable).
 *
 * Inserts a new `WicContribution` row using snapshotted member fields and emits
 * `prm.wic.contribution_recorded`. `undo` soft-deletes the inserted row by setting
 * `archived_at = now()` and emits the compensation event
 * `prm.wic.contribution_recorded.undone`.
 *
 * **Why this is its own command (vs. inlined in `wicImportService`):** Spec §10.7
 * mandates "undo by default". The operational use-case is n8n's automated import
 * pipeline flooding bad rows — OM PartnerOps needs a deterministic rollback path
 * that doesn't require manual SQL. By isolating the atomic write into a command
 * with `execute` + `undo`, the audit-log surface (B10) can call the SAME
 * `undo` flow that the batch handler would call on a partial-batch abort.
 *
 * **Soft-delete vs. hard-delete:** invariant #3 (idempotent supersession) requires
 * the `(import_batch_id, row_index)` UNIQUE to act as the replay guard. Hard-deleting
 * an undone row would let a re-import for the same `(batch, row)` insert again —
 * which is the opposite of the desired idempotent behaviour. Soft-delete via
 * `archivedAt` keeps the row queryable by replay code while excluding it from
 * the "active" predicate `superseded_by_id IS NULL AND archived_at IS NULL`.
 *
 * **Idempotency of `undo`:** calling `undo` on an already-archived row is a
 * no-op + still emits the compensation event (downstream subscribers expect it).
 */

export type RecordWicContributionArgs = {
  /** Tenant scope (mandatory — every row is tenant-scoped). */
  tenantId: string
  organizationId: string

  /** SNAPSHOT — invariant #13. Frozen at import time. */
  agencyId: string
  agencyMemberId: string
  /** SNAPSHOT — invariant #13. */
  githubProfile: string

  /** First-of-month UTC date. The DB CHECK enforces day=1 as defence-in-depth. */
  contributionMonth: Date

  /** Enum L1..L4 (NULL legal for zero-score months). */
  wicLevel: WicLevel | null
  /** Decimal-string representation (numeric(12,4)). */
  wicScore: string
  contributionCount: number
  /** Decimal-string representation (numeric(12,4)). */
  bountyBonus: string
  whyBonus?: string | null
  whatIncluded?: string | null
  whatExcluded?: string | null

  scriptVersion: string
  importBatchId: string
  rowIndex: number

  computedAt: Date
}

export type RecordWicContributionCtx = {
  em: EntityManager
  /**
   * Optional DI container for `safeEmit`. Mirrors the `processWicRow` shape — when
   * absent, `safeEmit` falls back to the module-level event bus.
   */
  container?: { resolve?: <T = unknown>(name: string) => T } | null
}

export type RecordWicContributionResult = {
  contributionId: string
  contribution: WicContribution
}

/**
 * Execute the command — insert + emit. Caller is responsible for the surrounding
 * transaction; the command flushes once on success.
 */
export async function execute(
  args: RecordWicContributionArgs,
  ctx: RecordWicContributionCtx,
): Promise<RecordWicContributionResult> {
  const now = new Date()
  const contribution = ctx.em.create(WicContribution, {
    tenantId: args.tenantId,
    organizationId: args.organizationId,
    agencyId: args.agencyId,
    agencyMemberId: args.agencyMemberId,
    githubProfile: args.githubProfile,
    contributionMonth: args.contributionMonth,
    wicLevel: args.wicLevel,
    wicScore: args.wicScore,
    contributionCount: args.contributionCount,
    bountyBonus: args.bountyBonus,
    whyBonus: args.whyBonus ?? null,
    whatIncluded: args.whatIncluded ?? null,
    whatExcluded: args.whatExcluded ?? null,
    scriptVersion: args.scriptVersion,
    importBatchId: args.importBatchId,
    rowIndex: args.rowIndex,
    computedAt: args.computedAt,
    importedAt: now,
    createdAt: now,
    updatedAt: now,
  } as any)
  ctx.em.persist(contribution)
  await ctx.em.flush()

  await safeEmit(
    'prm.wic.contribution_recorded',
    {
      contributionId: contribution.id,
      agencyId: contribution.agencyId,
      agencyMemberId: contribution.agencyMemberId,
      githubProfile: contribution.githubProfile,
      contributionMonth: contribution.contributionMonth.toISOString(),
      wicLevel: contribution.wicLevel ?? null,
      wicScore: contribution.wicScore,
      importBatchId: contribution.importBatchId,
      rowIndex: contribution.rowIndex,
      importedAt: contribution.importedAt.toISOString(),
    },
    { container: ctx.container ?? null },
  )

  return { contributionId: contribution.id, contribution }
}

export type UndoRecordWicContributionArgs = {
  tenantId: string
  organizationId: string
  contributionId: string
}

export type UndoRecordWicContributionResult = {
  contributionId: string
  alreadyArchived: boolean
  archivedAt: string | null
}

/**
 * Undo `execute` — soft-deletes the inserted row by setting `archivedAt = now()`
 * and emits `prm.wic.contribution_recorded.undone`. Idempotent: calling undo on
 * an already-archived row is a no-op (returns `alreadyArchived: true`) but still
 * emits the compensation event so subscribers can re-converge.
 *
 * Returns `null` when the row is not found (caller decides whether that's a 404).
 */
export async function undo(
  args: UndoRecordWicContributionArgs,
  ctx: RecordWicContributionCtx,
): Promise<UndoRecordWicContributionResult | null> {
  const row = await findOneWithDecryption<WicContribution>(
    ctx.em,
    WicContribution,
    {
      id: args.contributionId,
      tenantId: args.tenantId,
    } as FilterQuery<WicContribution>,
    undefined,
    { tenantId: args.tenantId, organizationId: args.organizationId },
  )
  if (!row) return null

  const alreadyArchived = !!row.archivedAt
  if (!alreadyArchived) {
    row.archivedAt = new Date()
    row.updatedAt = new Date()
    ctx.em.persist(row)
    await ctx.em.flush()
  }

  await safeEmit(
    'prm.wic.contribution_recorded.undone',
    {
      contributionId: row.id,
      agencyId: row.agencyId,
      agencyMemberId: row.agencyMemberId,
      contributionMonth: row.contributionMonth.toISOString(),
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      alreadyArchived,
    },
    { container: ctx.container ?? null },
  )

  return {
    contributionId: row.id,
    alreadyArchived,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  }
}

/** Convenience namespace for symmetry with the spec's "Command" terminology. */
export const RecordWicContributionCommand = { execute, undo }
