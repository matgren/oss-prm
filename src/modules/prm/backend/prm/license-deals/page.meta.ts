import { Receipt } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.license_deal.read'],
  pageTitle: 'License Deals',
  pageTitleKey: 'prm.licenseDeals.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 130,
  icon: React.createElement(Receipt, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
