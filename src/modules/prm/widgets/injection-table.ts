import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * PRM module injection table.
 *
 * Replaces the legacy bespoke `frontend/[orgSlug]/portal/dashboard/page.tsx`
 * (which was shadowed by the upstream `@open-mercato/core/portal` dashboard
 * page on the same route) by injecting the PRM-specific WIP / WIC / Tier / MIN
 * cards into the upstream Portal dashboard `portal:dashboard:sections` slot.
 *
 * The historical-partner banner is injected into `portal:dashboard:before` so
 * it renders above the section cards just like in the legacy layout.
 */
export const injectionTable: ModuleInjectionTable = {
  'portal:dashboard:before': [
    { widgetId: 'prm.injection.portal-status-banner', priority: 0 },
  ],
  'portal:dashboard:sections': [
    { widgetId: 'prm.injection.portal-wip', priority: 5 },
    { widgetId: 'prm.injection.portal-wic', priority: 10 },
    { widgetId: 'prm.injection.portal-tier', priority: 15 },
    { widgetId: 'prm.injection.portal-min', priority: 20 },
  ],
}

export default injectionTable
