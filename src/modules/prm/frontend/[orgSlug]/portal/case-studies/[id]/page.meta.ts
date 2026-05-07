import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access'],
  titleKey: 'prm.portal.caseStudies.form.title',
  title: 'Case study',
}

export default metadata
