import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access'],
  titleKey: 'prm.portal.library.title',
  title: 'Marketing Library',
  nav: {
    label: 'Marketing Library',
    labelKey: 'prm.portal.library.title',
    group: 'main',
    order: 30,
  },
}

export default metadata
