import type { EntityManager } from '@mikro-orm/postgresql'
import { RfpResponse } from '../data/entities'
import { safeEmit } from '../lib/safeEmit'

/**
 * `ChallengeRoundRevisionUnlocker` — Spec #6 §4.3 (US5.8 backend side).
 *
 * Listens on `prm.rfp.reopened_for_scoring`. For every `RfpResponse`
 * linked to the re-opened RFP, emits `prm.rfp_response.available_for_revision`
 * (one per response) so Spec #5's portal P10 can render the "revise
 * response" CTA.
 *
 * **Spec deviation note (documented in run plan):** the spec text talks
 * about resetting `RfpResponse.status` from `selected` / `not_selected`
 * back to `submitted`. In Spec #5's frozen schema the `RfpResponse.status`
 * enum is `draft / submitted` only — the `selected` / `not_selected`
 * outcomes are derived (not persisted) from `Rfp.selectedAgencyId`. So
 * "reset to submitted" is a no-op here; we ONLY emit the per-response
 * signal. The portal CTA keys on `Rfp.status = 'reopened'`, so this
 * preserves the spec's intent without inventing new persisted statuses.
 */
export const metadata = {
  event: 'prm.rfp.reopened_for_scoring',
  persistent: true,
  id: 'prm:rfp:challenge-round-unlocker',
}

type Payload = {
  rfp_id: string
  trigger: 'client_reopen' | 'challenge_round'
  reopened_by_user_id?: string
  reopened_deadline_at: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: Payload, ctx: ResolverContext): Promise<void> {
  const em = ctx.resolve<EntityManager>('em')?.fork({ clear: true, freshEventManager: true })
  if (!em) return
  const responses = await em.find(RfpResponse, { rfpId: payload.rfp_id } as any)
  for (const response of responses) {
    if (response.status !== 'submitted') continue
    await safeEmit('prm.rfp_response.available_for_revision', {
      rfp_response_id: response.id,
      rfp_id: payload.rfp_id,
      agency_id: response.agencyId,
      prior_status: response.status,
      reopened_deadline_at: payload.reopened_deadline_at,
    })
  }
}
