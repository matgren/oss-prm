import { ListChecks } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.rfp.create'],
  pageTitle: 'RFP Broadcasts Audit',
  pageTitleKey: 'prm.rfpAudit.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 145,
  navHidden: true, // Per-RFP page, navigated to from RFP detail. Not in main sidebar.
  icon: React.createElement(ListChecks, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
