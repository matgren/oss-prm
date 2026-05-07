import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access'],
  titleKey: 'prm.portal.caseStudies.btn.new',
  title: 'New Case Study',
}

export default metadata
