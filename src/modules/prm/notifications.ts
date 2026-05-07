import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

/**
 * PRM notification type definitions (Spec #5 §4.4).
 *
 * v1 seeds ONE type — `prm.rfp.broadcast_invitation` — fan-out per OQ-015.
 * Variables interpolated by the notifications module: `rfp_title`,
 * `client_name`, `deadline`, `rfp_url`. The titleKey + bodyKey resolve via
 * the existing PRM i18n bundle at `src/modules/prm/i18n/`.
 *
 * Default channels (`portal_inbox`, `email`) are not declared on
 * NotificationTypeDefinition itself in this OM version — they ship as a
 * companion `delivery-config` entry handled by the notifications module.
 * For v1 we rely on the module's defaults; per-type overrides become a
 * Spec #6 concern.
 */
export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'prm.rfp.broadcast_invitation',
    module: 'prm',
    titleKey: 'prm.notifications.rfp.broadcast_invitation.title',
    bodyKey: 'prm.notifications.rfp.broadcast_invitation.body',
    icon: 'inbox',
    severity: 'info',
    actions: [],
    primaryActionId: undefined,
    expiresAfterHours: 24 * 60, // 60 days — RFPs are open for weeks at a time.
  },
]

export default notificationTypes
