import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerRoleAcl,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import {
  WorkflowDefinition,
  type WorkflowDefinitionData,
} from '@open-mercato/core/modules/workflows/data/entities'
import { seedTopicsDictionary } from './lib/topicsDictionarySeed'
import { seedIndustriesDictionary } from './lib/industriesDictionarySeed'
import { seedServicesDictionary } from './lib/servicesDictionarySeed'
import { seedTechnologiesDictionary } from './lib/technologiesDictionarySeed'
import { seedPartnersFirstSidebarOrder } from './lib/sidebarPreferenceSeed'
import { seedPrmDemo } from './lib/demoSeed'

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
      // Prospect lifecycle + dashboard (Spec #2 — wip-scoreboard).
      'prm.prospect.read_own_agency',
      'prm.prospect.register',
      'prm.prospect.transition_any_in_agency',
      'prm.prospect.transition_own_authored',
      'prm.dashboard.view',
      'prm.wic.read_own_agency',
      'prm.tier_requirement.read',
      // MIN widget (Spec #3 — attribution-loop).
      'prm.min.read_own_agency',
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
      // Prospect lifecycle + dashboard — author-scoped transitions only (no transition_any_in_agency).
      'prm.prospect.read_own_agency',
      'prm.prospect.register',
      'prm.prospect.transition_own_authored',
      'prm.dashboard.view',
      'prm.wic.read_own_agency',
      'prm.tier_requirement.read',
      // MIN widget (Spec #3 — attribution-loop).
      'prm.min.read_own_agency',
    ] as string[],
  },
] as const

type AttributionSagaSeed = {
  workflowId: string
  workflowName: string
  description?: string | null
  version: number
  enabled: boolean
  metadata?: Record<string, unknown> | null
  definition: WorkflowDefinitionData
}

const __esmDirname = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    // CJS / Jest fallback — file path unavailable; use a process-relative anchor.
    return process.cwd()
  }
})()

function readAttributionSagaSeed(): AttributionSagaSeed | null {
  const candidates = [
    path.join(__esmDirname, 'workflows', 'license-deal-attribution.json'),
    path.join(process.cwd(), 'src', 'modules', 'prm', 'workflows', 'license-deal-attribution.json'),
  ]
  const filePath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!filePath) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as AttributionSagaSeed
  } catch {
    return null
  }
}

async function seedAttributionSagaWorkflow(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  const seed = readAttributionSagaSeed()
  if (!seed) return
  const existing = await em.findOne(WorkflowDefinition, {
    workflowId: seed.workflowId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  if (existing) {
    // Idempotent refresh — keep the latest definition snapshot in case the JSON
    // shipped with this module version drifts from a prior seed.
    if (existing.version !== seed.version || existing.enabled !== seed.enabled) {
      existing.version = seed.version
      existing.enabled = seed.enabled
      existing.definition = seed.definition
      existing.metadata = (seed.metadata ?? null) as typeof existing.metadata
      em.persist(existing)
      await em.flush()
    }
    return
  }
  const def = em.create(WorkflowDefinition, {
    workflowId: seed.workflowId,
    workflowName: seed.workflowName,
    description: seed.description ?? null,
    version: seed.version,
    enabled: seed.enabled,
    definition: seed.definition,
    metadata: (seed.metadata ?? null) as Record<string, unknown> | null,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any)
  em.persist(def)
  await em.flush()
}

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
   *
   * Note for OMMarketing: also grant `dictionaries.manage` (core feature) so staff can
   * extend the seeded `topics` / `industries` / `services` / `technologies` dictionaries
   * via Settings → Module Configs → Dictionaries. The new/edit Marketing Material forms
   * pull those entries through `/api/prm/dictionaries/[key]/entries` (gated by
   * `prm.marketing_material.write`). `admin` already has `dictionaries.manage` from
   * `@open-mercato/core/modules/dictionaries/setup.ts`.
   */
  defaultRoleFeatures: {
    superadmin: ['prm.*', 'portal.partner.*'],
    admin: ['prm.*', 'portal.partner.*'],
    // Spec #2: extend employee with read-only access to the cross-agency Prospect list (B4).
    // OM PartnerOps reuses the `employee` staff role until a dedicated role is provisioned.
    employee: [
      'prm.agency.read',
      'prm.agency_member.read_all',
      'prm.prospect.read_cross_agency',
      // Spec #3: extend employee with read access to LicenseDeals (B5 staff view).
      'prm.license_deal.read',
      // Spec #4: extend employee with B10 WIC import audit-log triage (resolve action).
      'prm.wic.resolve',
      // Spec #5: OM PartnerOps owns RFP authoring + broadcast.
      'prm.rfp.create',
      'prm.rfp.publish',
      // Spec #6: OM PartnerOps owns scoring, selection, and lifecycle. The
      // `prm.rfp.reopen` permission carries the invariant #17 hard guard
      // (`Path-B signed deal locks the RFP`) — even granting the feature
      // does not bypass the runtime check.
      'prm.rfp.score',
      'prm.rfp.select',
      'prm.rfp.close',
      'prm.rfp.reopen',
      // Spec #7: OM PartnerOps reads case studies + marketing materials
      // for support work. Authoring + publication-flag is Marketing-only —
      // create a dedicated `marketing` staff role with `prm.case_study.toggle_publish`
      // and `prm.marketing_material.write` / `prm.marketing_material.publish`
      // via the staff-roles UI. Documented in PRM_ROLE_FEATURE_PRESETS below.
      'prm.case_study.read_all',
      'prm.case_study.write',
      'prm.marketing_material.read',
    ],
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
    await seedAttributionSagaWorkflow(em as EntityManager, { tenantId, organizationId })
    await seedTopicsDictionary(em as EntityManager, { tenantId, organizationId })
    // Spec #1 §1.2 / §2 / §5.5 M3 / §11: Agency profile picklists.
    // Independent dictionaries — order is immaterial. All idempotent.
    await seedIndustriesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedServicesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedTechnologiesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedPartnersFirstSidebarOrder(em as EntityManager, { tenantId })
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    await seedPartnerRoles(em as EntityManager, { tenantId, organizationId })
    await seedAttributionSagaWorkflow(em as EntityManager, { tenantId, organizationId })
    await seedTopicsDictionary(em as EntityManager, { tenantId, organizationId })
    // Spec #1 §1.2 / §2 / §5.5 M3 / §11: Agency profile picklists.
    await seedIndustriesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedServicesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedTechnologiesDictionary(em as EntityManager, { tenantId, organizationId })
    await seedPartnersFirstSidebarOrder(em as EntityManager, { tenantId })
  },

  /**
   * Demo/example data — runs during `mercato init` unless `--no-examples`.
   * Modest fixture set (3 agencies, 4 members, 5 prospects, 2 case studies);
   * idempotent. See `lib/demoSeed.ts`.
   */
  async seedExamples({ em, container, tenantId, organizationId }) {
    await seedPrmDemo(em as EntityManager, container, { tenantId, organizationId })
  },
}

export default setup
