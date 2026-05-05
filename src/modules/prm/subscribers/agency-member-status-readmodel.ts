import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { AgencyMember } from '../data/entities'

export const metadata = {
  event: 'prm.agency.status_changed',
  persistent: true,
  id: 'prm-agency-member-status-readmodel',
}

type AgencyStatusChangedPayload = {
  agencyId: string
  tenantId: string
  fromStatus: string
  toStatus: string
}

/**
 * `AgencyMemberStatusReadModelSubscriber` (Vernon C3).
 *
 * Maintains the denormalised `agency_status` column on every `AgencyMember` row when the
 * owning Agency transitions between `active` and `historical`. Downstream aggregates
 * (Prospect, CaseStudy, etc. — Phase 2+) ship parallel subscribers; in Phase 1 only
 * member rows are wired.
 */
export default async function handler(payload: AgencyStatusChangedPayload): Promise<void> {
  if (!payload?.agencyId || !payload?.toStatus) return
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const members = await em.find(AgencyMember, {
    agencyId: payload.agencyId,
    tenantId: payload.tenantId,
    deletedAt: null,
  })
  if (members.length === 0) return
  for (const member of members) {
    member.agencyStatus = payload.toStatus
    member.updatedAt = new Date()
    em.persist(member)
  }
  await em.flush()
}
