import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { WicContribution } from '../../data/entities'
import { safeEmit } from '../../lib/safeEmit'

/**
 * `SupersedeWICContributionCommand` (Spec #4 §4.1 — undoable).
 *
 * Supersession is the idempotent re-import path (invariant #3): when n8n re-imports
 * a `(agency_member_id, contribution_month)` that already has an active row, the
 * previous row is marked as superseded by the new one and archived in the same
 * write. Modeled as its OWN command rather than folded into
 * `RecordWICContributionCommand` because:
 *
 *   (a) the undo contracts differ — record-undo soft-deletes the new row, while
 *       supersede-undo restores the previous row to "live",
 *   (b) the events are separately auditable
 *       (`prm.wic.contribution_superseded` vs `prm.wic.contribution_recorded`),
 *   (c) it is the right unit of replay when a prior-batch retry corrects a
 *       stale supersession.
 *
 * Execute: sets `previous.supersededById = newContributionId` and
 * `previous.archivedAt = now()`, emits `prm.wic.contribution_superseded`.
 *
 * Undo: clears `supersededById` + `archivedAt` on the previous row and emits
 * `prm.wic.contribution_superseded.undone`. Idempotent — calling undo when the
 * row is already un-superseded is a no-op + still emits the compensation event.
 *
 * **Chain safety (supersession of supersession):** undo only touches the
 * specified `previousContributionId`. If that row was itself superseded by a
 * later supersession, undoing the inner supersession leaves the outer
 * supersession intact (the outer row's `supersededById` still points at the
 * row this command undid). The caller is responsible for unwinding the chain
 * in the right order; this command is the atomic unit, not the orchestrator.
 */

export type SupersedeWicContributionArgs = {
  tenantId: string
  organizationId: string
  previousContributionId: string
  newContributionId: string
}

export type SupersedeWicContributionCtx = {
  em: EntityManager
  container?: { resolve?: <T = unknown>(name: string) => T } | null
}

export type SupersedeWicContributionResult = {
  previousContributionId: string
  newContributionId: string
  archivedAt: string
}

/**
 * Execute the command. Caller passes the already-loaded previous row — this keeps
 * the import hot path single-SELECT (the service has already loaded `previous` to
 * decide whether to supersede or insert fresh). For standalone replay tooling
 * use `executeById` which re-loads from `previousContributionId`.
 *
 * Throws when the previous row is already superseded by a DIFFERENT
 * `newContributionId` (chain corruption guard). Re-applying the same supersession
 * is a no-op + still emits the event for subscriber convergence.
 */
export async function execute(
  args: SupersedeWicContributionArgs & { previous: WicContribution },
  ctx: SupersedeWicContributionCtx,
): Promise<SupersedeWicContributionResult> {
  const previous = args.previous
  if (previous.id !== args.previousContributionId) {
    throw new Error(
      `SupersedeWicContributionCommand.execute: previous.id (${previous.id}) does not match previousContributionId (${args.previousContributionId})`,
    )
  }
  if (previous.supersededById && previous.supersededById !== args.newContributionId) {
    throw new Error(
      `SupersedeWicContributionCommand.execute: previous contribution ${args.previousContributionId} already superseded by ${previous.supersededById} (cannot reassign to ${args.newContributionId})`,
    )
  }

  const archivedAt = previous.archivedAt ?? new Date()
  previous.supersededById = args.newContributionId
  previous.archivedAt = archivedAt
  previous.updatedAt = new Date()
  ctx.em.persist(previous)
  await ctx.em.flush()

  await safeEmit(
    'prm.wic.contribution_superseded',
    {
      previousContributionId: previous.id,
      newContributionId: args.newContributionId,
      agencyId: previous.agencyId,
      agencyMemberId: previous.agencyMemberId,
      contributionMonth: previous.contributionMonth.toISOString(),
    },
    { container: ctx.container ?? null },
  )

  return {
    previousContributionId: previous.id,
    newContributionId: args.newContributionId,
    archivedAt: archivedAt.toISOString(),
  }
}

export type UndoSupersedeWicContributionArgs = {
  tenantId: string
  organizationId: string
  previousContributionId: string
}

export type UndoSupersedeWicContributionResult = {
  previousContributionId: string
  alreadyUnsuperseded: boolean
  /** The id that the previous row used to point at, before the undo cleared it. */
  clearedSupersedingContributionId: string | null
}

/**
 * Undo `execute` — clears `supersededById` + `archivedAt` on the previous row.
 *
 * Idempotent: calling undo on a row that is already un-superseded is a no-op
 * but still emits the compensation event for subscriber convergence.
 *
 * Returns `null` when the previous row is not found.
 */
export async function undo(
  args: UndoSupersedeWicContributionArgs,
  ctx: SupersedeWicContributionCtx,
): Promise<UndoSupersedeWicContributionResult | null> {
  const previous = await findOneWithDecryption<WicContribution>(
    ctx.em,
    WicContribution,
    {
      id: args.previousContributionId,
      tenantId: args.tenantId,
    } as FilterQuery<WicContribution>,
    undefined,
    { tenantId: args.tenantId, organizationId: args.organizationId },
  )
  if (!previous) return null

  const previouslySupersededBy = previous.supersededById ?? null
  const alreadyUnsuperseded = previouslySupersededBy === null && !previous.archivedAt

  if (!alreadyUnsuperseded) {
    previous.supersededById = null
    previous.archivedAt = null
    previous.updatedAt = new Date()
    ctx.em.persist(previous)
    await ctx.em.flush()
  }

  await safeEmit(
    'prm.wic.contribution_superseded.undone',
    {
      previousContributionId: previous.id,
      agencyId: previous.agencyId,
      agencyMemberId: previous.agencyMemberId,
      contributionMonth: previous.contributionMonth.toISOString(),
      clearedSupersedingContributionId: previouslySupersededBy,
      alreadyUnsuperseded,
    },
    { container: ctx.container ?? null },
  )

  return {
    previousContributionId: previous.id,
    alreadyUnsuperseded,
    clearedSupersedingContributionId: previouslySupersededBy,
  }
}

/**
 * Convenience wrapper for callers that don't have the previous row loaded
 * (e.g. replay tooling, ad-hoc B10 actions). Loads `previous` by id then
 * delegates to `execute`. Throws `Error` if the row is missing.
 */
export async function executeById(
  args: SupersedeWicContributionArgs,
  ctx: SupersedeWicContributionCtx,
): Promise<SupersedeWicContributionResult> {
  const previous = await findOneWithDecryption<WicContribution>(
    ctx.em,
    WicContribution,
    {
      id: args.previousContributionId,
      tenantId: args.tenantId,
    } as FilterQuery<WicContribution>,
    undefined,
    { tenantId: args.tenantId, organizationId: args.organizationId },
  )
  if (!previous) {
    throw new Error(
      `SupersedeWicContributionCommand.executeById: previous contribution ${args.previousContributionId} not found in tenant ${args.tenantId}`,
    )
  }
  return execute({ ...args, previous }, ctx)
}

export const SupersedeWicContributionCommand = { execute, executeById, undo }
