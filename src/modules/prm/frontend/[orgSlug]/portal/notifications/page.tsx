'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PortalNotificationPanel } from '@open-mercato/ui/portal/components/PortalNotificationPanel'
import { usePortalNotifications } from '@open-mercato/ui/portal/hooks/usePortalNotifications'

/**
 * P12 — Partner portal Notifications page.
 *
 * OQ-010 / OQ-016: thin wrapper over the shipped `PortalNotificationPanel` and
 * `usePortalNotifications` hook (no DataTable / CrudForm in portal). The header bell
 * (`PortalNotificationBell`) is wired into the portal shell separately. This page
 * just keeps the panel rendered inline so users have a stable URL to link to.
 */
export default function PortalNotificationsPage() {
  const t = useT()
  const { notifications, unreadCount, markAsRead, dismiss, markAllRead } = usePortalNotifications()
  // Always-on, non-modal embed of the panel.
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">{t('prm.portal.notifications.title', 'Notifications')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('prm.portal.notifications.subtitle', 'Recent updates from OM PartnerOps and your agency.')}
        </p>
      </header>
      <div className="overflow-hidden rounded-md border">
        <PortalNotificationPanel
          open={true}
          onClose={() => {
            /* embedded — close is a no-op */
          }}
          notifications={notifications}
          unreadCount={unreadCount}
          onMarkAsRead={markAsRead}
          onDismiss={dismiss}
          onMarkAllRead={markAllRead}
          t={t}
        />
      </div>
    </div>
  )
}
