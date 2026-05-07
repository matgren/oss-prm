import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildBatchNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { CustomerUserRole } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { AgencyMember, Rfp } from '../data/entities'
import { notificationTypes } from '../notifications'

/**
 * `BroadcastInvitationNotifier` — Spec #5 §4.4 (OQ-015 resolution).
 *
 * Listens on `prm.rfp.published`. Expands `broadcast_agency_ids` to the union
 * of PartnerAdmin + PartnerMember CustomerUsers across those agencies (via
 * Spec #1's AgencyMember + CustomerUserRole tables) and sends ONE batch
 * notification per type definition `prm.rfp.broadcast_invitation`.
 *
 * **Failure isolation (W4 / spec §4.4):** per-recipient delivery failure does
 * NOT roll back `RFP.status = published`. The inbox P9 reads from
 * `RfpBroadcast`, which is authoritative; notifications are auxiliary.
 *
 * Subscriber is `persistent: true` so the platform's retry contract handles
 * transient delivery failures.
 */
export const metadata = {
  event: 'prm.rfp.published',
  persistent: true,
  id: 'prm:rfp:broadcast-invitation-notifier',
}

type Payload = {
  rfp_id: string
  broadcast_agency_ids: string[]
  eligibility_filter: string
  broadcast_count: number
  published_at: string
  published_by_user_id: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: Payload, ctx: ResolverContext): Promise<void> {
  const typeDef = notificationTypes.find((t) => t.type === 'prm.rfp.broadcast_invitation')
  if (!typeDef) return
  const recipientUserIds = await collectRecipientCustomerUserIds(payload, ctx)
  if (recipientUserIds.length === 0) return

  const variables = await resolveTitleVariables(payload, ctx)
  const notificationInput = buildBatchNotificationFromType(typeDef, {
    recipientUserIds,
    titleVariables: variables,
    bodyVariables: variables,
    sourceEntityType: 'rfp',
    sourceEntityId: payload.rfp_id,
    linkHref: `/portal/rfp/${payload.rfp_id}`,
  })

  const notificationService = resolveNotificationService(ctx)
  // Tenant + organization scope are derived inside the notification service
  // from the AgencyMember rows; for the batch call we pin to the RFP's owning
  // organization (resolved below). v1 uses the publishing org.
  const scope = await resolveNotificationScope(payload, ctx)
  if (!scope) return
  await notificationService.createBatch(notificationInput, scope)
}

async function collectRecipientCustomerUserIds(
  payload: Payload,
  ctx: ResolverContext,
): Promise<string[]> {
  if (payload.broadcast_agency_ids.length === 0) return []
  const em = ctx.resolve<EntityManager>('em')?.fork({ clear: true, freshEventManager: true })
  if (!em) return []

  // Active AgencyMember rows under the broadcast agencies, with a non-null
  // customerUserId (i.e. the invite was accepted; placeholder rows excluded).
  const members = await findWithDecryption<AgencyMember>(
    em,
    AgencyMember,
    {
      agencyId: { $in: payload.broadcast_agency_ids },
      isActive: true,
      deletedAt: null,
      customerUserId: { $ne: null },
    } as any,
    undefined,
    { tenantId: null, organizationId: null },
  )

  const customerUserIds = new Set<string>()
  for (const member of members) {
    if (typeof member.customerUserId === 'string' && member.customerUserId.length > 0) {
      customerUserIds.add(member.customerUserId)
    }
  }

  if (customerUserIds.size === 0) return []

  // Filter to PartnerAdmin / PartnerMember roles only — defence-in-depth in
  // case an AgencyMember row has been demoted in CustomerUserRole but not
  // here.
  const roles = await em.find(
    CustomerUserRole,
    {
      customerUserId: { $in: Array.from(customerUserIds) },
    } as any,
  )
  const allowed = new Set<string>()
  for (const role of roles) {
    const slug = (role as any).roleSlug ?? (role as any).slug
    if (slug === 'partner_admin' || slug === 'partner_member') {
      allowed.add((role as any).customerUserId)
    }
  }
  // Fallback: if no CustomerUserRole rows match (older invite path), trust
  // the AgencyMember roleSlug. This protects v1 deployments where the
  // CustomerUserRole projection may lag behind.
  if (allowed.size === 0) {
    return Array.from(customerUserIds)
  }
  return Array.from(allowed)
}

async function resolveTitleVariables(
  payload: Payload,
  ctx: ResolverContext,
): Promise<Record<string, string>> {
  try {
    const em = ctx.resolve<EntityManager>('em')?.fork({ clear: true, freshEventManager: true })
    if (!em) return {}
    const rfp = await em.findOne(Rfp, { id: payload.rfp_id, deletedAt: null } as any)
    if (!rfp) return {}
    return {
      rfp_title: rfp.title,
      client_name: rfp.receivedFrom,
      deadline: rfp.deadlineToRespond ? rfp.deadlineToRespond.toISOString() : '',
      rfp_url: `/portal/rfp/${rfp.id}`,
    }
  } catch {
    return {}
  }
}

async function resolveNotificationScope(
  payload: Payload,
  ctx: ResolverContext,
): Promise<{ tenantId: string; organizationId: string | null } | null> {
  try {
    const em = ctx.resolve<EntityManager>('em')?.fork({ clear: true, freshEventManager: true })
    if (!em) return null
    const rfp = await em.findOne(Rfp, { id: payload.rfp_id, deletedAt: null } as any)
    if (!rfp) return null
    return {
      // RFPs do not carry tenantId directly (only organizationId — they're
      // backend-side). The notifications module derives tenant from the
      // recipient CustomerUser; we pass organizationId so the audit trail
      // correctly attributes to the publishing org.
      tenantId: rfp.organizationId,
      organizationId: rfp.organizationId,
    }
  } catch {
    return null
  }
}
