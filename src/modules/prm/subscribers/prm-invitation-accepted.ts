import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { AgencyMember } from '../data/entities'
import { safeEmit } from '../lib/safeEmit'

export const metadata = {
  event: 'customer_accounts.invitation.accepted',
  persistent: true,
  id: 'prm-invitation-accepted',
}

type InvitationAcceptedPayload = {
  invitationId: string
  userId: string
  tenantId: string
}

/**
 * `PrmInvitationAcceptedSubscriber`.
 *
 * Triggered after `customer_accounts.acceptInvitation` creates the `CustomerUser` and the
 * `CustomerUserRole` rows. PRM's responsibility is to:
 *   1. Look up the placeholder `AgencyMember` by `invitation_id`.
 *   2. Link `customer_user_id` (immutable thereafter).
 *   3. Set `activated_at = now()`.
 *   4. Emit `prm.agency_member.activated`.
 *
 * Idempotent: the UPDATE matches `customer_user_id IS NULL` so a double delivery is a no-op.
 * Roles are NOT re-assigned here (PROXY-GATE-RESOLUTIONS §Q3 — `acceptInvitation` already did).
 */
export default async function handler(payload: InvitationAcceptedPayload): Promise<void> {
  if (!payload?.invitationId || !payload?.userId || !payload?.tenantId) {
    return
  }
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const member = await findOneWithDecryption(
    em,
    AgencyMember,
    {
      invitationId: payload.invitationId,
      tenantId: payload.tenantId,
      customerUserId: null,
      deletedAt: null,
    },
    undefined,
    { tenantId: payload.tenantId },
  )
  if (!member) {
    // Either the invitation isn't PRM-managed (other module owns it) or the
    // subscriber already ran. Both are no-ops.
    return
  }

  member.customerUserId = payload.userId
  member.activatedAt = new Date()
  member.updatedAt = new Date()
  await em.flush()

  await safeEmit(
    'prm.agency_member.activated',
    {
      agencyId: member.agencyId,
      tenantId: member.tenantId,
      agencyMemberId: member.id,
      customerUserId: payload.userId,
    },
    {
      container,
      context: { agencyId: member.agencyId, agencyMemberId: member.id, invitationId: payload.invitationId },
    },
  )
}
