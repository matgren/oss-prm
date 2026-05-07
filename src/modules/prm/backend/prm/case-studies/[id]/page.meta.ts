import { BookOpen } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['prm.case_study.read_all'],
  pageTitle: 'Case Study',
  pageGroup: 'Partners',
  pageGroupKey: 'prm.nav.group',
  pageOrder: 141,
  navHidden: true,
  icon: React.createElement(BookOpen, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Partners', labelKey: 'prm.nav.group' },
    { label: 'Case Studies', labelKey: 'prm.backend.caseStudies.title', href: '/backend/prm/case-studies' },
  ],
}

export default metadata
