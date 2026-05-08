import { Building2 } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.agency.read'],
  pageTitle: 'Agencies',
  pageTitleKey: 'prm.nav.agencies',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 15,
  icon: React.createElement(Building2, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
