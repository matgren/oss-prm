import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.prospect.register'],
  titleKey: 'prm.portal.prospects.new.title',
  title: 'Register prospect',
}

export default metadata
