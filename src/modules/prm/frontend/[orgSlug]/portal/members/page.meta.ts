import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.agency_member.read'],
  titleKey: 'prm.portal.nav.members',
  title: 'Members',
  nav: {
    label: 'Members',
    labelKey: 'prm.portal.nav.members',
    group: 'main',
    order: 30,
  },
}

export default metadata
