import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerRoleAcl,
} from '@open-mercato/core/modules/customer_accounts/data/entities'

/**
 * PRM module setup.
 *
 * - **Backend roles** (`OMPartnerOps`, `OMMarketing`) are merged into staff role ACLs via
 *   `defaultRoleFeatures` (the standard mechanism — see `customer_accounts/setup.ts` for
 *   the role-resolver pattern).
 * - **Customer (portal) roles** (`partner_admin`, `partner_member`) are seeded directly
 *   on tenant creation via `seedDefaults` because:
 *     1. They are NOT in the `customer_accounts` default catalogue (Portal Admin / Buyer / Viewer).
 *     2. The PRM invite handler must look them up by slug at runtime to populate
 *        `roleIds: [resolvedRoleId]` on `CustomerInvitationService.createInvitation`.
 *     3. `partner_admin.customer_assignable = false` is the structural enforcement of
 *        invariant §2.4 (a portal caller cannot self-promote to PartnerAdmin).
 *
 * Invocation is idempotent — duplicate slugs are detected before insert.
 */

const PARTNER_ROLE_DEFINITIONS = [
  {
    name: 'Partner Admin',
    slug: 'partner_admin',
    description:
      'Agency administrator. Full access to own agency profile, members, RFP responses, case studies. Cannot self-assign (customer_assignable = false).',
    isSystem: true,
    customerAssignable: false,
    isDefault: false,
    isPortalAdmin: false,
    features: [
      'portal.partner.access',
      'portal.partner.notifications.view',
      'prm.agency.view',
      'prm.agency.edit',
      'prm.agency.read_admin_fields',
      'prm.agency_member.read',
      'prm.agency_member.manage_partner_member',
      'prm.agency_member.self_edit',
    ] as string[],
  },
  {
    name: 'Partner Member',
    slug: 'partner_member',
    description:
      'Agency contributor. Read-only access to agency profile + members; can self-edit own member row. Customer-assignable (PartnerAdmin invites them).',
    isSystem: true,
    customerAssignable: true,
    isDefault: false,
    isPortalAdmin: false,
    features: [
      'portal.partner.access',
      'portal.partner.notifications.view',
      'prm.agency.view',
      'prm.agency.read_admin_fields',
      'prm.agency_member.read',
      'prm.agency_member.self_edit',
    ] as string[],
  },
] as const

async function seedPartnerRoles(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  for (const roleDef of PARTNER_ROLE_DEFINITIONS) {
    const existing = await em.findOne(CustomerRole, {
      tenantId: scope.tenantId,
      slug: roleDef.slug,
      deletedAt: null,
    })
    if (existing) {
      // Refresh ACL features additively — never remove granted features.
      const acl = await em.findOne(CustomerRoleAcl, {
        role: existing.id as any,
        tenantId: scope.tenantId,
      })
      if (acl) {
        const current = Array.isArray(acl.featuresJson) ? acl.featuresJson : []
        const merged = Array.from(new Set([...current, ...roleDef.features]))
        if (merged.length !== current.length) {
          acl.featuresJson = merged
          em.persist(acl)
        }
      }
      continue
    }

    const role = em.create(CustomerRole, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      name: roleDef.name,
      slug: roleDef.slug,
      description: roleDef.description,
      isSystem: roleDef.isSystem,
      customerAssignable: roleDef.customerAssignable,
      isDefault: roleDef.isDefault,
      createdAt: new Date(),
    } as any)
    em.persist(role)

    const acl = em.create(CustomerRoleAcl, {
      role,
      tenantId: scope.tenantId,
      featuresJson: [...roleDef.features],
      isPortalAdmin: roleDef.isPortalAdmin,
      createdAt: new Date(),
    } as any)
    em.persist(acl)
  }
  await em.flush()
}

export const setup: ModuleSetupConfig = {
  /**
   * Backend roles for OM staff. The OMAdmin and OMPartnerOps personas are layered as
   * additive merges onto existing staff roles — `superadmin` retains everything,
   * `admin` (OMAdmin) gets all PRM, and `employee` (default OM staff) gets read access.
   * For dedicated `OMPartnerOps` / `OMMarketing` named roles, operators create them
   * via the staff-roles UI and grant the appropriate `prm.*` features. Documenting the
   * intended grants here so the role-creator UI shows them as suggested presets.
   */
  defaultRoleFeatures: {
    superadmin: ['prm.*', 'portal.partner.*'],
    admin: ['prm.*', 'portal.partner.*'],
    employee: ['prm.agency.read', 'prm.agency_member.read_all'],
  },

  /**
   * Cross-module customer-role feature defaults. `customer_accounts.setup.seedDefaults`
   * picks these up via `getModules()` and merges them into existing role ACLs (additive only).
   * For partner_admin / partner_member the seed below installs the role + ACL atomically;
   * this declarative form keeps the contract visible at the convention layer too.
   */
  defaultCustomerRoleFeatures: {
    partner_admin: PARTNER_ROLE_DEFINITIONS[0].features,
    partner_member: PARTNER_ROLE_DEFINITIONS[1].features,
  },

  async onTenantCreated({ em, tenantId, organizationId }) {
    await seedPartnerRoles(em as EntityManager, { tenantId, organizationId })
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    await seedPartnerRoles(em as EntityManager, { tenantId, organizationId })
  },
}

export default setup
