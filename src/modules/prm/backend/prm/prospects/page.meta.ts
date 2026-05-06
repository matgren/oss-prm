import { Target } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.prospect.read_cross_agency'],
  pageTitle: 'Prospects',
  pageTitleKey: 'prm.prospects.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 120,
  icon: React.createElement(Target, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
