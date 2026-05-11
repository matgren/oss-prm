import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Agency, AgencyMember, Prospect, CaseStudy } from '../data/entities'
import type { AgencyService } from './agencyService'
import type { ProspectService } from './prospectService'
import type { CaseStudyService } from './caseStudyService'

/**
 * PRM demo/example data seed — wired into `setup.seedExamples` (OM core
 * convention; runs during `mercato init` unless `--no-examples`).
 *
 * Modest v1 fixture set so a fresh `yarn reinstall` lands with something
 * clickable in every PRM backend page:
 *   - 3 agencies across the tier ladder (each gets its own paired
 *     `directory.organization` via `AgencyService.createAgencyWithOrganization`)
 *   - 4 agency members (Vernon C6 placeholder rows — `customer_user_id` NULL,
 *     i.e. invited-but-not-accepted; enough for the Members tables and as
 *     `registered_by` for prospects)
 *   - 5 prospects (all in `new` — lifecycle variety is v2)
 *   - 2 case-study drafts
 *
 * Deliberately NOT seeded yet (extend when those flows are finished):
 *   license deals (attribution saga), RFPs + broadcasts + responses + scores,
 *   marketing materials (need real `attachments` rows + files on disk),
 *   WIC contributions.
 *
 * Idempotent: every insert is guarded by a natural-ish key lookup, so
 * re-running `mercato init` on an existing DB adds only what is missing.
 */

type Scope = { tenantId: string; organizationId: string }

type AgencySpec = {
  name: string
  slug: string
  tier: 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'
  contractSigned: boolean
  ndaSigned: boolean
  onboarded: boolean
  /** ISO date string `YYYY-MM-DD`, or null for not-yet-anchored partners. */
  partnershipStartDate: string | null
}

type MemberSpec = {
  agencySlug: string
  firstName: string
  lastName: string
  email: string
  roleSlug: 'partner_admin' | 'partner_member'
  roleInAgency: string
  githubProfile: string
}

type ProspectSpec = {
  agencySlug: string
  registeredByEmail: string
  companyName: string
  contactName: string
  contactEmail: string
  source: 'agency_owned' | 'event' | 'other'
  notes: string | null
}

type CaseStudySpec = {
  agencySlug: string
  title: string
  clientName: string
  clientIndustry: string
  clientCountry: string
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
}

const AGENCIES: AgencySpec[] = [
  {
    name: 'Acme AI Partners',
    slug: 'acme-ai',
    tier: 'ai_native_expert',
    contractSigned: true,
    ndaSigned: true,
    onboarded: true,
    partnershipStartDate: '2025-03-01',
  },
  {
    name: 'Bright Labs',
    slug: 'bright-labs',
    tier: 'ai_native',
    contractSigned: true,
    ndaSigned: true,
    onboarded: true,
    partnershipStartDate: '2025-11-01',
  },
  {
    name: 'Nimbus Collective',
    slug: 'nimbus-collective',
    tier: 'om_agency',
    contractSigned: false,
    ndaSigned: false,
    onboarded: false,
    partnershipStartDate: null,
  },
]

const MEMBERS: MemberSpec[] = [
  {
    agencySlug: 'acme-ai',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@acme-ai.example',
    roleSlug: 'partner_admin',
    roleInAgency: 'Managing Partner',
    githubProfile: 'ada-lovelace-demo',
  },
  {
    agencySlug: 'acme-ai',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@acme-ai.example',
    roleSlug: 'partner_member',
    roleInAgency: 'Lead Engineer',
    githubProfile: 'grace-hopper-demo',
  },
  {
    agencySlug: 'bright-labs',
    firstName: 'Linus',
    lastName: 'Torvalds',
    email: 'linus@bright-labs.example',
    roleSlug: 'partner_admin',
    roleInAgency: 'Founder',
    githubProfile: 'linus-torvalds-demo',
  },
  {
    agencySlug: 'nimbus-collective',
    firstName: 'Margaret',
    lastName: 'Hamilton',
    email: 'margaret@nimbus-collective.example',
    roleSlug: 'partner_admin',
    roleInAgency: 'Principal',
    githubProfile: 'margaret-hamilton-demo',
  },
]

const PROSPECTS: ProspectSpec[] = [
  {
    agencySlug: 'acme-ai',
    registeredByEmail: 'ada@acme-ai.example',
    companyName: 'Globex Corporation',
    contactName: 'Hank Scorpio',
    contactEmail: 'hank@globex.example',
    source: 'agency_owned',
    notes: 'Warm intro via existing client. Evaluating an AI rollout.',
  },
  {
    agencySlug: 'acme-ai',
    registeredByEmail: 'ada@acme-ai.example',
    companyName: 'Initech',
    contactName: 'Bill Lumbergh',
    contactEmail: 'bill@initech.example',
    source: 'event',
    notes: 'Met at the AI Native summit.',
  },
  {
    agencySlug: 'bright-labs',
    registeredByEmail: 'linus@bright-labs.example',
    companyName: 'Hooli',
    contactName: 'Gavin Belson',
    contactEmail: 'gavin@hooli.example',
    source: 'agency_owned',
    notes: null,
  },
  {
    agencySlug: 'bright-labs',
    registeredByEmail: 'linus@bright-labs.example',
    companyName: 'Soylent Inc',
    contactName: 'Dana Carvey',
    contactEmail: 'dana@soylent.example',
    source: 'other',
    notes: 'Referred by a partner agency.',
  },
  {
    agencySlug: 'nimbus-collective',
    registeredByEmail: 'margaret@nimbus-collective.example',
    companyName: 'Pied Piper',
    contactName: 'Richard Hendricks',
    contactEmail: 'richard@piedpiper.example',
    source: 'agency_owned',
    notes: 'Early-stage, strong technical fit.',
  },
]

const CASE_STUDIES: CaseStudySpec[] = [
  {
    agencySlug: 'acme-ai',
    title: 'Scaling Globex onto an AI-native platform',
    clientName: 'Globex Corporation',
    clientIndustry: 'manufacturing',
    clientCountry: 'US',
    challengeMarkdown:
      '## Challenge\nGlobex ran a sprawling set of manual approval workflows that could not keep pace with demand.',
    approachMarkdown:
      '## Approach\nWe modeled the workflows in Open Mercato, wired event-driven automations, and layered AI-assisted triage on top.',
    outcomeMarkdown:
      '## Outcome\nApproval cycle time dropped from days to minutes; the team now self-serves new workflows.',
    technologiesUsed: ['open-mercato', 'typescript', 'postgresql'],
    servicesDelivered: ['platform-implementation', 'workflow-automation'],
  },
  {
    agencySlug: 'bright-labs',
    title: 'Bright Labs x Hooli — portal migration',
    clientName: 'Hooli',
    clientIndustry: 'technology',
    clientCountry: 'US',
    challengeMarkdown:
      '## Challenge\nHooli needed to consolidate three partner portals into one extensible surface.',
    approachMarkdown:
      '## Approach\nWe used the Open Mercato portal framework and widget injection to merge the three surfaces without forking core.',
    outcomeMarkdown:
      '## Outcome\nOne portal, role-scoped, with each former team owning their own injected widgets.',
    technologiesUsed: ['open-mercato', 'react'],
    servicesDelivered: ['portal-implementation'],
  },
]

export async function seedPrmDemo(
  em: EntityManager,
  container: AwilixContainer,
  scope: Scope,
): Promise<void> {
  const agencyService = container.resolve('agencyService') as AgencyService
  const prospectService = container.resolve('prospectService') as ProspectService
  const caseStudyService = container.resolve('caseStudyService') as CaseStudyService

  // --- Agencies (each creates its own paired directory.organization) ---------
  const agencyBySlug = new Map<string, Agency>()
  for (const spec of AGENCIES) {
    const existing = await em.findOne(Agency, {
      tenantId: scope.tenantId,
      slug: spec.slug,
      deletedAt: null,
    } as any)
    if (existing) {
      agencyBySlug.set(spec.slug, existing)
      continue
    }
    const agency = await agencyService.createAgencyWithOrganization(
      {
        name: spec.name,
        slug: spec.slug,
        tier: spec.tier,
        status: 'active',
        contractSigned: spec.contractSigned,
        ndaSigned: spec.ndaSigned,
        onboarded: spec.onboarded,
        partnershipStartDate: spec.partnershipStartDate,
      },
      { tenantId: scope.tenantId, userId: null },
    )
    agencyBySlug.set(spec.slug, agency)
  }

  // --- Agency members (Vernon C6 placeholder rows) --------------------------
  const memberByEmail = new Map<string, AgencyMember>()
  for (const spec of MEMBERS) {
    const agency = agencyBySlug.get(spec.agencySlug)
    if (!agency) continue
    const emailLookup = spec.email.toLowerCase()
    let member = await em.findOne(AgencyMember, {
      agencyId: agency.id,
      emailLookup,
      deletedAt: null,
    } as any)
    if (!member) {
      member = em.create(AgencyMember, {
        tenantId: scope.tenantId,
        agencyId: agency.id,
        customerUserId: null,
        invitationId: null,
        email: spec.email,
        emailLookup,
        firstName: spec.firstName,
        lastName: spec.lastName,
        roleInAgency: spec.roleInAgency,
        githubProfile: spec.githubProfile,
        isActive: true,
        invitedAt: new Date(),
        activatedAt: null,
        agencyStatus: 'active',
        roleSlug: spec.roleSlug,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as any)
      em.persist(member)
      await em.flush()
    }
    memberByEmail.set(spec.email.toLowerCase(), member)
  }

  // --- Prospects (all `new`) ------------------------------------------------
  for (const spec of PROSPECTS) {
    const agency = agencyBySlug.get(spec.agencySlug)
    const member = memberByEmail.get(spec.registeredByEmail.toLowerCase())
    if (!agency || !member) continue
    const contactEmailLower = spec.contactEmail.toLowerCase()
    const existing = await em.findOne(Prospect, {
      agencyId: agency.id,
      contactEmail: contactEmailLower,
    } as any)
    if (existing) continue
    await prospectService.register(
      {
        companyName: spec.companyName,
        contactName: spec.contactName,
        contactEmail: contactEmailLower,
        source: spec.source,
        notes: spec.notes,
      },
      {
        tenantId: scope.tenantId,
        organizationId: agency.organizationId,
        agencyId: agency.id,
        registeredByAgencyMemberId: member.id,
      },
    )
  }

  // --- Case-study drafts ----------------------------------------------------
  for (const spec of CASE_STUDIES) {
    const agency = agencyBySlug.get(spec.agencySlug)
    if (!agency) continue
    const existing = await em.findOne(CaseStudy, {
      agencyId: agency.id,
      title: spec.title,
    } as any)
    if (existing) continue
    await caseStudyService.createDraft(
      {
        title: spec.title,
        clientName: spec.clientName,
        clientIndustry: spec.clientIndustry,
        clientCountry: spec.clientCountry,
        challengeMarkdown: spec.challengeMarkdown,
        approachMarkdown: spec.approachMarkdown,
        outcomeMarkdown: spec.outcomeMarkdown,
        technologiesUsed: spec.technologiesUsed,
        servicesDelivered: spec.servicesDelivered,
      },
      { organizationId: agency.organizationId, agencyId: agency.id },
    )
  }
}
