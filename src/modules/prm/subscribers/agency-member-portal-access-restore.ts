import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { restorePortalAccess } from '../lib/portalAccessSync'

/**
 * `AgencyMemberPortalAccessRestoreSubscriber` (SPEC-2026-05-08 Phase 3).
 *
 * Listens on `prm.agency_member.reactivated` and flips `CustomerUser.is_active`
 * back to true. JWTs minted before the deactivation timestamp stay invalidated
 * (we deliberately do NOT clear `sessions_revoked_at` — see helper docstring).
 *
 * Persistent + idempotent.
 */
export const metadata = {
  event: 'prm.agency_member.reactivated',
  persistent: true,
  id: 'prm-agency-member-portal-access-restore',
}

type Payload = {
  agencyId?: string
  agencyMemberId?: string
  tenantId?: string
  customerUserId?: string | null
}

export default async function handler(payload: Payload): Promise<void> {
  if (!payload?.tenantId || !payload?.customerUserId) return
  const container = await createRequestContainer()
  await restorePortalAccess({
    customerUserId: payload.customerUserId,
    tenantId: payload.tenantId,
    container,
  })
}
