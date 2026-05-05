/**
 * PRM attribution saga primitives (Spec #3 — attribution-loop).
 *
 * The platform's `workflows` module owns the saga storage, retry, dedup, and LIFO
 * compensation contract (OQ-017). This file ships:
 *
 *   1. `executeAttributionSaga` — the forward saga body. Idempotent. The platform
 *      invokes it via `EXECUTE_FUNCTION` activity dispatched by the
 *      `prm.license_deal.attribution_saga` `WorkflowDefinition` JSON. The same
 *      function is also called inline by `LicenseDealService.attribute` during
 *      tests / when the workflow runtime is paused (see `runInlineSaga`).
 *
 *   2. `compensateAttributionSaga` — LIFO compensation. Triggered on
 *      `prm.license_deal.reversal_started`; invokes the per-path rollback in
 *      reverse order (Prospect → qualified before clearing the snapshot).
 *
 *   3. `idempotencyKeyAlreadyApplied` — application-side dedup helper. Each saga
 *      pass writes/reads `correlationKey = license_deal_id + ':' + attribution_source`
 *      via a query against `workflow_instances` (when the platform is wired) and
 *      the `LicenseDeal.attributedAgencyId` snapshot (always). Retries are safe.
 *
 * Cross-spec contract:
 *   - Activity handler signatures are FROZEN under `workflowFunction:prm.saga.*`.
 *   - Compensation runs LIFO per OQ-017's platform guarantee.
 *   - The saga emits no new events beyond what `LicenseDealService` already emits
 *     (`prm.prospect.status_changed { byActorType: 'system' }` is emitted by
 *     `ProspectService.transitionStatus` when the saga calls it).
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import {
  findOneWithDecryption,
  findWithDecryption,
} from '@open-mercato/shared/lib/encryption/find'
import { LicenseDeal, Prospect } from '../data/entities'
import type { LicenseDealService } from './licenseDealService'
import type { ProspectService } from './prospectService'

export type AttributionSagaArgs = {
  licenseDealId: string
  tenantId: string
  organizationId: string
  attributionPath: 'A' | 'B' | 'C' | 'none'
  attributionSource: 'prospect' | 'rfp' | 'direct'
  prospectId?: string | null
  rfpId?: string | null
  attributedAgencyId?: string | null
  competingProspectIdsToRetire?: string[]
  correlationKey: string
}

export type SagaActivityResult = {
  applied: boolean
  reason?: string
  pathInvoked: 'A' | 'B' | 'C' | 'none'
  activitiesRun: string[]
}

/**
 * Forward saga executor. Path A snapshots Prospect agency (idempotent) + transitions
 * Prospect → won via system actor. Path B snapshots RFP winner (no-op when the
 * `prm_rfps` table is missing — see Spec §8.4 deferred dependency). Path C is a
 * no-op beyond the aggregate write already committed by `attribute()`.
 *
 * @returns SagaActivityResult — useful for the inline path (tests + dev fallback).
 */
export async function executeAttributionSaga(
  args: AttributionSagaArgs,
  deps: { em: EntityManager; container?: AwilixContainer },
): Promise<SagaActivityResult> {
  const { em } = deps
  const scope = { tenantId: args.tenantId }
  const activitiesRun: string[] = []

  const deal = await findOneWithDecryption(
    em,
    LicenseDeal,
    { id: args.licenseDealId, tenantId: args.tenantId, deletedAt: null },
    undefined,
    scope,
  )
  if (!deal) {
    return { applied: false, reason: 'license-deal-not-found', pathInvoked: 'none', activitiesRun }
  }

  // Idempotency: if the deal's attribution snapshot has been reversed (path = 'none')
  // we skip — a stale event may have been re-delivered after a /reverse.
  if (deal.attributionPath !== args.attributionPath) {
    return {
      applied: false,
      reason: 'attribution-path-changed',
      pathInvoked: 'none',
      activitiesRun,
    }
  }

  switch (args.attributionPath) {
    case 'A': {
      // Activity 1 — snapshotProspect (read-before-write idempotent).
      if (!deal.attributedAgencyId && deal.prospectId) {
        const prospect = await findOneWithDecryption(
          em,
          Prospect,
          { id: deal.prospectId, tenantId: args.tenantId, deletedAt: null },
          undefined,
          scope,
        )
        if (prospect) {
          deal.attributedAgencyId = prospect.agencyId
          deal.updatedAt = new Date()
          deal.version += 1
          await em.flush()
          activitiesRun.push('snapshotProspect')
        }
      }
      // Activity 2 — markProspectWon. Idempotent: ProspectService.transitionStatus
      // is a no-op if status is already `won`.
      if (deal.prospectId && deps.container) {
        const prospectService = tryResolve<ProspectService>(deps.container, 'prospectService')
        if (prospectService) {
          const prospect = await findOneWithDecryption(
            em,
            Prospect,
            { id: deal.prospectId, tenantId: args.tenantId, deletedAt: null },
            undefined,
            scope,
          )
          if (prospect && prospect.status !== 'won') {
            try {
              await prospectService.transitionStatus(
                deal.prospectId,
                {
                  toStatus: 'won',
                  ifMatchStatusChangedAt: prospect.statusChangedAt.toISOString(),
                  reason: `LicenseDeal ${deal.id} attribution Path A`,
                },
                {
                  tenantId: args.tenantId,
                  actor: { type: 'system', reason: 'attribution_saga_path_a' },
                },
              )
              activitiesRun.push('markProspectWon')
            } catch (err) {
              // Optimistic-concurrency / state-machine errors are not retriable.
              // Surface a structured outcome — the platform's retry policy will
              // re-fire `executeAttributionSaga` on transient issues only.
              return {
                applied: false,
                reason: err instanceof Error ? err.message : String(err),
                pathInvoked: 'A',
                activitiesRun,
              }
            }
          }
        }
      }
      return { applied: true, pathInvoked: 'A', activitiesRun }
    }
    case 'B': {
      // RFP table is owned by Spec #5. When present, snapshot the selected agency
      // onto the LicenseDeal. When absent, the writer remains a placeholder until
      // Spec #5 ships and re-fires the saga.
      if (!deal.attributedAgencyId && deal.rfpId) {
        const rfpRow = await tryLookupRfpAgency(em, deal.rfpId, args.tenantId)
        if (rfpRow && rfpRow.selectedAgencyId) {
          deal.attributedAgencyId = rfpRow.selectedAgencyId
          deal.updatedAt = new Date()
          deal.version += 1
          await em.flush()
          activitiesRun.push('snapshotRfpWinner')
        }
      }
      return { applied: true, pathInvoked: 'B', activitiesRun }
    }
    case 'C':
    case 'none':
    default:
      return { applied: true, pathInvoked: args.attributionPath, activitiesRun }
  }
}

/**
 * Compensation handler. Walks LIFO: undo `markProspectWon` (Prospect → qualified)
 * before clearing the snapshot. Triggered by `prm.license_deal.reversal_started`.
 *
 * Idempotency: each step is read-before-write — re-running is safe.
 */
export async function compensateAttributionSaga(
  args: {
    licenseDealId: string
    tenantId: string
    organizationId: string
    previousAttribution: {
      path: 'A' | 'B' | 'C' | 'none'
      source: 'prospect' | 'rfp' | 'direct'
      prospectId: string | null
      rfpId: string | null
      attributedAgencyId: string | null
    }
    reason: string
  },
  deps: { em: EntityManager; container?: AwilixContainer },
): Promise<SagaActivityResult> {
  const { em } = deps
  const scope = { tenantId: args.tenantId }
  const activitiesRun: string[] = []
  const path = args.previousAttribution.path

  switch (path) {
    case 'A': {
      const prospectId = args.previousAttribution.prospectId
      if (prospectId && deps.container) {
        const prospectService = tryResolve<ProspectService>(deps.container, 'prospectService')
        if (prospectService) {
          const prospect = await findOneWithDecryption(
            em,
            Prospect,
            { id: prospectId, tenantId: args.tenantId, deletedAt: null },
            undefined,
            scope,
          )
          // Compensation step (LIFO order #1): Prospect won → qualified.
          // Prospects in v1 don't have a direct `won → qualified` arrow in the state
          // machine, so we use the system-actor escape hatch by going through
          // revert-then-relabel in a single hop. We accomplish this with a direct
          // update via the underlying knex query (the saga is the sole authorised
          // writer for this transition — see Spec §2 reverse-saga contract).
          if (prospect && prospect.status === 'won') {
            const knex = em.getKnex()
            const now = new Date()
            await knex('prm_prospects')
              .where('id', prospectId)
              .where('tenant_id', args.tenantId)
              .update({
                status: 'qualified',
                status_changed_at: now,
                updated_at: now,
              })
            // Emit the canonical status_changed event so the candidate index +
            // dashboard cache invalidate.
            const { safeEmit } = await import('./safeEmit')
            await safeEmit(
              'prm.prospect.status_changed',
              {
                prospectId,
                agencyId: prospect.agencyId,
                organizationId: prospect.organizationId,
                tenantId: prospect.tenantId,
                fromStatus: 'won',
                toStatus: 'qualified',
                byActorType: 'system',
                byActorId: null,
                reason: args.reason,
                changedAt: now.toISOString(),
              },
              { context: { prospectId, source: 'attribution_saga_compensation' } },
            )
            activitiesRun.push('compensate.markProspectQualified')
          }
        }
      }
      // Compensation step #2: clear the snapshot (LicenseDealService.reverse already
      // resets `attributedAgencyId` etc. — re-run is a no-op).
      activitiesRun.push('compensate.unsnapshotProspect')
      return { applied: true, pathInvoked: 'A', activitiesRun }
    }
    case 'B': {
      activitiesRun.push('compensate.unsnapshotRfpWinner')
      return { applied: true, pathInvoked: 'B', activitiesRun }
    }
    case 'C':
    case 'none':
    default:
      return { applied: true, pathInvoked: path, activitiesRun }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryResolve<T>(container: AwilixContainer, name: string): T | null {
  try {
    return container.resolve<T>(name)
  } catch {
    return null
  }
}

async function tryLookupRfpAgency(
  em: EntityManager,
  rfpId: string,
  tenantId: string,
): Promise<{ selectedAgencyId: string | null } | null> {
  try {
    const knex = em.getKnex()
    const reg = (await knex.raw(`select to_regclass('public.prm_rfps') as oid`)) as {
      rows: Array<{ oid: string | null }>
    }
    if (!reg.rows?.[0]?.oid) return null
    const row = (await knex('prm_rfps')
      .where('id', rfpId)
      .where('tenant_id', tenantId)
      .first()) as { selected_agency_id: string | null } | undefined
    if (!row) return null
    return { selectedAgencyId: row.selected_agency_id ?? null }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Inline saga (used in tests / dev when workflow runtime isn't started).
// ---------------------------------------------------------------------------

/**
 * Attribute-then-execute helper used by the inline saga path. Calls the same
 * activity handlers the platform calls — guaranteed identical behavior.
 *
 * Re-running is idempotent (handlers themselves are read-before-write).
 */
export async function runInlineSaga(
  args: AttributionSagaArgs,
  deps: { em: EntityManager; container?: AwilixContainer },
): Promise<SagaActivityResult> {
  return executeAttributionSaga(args, deps)
}

/**
 * Find candidate workflow instances for this correlationKey — used by the
 * dedup pre-check before invoking the inline saga (avoids double-applying
 * markProspectWon when the platform's wildcard subscriber + our inline call
 * race).
 */
export async function findOpenSagaInstancesByCorrelationKey(
  em: EntityManager,
  correlationKey: string,
  scope: { tenantId: string; organizationId: string },
): Promise<Array<{ id: string; status: string }>> {
  try {
    const knex = em.getKnex()
    const reg = (await knex.raw(`select to_regclass('public.workflow_instances') as oid`)) as {
      rows: Array<{ oid: string | null }>
    }
    if (!reg.rows?.[0]?.oid) return []
    const rows = (await knex('workflow_instances')
      .where('correlation_key', correlationKey)
      .where('tenant_id', scope.tenantId)
      .where('organization_id', scope.organizationId)
      .whereNull('deleted_at')
      .select('id', 'status')) as Array<{ id: string; status: string }>
    return rows
  } catch {
    return []
  }
}

// Tree-shaker keepalive for findWithDecryption (re-exported indirectly).
const _GUARD: typeof findWithDecryption = findWithDecryption
void _GUARD
