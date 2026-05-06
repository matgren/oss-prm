import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access'],
  titleKey: 'prm.portal.nav.rfp',
  title: 'RFPs',
  nav: {
    label: 'RFPs',
    labelKey: 'prm.portal.nav.rfp',
    group: 'main',
    order: 25,
  },
}

export default metadata
