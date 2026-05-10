import type { EntityManager } from '@mikro-orm/postgresql'
import { Role } from '@open-mercato/core/modules/auth/data/entities'
import { saveRoleSidebarPreference } from '@open-mercato/core/modules/auth/services/sidebarPreferencesService'
import { SIDEBAR_PREFERENCES_VERSION } from '@open-mercato/shared/modules/navigation/sidebarPreferences'

const STAFF_ROLES_TO_SEED = ['superadmin', 'admin', 'employee'] as const
const SIDEBAR_LOCALES = ['en', 'de', 'es', 'pl'] as const
const PRM_GROUP_KEY = 'prm.nav.group'

/**
 * Pin the Partners group to the top of the backend sidebar for staff roles.
 *
 * Workaround for the upstream gap captured in
 * `~/Documents/OM/agents/tasks/2026-05-10-sidebar-group-order-no-extension-point/README.md`:
 * `@open-mercato/core/auth/lib/backendChrome.tsx` ranks groups via a hardcoded
 * `defaultGroupOrder` list that does not include `prm.nav.group`, so any value
 * declared in `page.meta.ts` cannot lift PRM above core groups. The framework
 * does honor a per-role `RoleSidebarPreference.groupOrder` overlay applied at
 * `applySidebarPreference` time — that's what we write here.
 *
 * Idempotent: `saveRoleSidebarPreference` upserts on
 * `(role, tenantId, locale)`. Safe to run from `onTenantCreated`,
 * `seedDefaults`, and the standalone CLI for existing tenants.
 *
 * Remove this helper (and its callers) once upstream ships a declarative
 * group-rank API and standalone-app migrates to it.
 */
export async function seedPartnersFirstSidebarOrder(
  em: EntityManager,
  scope: { tenantId: string },
): Promise<void> {
  const roles = await em.find(Role, {
    tenantId: scope.tenantId,
    name: { $in: [...STAFF_ROLES_TO_SEED] },
    deletedAt: null,
  })
  for (const role of roles) {
    for (const locale of SIDEBAR_LOCALES) {
      await saveRoleSidebarPreference(
        em,
        { roleId: role.id, tenantId: scope.tenantId, locale },
        {
          version: SIDEBAR_PREFERENCES_VERSION,
          groupOrder: [PRM_GROUP_KEY],
        },
      )
    }
  }
}
