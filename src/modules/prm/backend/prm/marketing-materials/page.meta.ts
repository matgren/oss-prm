import { Megaphone } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.marketing_material.read'],
  pageTitle: 'Marketing Materials',
  pageTitleKey: 'prm.backend.marketingMaterials.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 150,
  icon: React.createElement(Megaphone, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
