import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.partner.access', 'prm.dashboard.view'],
  titleKey: 'prm.portal.nav.dashboard',
  title: 'Dashboard',
  // Nav entry intentionally omitted to avoid colliding with the core portal
  // module's `frontend/[orgSlug]/portal/dashboard/page.meta.ts` nav entry.
  // Both metas resolve to the same route; PRM's page.tsx wins via module
  // precedence, but the portal nav builder registers every nav block it sees,
  // which produces a duplicate React key on `portal-nav:/[orgSlug]/portal/dashboard`.
  // See upstream issue: framework should dedupe by pattern in buildPortalNav.
}

export default metadata
