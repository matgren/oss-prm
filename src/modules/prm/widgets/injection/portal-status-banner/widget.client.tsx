'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PartnerStatusBanner } from '../../../frontend/[orgSlug]/portal/_components/PartnerStatusBanner'
import { useDashboardData } from '../_shared/useDashboardData'

export default function PortalStatusBannerWidget() {
  const t = useT()
  const { data } = useDashboardData()
  return (
    <PartnerStatusBanner
      status={data?.agency.status}
      t={t}
      messageKey="prm.portal.dashboard.banner.historical"
      message="Your partnership is historical — most actions are paused. Contact OM PartnerOps to reactivate."
    />
  )
}
