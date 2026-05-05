import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { compensateAttributionSaga } from '../lib/attributionSaga'

/**
 * Reverse saga (Spec #3 — attribution-loop, US4.4).
 *
 * Subscribes to `prm.license_deal.reversal_started` and runs the LIFO compensation
 * handlers. Idempotent — the underlying handlers are read-before-write.
 *
 * The forward saga is dispatched by the platform's `workflows` wildcard subscriber
 * via the seeded `prm.license_deal.attribution_saga` `WorkflowDefinition`. The
 * reverse path stays as a thin PRM-owned subscriber because compensation needs to
 * run synchronously in the same request scope as the `LicenseDealService.reverse`
 * call — the platform's reverse trigger would round-trip through Redis + a worker
 * which is unnecessary complexity for the single-step compensation we own here.
 *
 * If/when the workflows module ships a first-class `reverse` trigger contract that
 * matches our shape (compensation = pure inverse of forward; LIFO; no human
 * approvals), this subscriber should be replaced with a JSON `WorkflowDefinition`
 * variant. Tracked under §10 OQ resolutions for v2.
 */
export const metadata = {
  event: 'prm.license_deal.reversal_started',
  persistent: true,
  id: 'prm:license-deal-reversal-compensation',
}

type ReversalPayload = {
  licenseDealId?: string
  tenantId?: string
  organizationId?: string
  previousAttribution?: {
    path: 'A' | 'B' | 'C' | 'none'
    source: 'prospect' | 'rfp' | 'direct'
    prospectId: string | null
    rfpId: string | null
    attributedAgencyId: string | null
  }
  reason?: string
}

export default async function handle(
  payload: ReversalPayload,
  ctx: { resolve: <T = unknown>(name: string) => T },
): Promise<void> {
  if (!payload?.licenseDealId || !payload?.tenantId || !payload?.organizationId) return
  if (!payload.previousAttribution) return

  let em: EntityManager
  let container: AwilixContainer | undefined
  try {
    em = ctx.resolve<EntityManager>('em')
    container = {
      resolve: ctx.resolve,
      cradle: new Proxy({}, { get: (_t, prop: string) => ctx.resolve(prop) }),
    } as unknown as AwilixContainer
  } catch (err) {
    console.warn('[prm:license-deal-reversal-compensation] DI resolve failed', err)
    return
  }

  await compensateAttributionSaga(
    {
      licenseDealId: payload.licenseDealId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      previousAttribution: payload.previousAttribution,
      reason: payload.reason ?? 'reversal',
    },
    { em, container },
  )
}
