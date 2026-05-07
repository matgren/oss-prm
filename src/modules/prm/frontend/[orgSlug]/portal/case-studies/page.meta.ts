import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access'],
  titleKey: 'prm.portal.caseStudies.title',
  title: 'Case Studies',
  nav: {
    label: 'Case Studies',
    labelKey: 'prm.portal.caseStudies.title',
    group: 'main',
    order: 28,
  },
}

export default metadata
