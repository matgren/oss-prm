import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerUser } from '@open-mercato/core/modules/customer_accounts/data/entities'
import type { CustomerSessionService } from '@open-mercato/core/modules/customer_accounts/services/customerSessionService'

/**
 * Bridges PRM `AgencyMember.is_active` to OM core's `CustomerUser.is_active` +
 * session revocation primitive.
 *
 * Why a shared helper rather than two duplicate subscribers: the framework's
 * subscriber metadata is `{ event: string }` (singular) — see
 * `src/modules/prm/subscribers/*.ts`. We ship one subscriber per event and keep
 * the actual sync logic in this helper so both directions are tested in one
 * place and stay symmetric.
 *
 * Idempotency contract:
 *   - `revokePortalAccess` is safe to re-run: if the user is already inactive,
 *     the second flush is a no-op; the second `revokeAllUserSessions` call sets
 *     `sessions_revoked_at` again (later timestamp wins; benign).
 *   - `restorePortalAccess` is safe to re-run: re-flipping `is_active = true`
 *     when it's already true is a no-op. We deliberately do NOT clear
 *     `sessions_revoked_at` — JWTs minted before deactivation stay rejected
 *     even after reactivation, mirroring SPEC-060's intent.
 *
 * Tenant isolation: every CustomerUser lookup carries `tenantId` to
 * `findOneWithDecryption` and a hard `deletedAt: null` filter.
 */
type ContainerLike = {
  resolve: <T = unknown>(name: string) => T
}

type SyncArgs = {
  customerUserId: string | null
  tenantId: string
  container: ContainerLike
}

export type PortalAccessSyncOutcome =
  | { ok: true; effect: 'revoked' | 'restored' | 'no-op' }
  | { ok: false; reason: 'missing_user_id' | 'user_not_found' | 'already_deleted' }

export async function revokePortalAccess(args: SyncArgs): Promise<PortalAccessSyncOutcome> {
  if (!args.customerUserId) return { ok: false, reason: 'missing_user_id' }
  const em = args.container.resolve<EntityManager>('em')
  const user = await findOneWithDecryption(
    em,
    CustomerUser,
    { id: args.customerUserId, tenantId: args.tenantId, deletedAt: null },
    undefined,
    { tenantId: args.tenantId },
  )
  if (!user) return { ok: false, reason: 'user_not_found' }
  if (user.deletedAt) return { ok: false, reason: 'already_deleted' }

  if (user.isActive) {
    user.isActive = false
    em.persist(user)
    await em.flush()
  }

  const sessionService = args.container.resolve<CustomerSessionService>('customerSessionService')
  await sessionService.revokeAllUserSessions(user.id)

  return { ok: true, effect: 'revoked' }
}

export async function restorePortalAccess(args: SyncArgs): Promise<PortalAccessSyncOutcome> {
  if (!args.customerUserId) return { ok: false, reason: 'missing_user_id' }
  const em = args.container.resolve<EntityManager>('em')
  const user = await findOneWithDecryption(
    em,
    CustomerUser,
    { id: args.customerUserId, tenantId: args.tenantId, deletedAt: null },
    undefined,
    { tenantId: args.tenantId },
  )
  if (!user) return { ok: false, reason: 'user_not_found' }
  if (user.deletedAt) return { ok: false, reason: 'already_deleted' }

  if (!user.isActive) {
    user.isActive = true
    em.persist(user)
    await em.flush()
    return { ok: true, effect: 'restored' }
  }
  return { ok: true, effect: 'no-op' }
}
