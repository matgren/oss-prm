import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.prospect.read_own_agency'],
  titleKey: 'prm.portal.prospects.detail.title',
  title: 'Prospect',
  // No `nav` block — detail page is reachable from the list, not the sidebar.
}

export default metadata
