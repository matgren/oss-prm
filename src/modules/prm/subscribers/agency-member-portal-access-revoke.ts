import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { revokePortalAccess } from '../lib/portalAccessSync'

/**
 * `AgencyMemberPortalAccessRevokeSubscriber` (SPEC-2026-05-08 Phase 3).
 *
 * Listens on `prm.agency_member.removed` and propagates the deactivation to
 * `CustomerUser.is_active = false` + revokes active sessions via
 * `customerSessionService.revokeAllUserSessions`. After this runs, OM core's
 * `validateUserState` (customer_accounts/lib/customerAuth.ts) rejects both
 * existing JWTs (via `sessions_revoked_at`) and fresh login attempts (via
 * `is_active`).
 *
 * Persistent + idempotent — safe to retry.
 */
export const metadata = {
  event: 'prm.agency_member.removed',
  persistent: true,
  id: 'prm-agency-member-portal-access-revoke',
}

type Payload = {
  agencyId?: string
  agencyMemberId?: string
  tenantId?: string
  customerUserId?: string | null
}

export default async function handler(payload: Payload): Promise<void> {
  if (!payload?.tenantId || !payload?.customerUserId) {
    // Pre-accept member rows have no CustomerUser yet — nothing to revoke.
    return
  }
  const container = await createRequestContainer()
  await revokePortalAccess({
    customerUserId: payload.customerUserId,
    tenantId: payload.tenantId,
    container,
  })
}
