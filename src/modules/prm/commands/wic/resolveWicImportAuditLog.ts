import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { WicImportAuditLog } from '../../data/entities'
import type { WicResolutionAction } from '../../data/validators'
import { safeEmit } from '../../lib/safeEmit'

/**
 * `ResolveWICImportAuditLogCommand` (Spec #4 §4.1 — undoable).
 *
 * Resolves a B10 audit-log row with one of three resolution actions
 * (`accepted_after_fix` | `rolled_back` | `ignored`). Used for mis-click reversal
 * by OM PartnerOps; not an automated path.
 *
 * Execute: writes `resolvedAt`, `resolutionAction`, `resolvedByUserId`,
 * `resolutionNote`; emits `prm.wic_import.resolved`.
 *
 * Undo: clears the four fields back to NULL; emits the new compensation event
 * `prm.wic_import.resolved.undone`. Idempotent — undo of an already-unresolved
 * row is a no-op + still emits compensation event.
 *
 * **Why a separate command (not a service method):** matches the Spec §4.1
 * "every state-changing command has `undo`" rule and gives the audit-log
 * surface a uniform shape (the same idiom that B10 uses for the record-undo
 * and supersede-undo paths). The HTTP route handler delegates to
 * `ResolveWicImportAuditLogCommand.execute` — handler stays thin and
 * focused on auth + shape, command owns the atomic write.
 */

export type ResolveWicImportAuditLogArgs = {
  tenantId: string
  organizationId: string
  auditLogId: string
  action: WicResolutionAction
  resolvedByUserId: string
  note?: string | null
}

export type ResolveWicImportAuditLogCtx = {
  em: EntityManager
  container?: { resolve?: <T = unknown>(name: string) => T } | null
}

export type ResolveWicImportAuditLogResult = {
  auditLogId: string
  resolvedAt: string
  resolutionAction: WicResolutionAction
  resolvedByUserId: string
  resolutionNote: string | null
}

/**
 * Sentinel exception for "row is already resolved". Caller (HTTP route) maps
 * this to a 409. Using a tagged Error so the handler doesn't have to inspect
 * row state itself — keeps the command the source of truth on resolution
 * lifecycle.
 */
export class WicAuditLogAlreadyResolvedError extends Error {
  readonly code = 'WIC_AUDIT_LOG_ALREADY_RESOLVED' as const
  readonly auditLogId: string
  readonly resolvedAt: string
  constructor(auditLogId: string, resolvedAt: string) {
    super(`Audit log ${auditLogId} is already resolved at ${resolvedAt}`)
    this.auditLogId = auditLogId
    this.resolvedAt = resolvedAt
  }
}

/**
 * Sentinel for "row not found". Caller maps this to 404.
 */
export class WicAuditLogNotFoundError extends Error {
  readonly code = 'WIC_AUDIT_LOG_NOT_FOUND' as const
  readonly auditLogId: string
  constructor(auditLogId: string) {
    super(`Audit log ${auditLogId} not found`)
    this.auditLogId = auditLogId
  }
}

export async function execute(
  args: ResolveWicImportAuditLogArgs,
  ctx: ResolveWicImportAuditLogCtx,
): Promise<ResolveWicImportAuditLogResult> {
  const row = await findOneWithDecryption<WicImportAuditLog>(
    ctx.em,
    WicImportAuditLog,
    {
      id: args.auditLogId,
      tenantId: args.tenantId,
    } as FilterQuery<WicImportAuditLog>,
    undefined,
    { tenantId: args.tenantId, organizationId: args.organizationId },
  )
  if (!row) {
    throw new WicAuditLogNotFoundError(args.auditLogId)
  }
  if (row.resolvedAt) {
    throw new WicAuditLogAlreadyResolvedError(row.id, row.resolvedAt.toISOString())
  }

  const now = new Date()
  row.resolvedAt = now
  row.resolutionAction = args.action
  row.resolvedByUserId = args.resolvedByUserId
  row.resolutionNote = args.note ?? null
  ctx.em.persist(row)
  await ctx.em.flush()

  await safeEmit(
    'prm.wic_import.resolved',
    {
      auditLogId: row.id,
      action: row.resolutionAction,
      resolvedByUserId: row.resolvedByUserId,
      resolvedAt: row.resolvedAt!.toISOString(),
    },
    { container: ctx.container ?? null },
  )

  return {
    auditLogId: row.id,
    resolvedAt: row.resolvedAt!.toISOString(),
    resolutionAction: row.resolutionAction as WicResolutionAction,
    resolvedByUserId: row.resolvedByUserId!,
    resolutionNote: row.resolutionNote ?? null,
  }
}

export type UndoResolveWicImportAuditLogArgs = {
  tenantId: string
  organizationId: string
  auditLogId: string
}

export type UndoResolveWicImportAuditLogResult = {
  auditLogId: string
  alreadyUnresolved: boolean
  /** The action that the row used to carry, before the undo cleared it. */
  clearedAction: WicResolutionAction | null
  clearedResolvedByUserId: string | null
  clearedResolvedAt: string | null
}

/**
 * Undo `execute` — clears the four resolution fields back to NULL.
 *
 * Idempotent: calling undo on a row that is already unresolved is a no-op +
 * still emits the compensation event for subscriber convergence.
 *
 * Returns `null` when the row is not found.
 */
export async function undo(
  args: UndoResolveWicImportAuditLogArgs,
  ctx: ResolveWicImportAuditLogCtx,
): Promise<UndoResolveWicImportAuditLogResult | null> {
  const row = await findOneWithDecryption<WicImportAuditLog>(
    ctx.em,
    WicImportAuditLog,
    {
      id: args.auditLogId,
      tenantId: args.tenantId,
    } as FilterQuery<WicImportAuditLog>,
    undefined,
    { tenantId: args.tenantId, organizationId: args.organizationId },
  )
  if (!row) return null

  const alreadyUnresolved = !row.resolvedAt
  const clearedAction = (row.resolutionAction as WicResolutionAction | null) ?? null
  const clearedResolvedByUserId = row.resolvedByUserId ?? null
  const clearedResolvedAt = row.resolvedAt ? row.resolvedAt.toISOString() : null

  if (!alreadyUnresolved) {
    row.resolvedAt = null
    row.resolutionAction = null
    row.resolvedByUserId = null
    row.resolutionNote = null
    ctx.em.persist(row)
    await ctx.em.flush()
  }

  await safeEmit(
    'prm.wic_import.resolved.undone',
    {
      auditLogId: row.id,
      clearedAction,
      clearedResolvedByUserId,
      clearedResolvedAt,
      alreadyUnresolved,
    },
    { container: ctx.container ?? null },
  )

  return {
    auditLogId: row.id,
    alreadyUnresolved,
    clearedAction,
    clearedResolvedByUserId,
    clearedResolvedAt,
  }
}

export const ResolveWicImportAuditLogCommand = { execute, undo }
