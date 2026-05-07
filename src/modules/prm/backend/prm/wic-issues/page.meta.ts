import { AlertTriangle } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.wic.resolve'],
  pageTitle: 'WIC Import Issues',
  pageTitleKey: 'prm.wicIssues.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 140,
  icon: React.createElement(AlertTriangle, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
