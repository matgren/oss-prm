import type { EntityManager } from '@mikro-orm/postgresql'
import type { RfpService } from '../lib/rfpService'

/**
 * `RfpReopenedDeadlineExpiry` worker — Spec #6 §4.3.
 *
 * Periodic sweep that auto-transitions RFPs from `reopened` back to
 * `scoring` when `reopened_deadline_at < now()`. Emits one
 * `prm.rfp.reopened_deadline_expired` event per transition.
 *
 * Convention: this module ships the worker as a default-export handler
 * + `metadata` declaration matching the OM platform's worker auto-
 * discovery contract. For deployments that haven't wired BullMQ, the
 * sweep can also be invoked synchronously via
 * `RfpService.sweepExpiredReopenedDeadlines` (cron-callable, no queue
 * dependency).
 *
 * Cadence: every 15 minutes is sufficient — the deadline is a soft
 * boundary (the agency must submit BY then; OMPartnerOps acts on the
 * scoring side AFTER).
 */
export const metadata = {
  queue: 'prm-rfp-deadline-expiry',
  concurrency: 1,
  /**
   * Cron schedule (every 15 minutes). The OM scheduler picks this up
   * when the module is registered; deployments without scheduler can
   * dispatch the sweep manually via the service method.
   */
  cron: '*/15 * * * *',
}

type HandlerContext = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * Default export — invoked by the worker runtime. Resolves the
 * `RfpService` from the request container and runs a system-wide sweep.
 */
export default async function rfpReopenedDeadlineExpiryWorker(
  _job: unknown,
  ctx: HandlerContext,
): Promise<{ expiredCount: number; expiredIds: string[] }> {
  const service = ctx.resolve<RfpService>('rfpService')
  if (!service) return { expiredCount: 0, expiredIds: [] }
  const expiredIds = await service.sweepExpiredReopenedDeadlines({})
  return { expiredCount: expiredIds.length, expiredIds }
}
