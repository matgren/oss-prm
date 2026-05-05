import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.agency.view'],
  titleKey: 'prm.portal.nav.agency',
  title: 'Agency Profile',
  nav: {
    label: 'Agency Profile',
    labelKey: 'prm.portal.nav.agency',
    group: 'main',
    order: 20,
  },
}

export default metadata
