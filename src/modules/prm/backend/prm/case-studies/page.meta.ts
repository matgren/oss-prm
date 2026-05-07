import { BookOpen } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.case_study.read_all'],
  pageTitle: 'Case Studies',
  pageTitleKey: 'prm.backend.caseStudies.title',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 140,
  icon: React.createElement(BookOpen, { className: 'size-4' }),
  breadcrumb: [{ label: 'Partners', labelKey: 'prm.nav.group' }],
}

export default metadata
