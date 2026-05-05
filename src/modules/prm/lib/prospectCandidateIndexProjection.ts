import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Prospect, ProspectCandidateIndex } from '../data/entities'
import { normalizeCompanyName, normalizeContactEmail } from '../data/validators'

/**
 * Shared handler for the `prm_prospect_candidate_index` projection (Spec #2 — wip-scoreboard).
 *
 * One source of truth for the upsert/delete logic that the four event-specific subscribers
 * in `subscribers/prospect-candidate-index-*.ts` invoke. Keeping the logic here lets the
 * subscribers stay tiny (a single dispatching call) while the projection contract lives
 * in one place — easy to reason about and easy to unit-test in isolation.
 *
 * Idempotency: keyed on `prospect_id` (the projection PK). Re-delivery is safe.
 */

export type ProspectIndexEventPayload = {
  prospectId: string
  agencyId?: string
  organizationId?: string
  tenantId: string
}

export type ProspectIndexAction = 'upsert' | 'delete'

export async function handleProspectCandidateIndex(
  payload: ProspectIndexEventPayload,
  action: ProspectIndexAction,
): Promise<void> {
  if (!payload?.prospectId || !payload?.tenantId) return
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  if (action === 'delete') {
    const existing = await em.findOne(ProspectCandidateIndex, { prospectId: payload.prospectId })
    if (existing) {
      await em.removeAndFlush(existing)
    }
    return
  }

  // Re-fetch the canonical Prospect for source-of-truth values. The subscriber is
  // idempotent on `prospect_id` and tolerates out-of-order delivery — re-derive the
  // row from the aggregate state rather than trusting only the event payload.
  const prospect = await findOneWithDecryption(
    em,
    Prospect,
    {
      id: payload.prospectId,
      tenantId: payload.tenantId,
      deletedAt: null,
    },
    undefined,
    { tenantId: payload.tenantId },
  )
  if (!prospect) {
    // The Prospect was reverted concurrently with this event → no-op.
    return
  }

  const normalizedCompany = normalizeCompanyName(prospect.companyName)
  const lowercasedEmail = normalizeContactEmail(prospect.contactEmail)
  const now = new Date()
  const knex = em.getKnex()
  await knex('prm_prospect_candidate_index')
    .insert({
      prospect_id: prospect.id,
      organization_id: prospect.organizationId,
      agency_id: prospect.agencyId,
      normalized_company_name: normalizedCompany,
      lowercased_contact_email: lowercasedEmail,
      current_status: prospect.status,
      registered_at: prospect.registeredAt,
      projection_updated_at: now,
    })
    .onConflict('prospect_id')
    .merge({
      organization_id: prospect.organizationId,
      agency_id: prospect.agencyId,
      normalized_company_name: normalizedCompany,
      lowercased_contact_email: lowercasedEmail,
      current_status: prospect.status,
      registered_at: prospect.registeredAt,
      projection_updated_at: now,
    })
}
