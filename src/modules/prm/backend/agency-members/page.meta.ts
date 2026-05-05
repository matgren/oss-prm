import { Users } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.agency_member.read_all'],
  pageTitle: 'All Members',
  pageTitleKey: 'prm.nav.members',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 110,
  icon: React.createElement(Users, { className: 'size-4' }),
}

export default metadata
