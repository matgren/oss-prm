import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.dashboard.view'],
  titleKey: 'prm.portal.nav.dashboard',
  title: 'Dashboard',
  nav: {
    label: 'Dashboard',
    labelKey: 'prm.portal.nav.dashboard',
    group: 'main',
    order: 10,
  },
}

export default metadata
