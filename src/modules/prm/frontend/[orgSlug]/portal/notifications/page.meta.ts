import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'portal.partner.notifications.view'],
  titleKey: 'prm.portal.nav.notifications',
  title: 'Notifications',
  nav: {
    label: 'Notifications',
    labelKey: 'prm.portal.nav.notifications',
    group: 'main',
    order: 100,
  },
}

export default metadata
