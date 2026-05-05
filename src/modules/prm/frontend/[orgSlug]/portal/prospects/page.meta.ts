import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.prospect.read_own_agency'],
  titleKey: 'prm.portal.nav.prospects',
  title: 'Prospects',
  nav: {
    label: 'Prospects',
    labelKey: 'prm.portal.nav.prospects',
    group: 'main',
    order: 30,
  },
}

export default metadata
