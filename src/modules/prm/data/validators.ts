import { z } from 'zod'

/** Allowed agency tiers (admin-managed in v1). */
export const AGENCY_TIERS = ['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core'] as const
export const AGENCY_STATUSES = ['active', 'historical'] as const
export const TEAM_SIZE_BUCKETS = ['1-5', '6-20', '21-50', '51-100', '100+'] as const
export const ROLE_SLUGS = ['partner_admin', 'partner_member'] as const

export type AgencyTier = (typeof AGENCY_TIERS)[number]
export type AgencyStatus = (typeof AGENCY_STATUSES)[number]
export type TeamSizeBucket = (typeof TEAM_SIZE_BUCKETS)[number]
export type AgencyRoleSlug = (typeof ROLE_SLUGS)[number]

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const githubHandleRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/

const dictionaryIdArray = z.array(z.string().uuid()).default([])

/** Backend create-agency payload (US1.1). */
export const createAgencySchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(slugRegex, 'prm.errors.invalidSlug'),
  tier: z.enum(AGENCY_TIERS).default('om_agency'),
  headquartersCountry: z.string().length(2).regex(/^[A-Z]{2}$/, 'prm.errors.invalidCountry'),
})

/** Backend partial update payload (US1.1, US1.3, US1.7). */
export const updateAgencyBackendSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(8_000).nullable().optional(),
    websiteUrl: z.string().url().max(500).nullable().optional(),
    logoUrl: z.string().max(2_000).nullable().optional(),
    headquartersCountry: z.string().length(2).regex(/^[A-Z]{2}$/).optional(),
    headquartersCity: z.string().max(120).nullable().optional(),
    teamSizeBucket: z.enum(TEAM_SIZE_BUCKETS).nullable().optional(),
    industries: dictionaryIdArray.optional(),
    services: dictionaryIdArray.optional(),
    techCapabilities: dictionaryIdArray.optional(),
    tier: z.enum(AGENCY_TIERS).optional(),
    status: z.enum(AGENCY_STATUSES).optional(),
    contractSigned: z.boolean().optional(),
    ndaSigned: z.boolean().optional(),
    onboarded: z.boolean().optional(),
  })
  .strict()

/**
 * Portal partial update payload (US2.1).
 *
 * **Admin-only field guard (invariant #6)** is enforced at the route layer; the schema
 * still enumerates them as `z.never()` so a passthrough body is rejected with a structured
 * error (rather than silently dropped).
 */
export const updateAgencyPortalSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(8_000).nullable().optional(),
    websiteUrl: z.string().url().max(500).nullable().optional(),
    logoUrl: z.string().max(2_000).nullable().optional(),
    headquartersCity: z.string().max(120).nullable().optional(),
    teamSizeBucket: z.enum(TEAM_SIZE_BUCKETS).nullable().optional(),
    industries: dictionaryIdArray.optional(),
    services: dictionaryIdArray.optional(),
    techCapabilities: dictionaryIdArray.optional(),
  })
  .strict()

/** Set of admin-only field keys (invariant #6). Mirrored by the portal API interceptor. */
export const ADMIN_ONLY_AGENCY_FIELDS = [
  'tier',
  'status',
  'contractSigned',
  'ndaSigned',
  'onboarded',
  // Snake-case mirrors that may arrive over-the-wire from older clients.
  'contract_signed',
  'nda_signed',
] as const

export const inviteAgencyMemberSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().max(254),
  githubProfile: z
    .string()
    .max(64)
    .regex(githubHandleRegex, 'prm.errors.invalidGithubHandle')
    .nullable()
    .optional(),
  roleSlug: z.enum(ROLE_SLUGS),
})

/** Portal invite payload — role is implicit `partner_member` (§3.2.4). */
export const portalInviteAgencyMemberSchema = inviteAgencyMemberSchema
  .omit({ roleSlug: true })
  .extend({
    roleSlug: z.enum(['partner_member']).default('partner_member').optional(),
  })

export const updateAgencyMemberBackendSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    roleInAgency: z.string().max(120).nullable().optional(),
    githubProfile: z
      .string()
      .max(64)
      .regex(githubHandleRegex, 'prm.errors.invalidGithubHandle')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    roleSlug: z.enum(ROLE_SLUGS).optional(),
  })
  .strict()

export const updateAgencyMemberPortalSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    roleInAgency: z.string().max(120).nullable().optional(),
    githubProfile: z
      .string()
      .max(64)
      .regex(githubHandleRegex, 'prm.errors.invalidGithubHandle')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type CreateAgencyInput = z.infer<typeof createAgencySchema>
export type UpdateAgencyBackendInput = z.infer<typeof updateAgencyBackendSchema>
export type UpdateAgencyPortalInput = z.infer<typeof updateAgencyPortalSchema>
export type InviteAgencyMemberInput = z.infer<typeof inviteAgencyMemberSchema>
export type PortalInviteAgencyMemberInput = z.infer<typeof portalInviteAgencyMemberSchema>
export type UpdateAgencyMemberBackendInput = z.infer<typeof updateAgencyMemberBackendSchema>
export type UpdateAgencyMemberPortalInput = z.infer<typeof updateAgencyMemberPortalSchema>

/* -------------------------------------------------------------------------- */
/* Prospect (Spec #2 — wip-scoreboard)                                        */
/* -------------------------------------------------------------------------- */

/** Prospect source enum — FROZEN (cross-spec contract for Spec #3). */
export const PROSPECT_SOURCES = ['agency_owned', 'event', 'other'] as const
/** Prospect status enum — FROZEN (cross-spec contract). 6-state machine per invariant #12. */
export const PROSPECT_STATUSES = [
  'new',
  'qualified',
  'contacted',
  'won',
  'lost',
  'dormant',
] as const
/** Statuses a portal user may transition to (won is system-only). */
export const PROSPECT_PORTAL_TRANSITIONS = [
  'qualified',
  'contacted',
  'lost',
  'dormant',
] as const

export type ProspectSource = (typeof PROSPECT_SOURCES)[number]
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]
export type ProspectPortalTransition = (typeof PROSPECT_PORTAL_TRANSITIONS)[number]

/**
 * State-machine transition matrix (invariant #12).
 * Map from `currentStatus` to the set of allowed next statuses.
 * `won` reachable only when actor is `system` — guarded in the aggregate.
 */
export const PROSPECT_TRANSITIONS: Readonly<Record<ProspectStatus, readonly ProspectStatus[]>> = {
  new: ['qualified', 'lost'],
  qualified: ['contacted', 'won', 'lost'],
  contacted: ['won', 'lost', 'dormant'],
  dormant: ['qualified', 'lost'],
  won: [], // terminal
  lost: [], // terminal
}

/** POST /api/prm/portal/prospects — register a new Prospect (US3.1). */
export const registerProspectSchema = z
  .object({
    companyName: z.string().min(1).max(200),
    contactName: z.string().min(1).max(150),
    contactEmail: z.string().email().max(200),
    source: z.enum(PROSPECT_SOURCES).default('agency_owned'),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict()

/** PATCH /api/prm/portal/prospects/{id} — discriminated edit-or-transition body. */
export const updateProspectEditSchema = z
  .object({
    kind: z.literal('edit'),
    companyName: z.string().min(1).max(200).optional(),
    contactName: z.string().min(1).max(150).optional(),
    contactEmail: z.string().email().max(200).optional(),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict()

export const updateProspectTransitionSchema = z
  .object({
    kind: z.literal('transition'),
    toStatus: z.enum(PROSPECT_PORTAL_TRANSITIONS),
    lostReason: z.string().min(10).max(1_000).optional(),
    /** Optimistic concurrency token = `status_changed_at` ISO-8601 string. */
    ifMatchStatusChangedAt: z.string().min(1),
  })
  .strict()

export const updateProspectSchema = z.discriminatedUnion('kind', [
  updateProspectEditSchema,
  updateProspectTransitionSchema,
])

/** Backend B4 list filters (cross-agency, OM staff). */
export const listProspectsBackendSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  agencyId: z.string().uuid().optional(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  /** Server normalizes input the same way as the index column. */
  normalizedCompanyName: z.string().trim().max(200).optional(),
  /** Server lowercases input. */
  lowercasedContactEmail: z.string().trim().max(200).optional(),
})

/** Portal P5 list filters (own-agency). */
export const listProspectsPortalSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(PROSPECT_STATUSES).optional(),
  source: z.enum(PROSPECT_SOURCES).optional(),
  /** YYYY-MM filter on registered_at. */
  registeredMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
})

export type RegisterProspectInput = z.infer<typeof registerProspectSchema>
export type UpdateProspectEditInput = z.infer<typeof updateProspectEditSchema>
export type UpdateProspectTransitionInput = z.infer<typeof updateProspectTransitionSchema>
export type UpdateProspectInput = z.infer<typeof updateProspectSchema>
export type ListProspectsBackendInput = z.infer<typeof listProspectsBackendSchema>
export type ListProspectsPortalInput = z.infer<typeof listProspectsPortalSchema>

/**
 * Normalize a company name for the `prm_prospect_candidate_index` projection.
 * Lowercased, trimmed, punctuation stripped, internal whitespace collapsed.
 */
export function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    // Strip punctuation/symbols (keep letters, digits, whitespace).
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase + trim normalization for the contact-email candidate-search column. */
export function normalizeContactEmail(value: string): string {
  return value.trim().toLowerCase()
}
