import { Megaphone } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.marketing_material.write'],
  pageTitle: 'New Marketing Material',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 151,
  navHidden: true,
  icon: React.createElement(Megaphone, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Partners', labelKey: 'prm.nav.group' },
    { label: 'Marketing Materials', labelKey: 'prm.backend.marketingMaterials.title', href: '/backend/prm/marketing-materials' },
  ],
}

export default metadata
