import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildBatchNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { CustomerUserRole } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { AgencyMember, Rfp, RfpBroadcast } from '../data/entities'
import { notificationTypes } from '../notifications'

/**
 * `RfpSelectionNotifier` — Spec #6 §4.3 (OQ-015 fan-out).
 *
 * Listens on `prm.rfp.selection_made` AND `prm.rfp.selection_changed`.
 * For each event:
 *   - Resolves PartnerAdmin/Member CustomerUsers of the WINNER agency
 *     and sends ONE batch notification of type `prm.rfp.selected`.
 *   - Resolves PartnerAdmin/Member CustomerUsers of the NON-WINNER
 *     broadcast agencies (i.e. every Agency that received the broadcast
 *     but didn't win) and sends ONE batch notification of type
 *     `prm.rfp.not_selected`.
 *
 * **Failure isolation:** per-recipient delivery failure does NOT roll
 * back the RFP selection. The B11 audit page is authoritative;
 * notifications are auxiliary.
 *
 * Re-selection semantics (`selection_changed`): the prior winner
 * receives `prm.rfp.not_selected` (they're no longer the winner) and
 * the new winner receives `prm.rfp.selected`. The non-winner pool is
 * recomputed from current `RfpBroadcast` rows minus the new winner.
 */
export const metadata = {
  event: ['prm.rfp.selection_made', 'prm.rfp.selection_changed'],
  persistent: true,
  id: 'prm:rfp:selection-notifications',
}

type SelectionMadePayload = {
  rfp_id: string
  winner_agency_id: string
  winner_rfp_response_id: string
  runners_up_agency_ids: string[]
  selection_reasoning: string
  decided_by_user_id: string
}

type SelectionChangedPayload = {
  rfp_id: string
  from_agency_id: string
  to_agency_id: string
  from_rfp_response_id: string
  to_rfp_response_id: string
  reason: string
  changed_by_user_id: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  payload: SelectionMadePayload | SelectionChangedPayload,
  ctx: ResolverContext,
): Promise<void> {
  const winnerAgencyId =
    'winner_agency_id' in payload ? payload.winner_agency_id : payload.to_agency_id
  const rfpId = payload.rfp_id

  const em = ctx.resolve<EntityManager>('em')?.fork({ clear: true, freshEventManager: true })
  if (!em) return

  // Pull all broadcast agency ids — non-winner pool = broadcast set − winner.
  const broadcasts = await em.find(
    RfpBroadcast,
    { rfpId } as any,
    { fields: ['agencyId'] } as any,
  )
  const broadcastAgencyIds = Array.from(new Set(broadcasts.map((b) => b.agencyId)))
  const nonWinnerAgencyIds = broadcastAgencyIds.filter((id) => id !== winnerAgencyId)

  // Resolve RFP for title / link variables.
  const rfp = await em.findOne(Rfp, { id: rfpId, deletedAt: null } as any)
  if (!rfp) return
  const baseVars: Record<string, string> = {
    rfp_title: rfp.title,
    client_name: rfp.receivedFrom,
    rfp_url: `/portal/rfp/${rfp.id}`,
  }
  const scope = { tenantId: rfp.organizationId, organizationId: rfp.organizationId }

  const winnerType = notificationTypes.find((t) => t.type === 'prm.rfp.selected')
  const notSelectedType = notificationTypes.find((t) => t.type === 'prm.rfp.not_selected')
  if (!winnerType || !notSelectedType) return

  const notificationService = resolveNotificationService(ctx)

  // Winner fan-out.
  const winnerUserIds = await collectAgencyCustomerUserIds(em, [winnerAgencyId])
  if (winnerUserIds.length > 0) {
    const winnerInput = buildBatchNotificationFromType(winnerType, {
      recipientUserIds: winnerUserIds,
      titleVariables: baseVars,
      bodyVariables: baseVars,
      sourceEntityType: 'rfp',
      sourceEntityId: rfp.id,
      linkHref: baseVars.rfp_url,
    })
    await notificationService.createBatch(winnerInput, scope)
  }

  // Non-winner fan-out (incl. prior winner on selection_changed).
  if (nonWinnerAgencyIds.length > 0) {
    const nonWinnerUserIds = await collectAgencyCustomerUserIds(em, nonWinnerAgencyIds)
    if (nonWinnerUserIds.length > 0) {
      const notSelectedInput = buildBatchNotificationFromType(notSelectedType, {
        recipientUserIds: nonWinnerUserIds,
        titleVariables: baseVars,
        bodyVariables: baseVars,
        sourceEntityType: 'rfp',
        sourceEntityId: rfp.id,
        linkHref: baseVars.rfp_url,
      })
      await notificationService.createBatch(notSelectedInput, scope)
    }
  }
}

async function collectAgencyCustomerUserIds(
  em: EntityManager,
  agencyIds: string[],
): Promise<string[]> {
  if (agencyIds.length === 0) return []
  const members = await findWithDecryption<AgencyMember>(
    em,
    AgencyMember,
    {
      agencyId: { $in: agencyIds },
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

  const roles = await em.find(
    CustomerUserRole,
    { customerUserId: { $in: Array.from(customerUserIds) } } as any,
  )
  const allowed = new Set<string>()
  for (const role of roles) {
    const slug = (role as any).roleSlug ?? (role as any).slug
    if (slug === 'partner_admin' || slug === 'partner_member') {
      allowed.add((role as any).customerUserId)
    }
  }
  // Fallback: same as Spec #5's invitation subscriber — trust AgencyMember
  // rows when CustomerUserRole projection lags.
  if (allowed.size === 0) return Array.from(customerUserIds)
  return Array.from(allowed)
}
