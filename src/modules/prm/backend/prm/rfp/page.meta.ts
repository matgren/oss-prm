import { Megaphone } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.rfp.create'],
  pageTitle: 'RFPs',
  pageTitleKey: 'prm.rfp.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 125,
  icon: React.createElement(Megaphone, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
