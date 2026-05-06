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

/* -------------------------------------------------------------------------- */
/* LicenseDeal (Spec #3 — attribution-loop)                                   */
/* -------------------------------------------------------------------------- */

/** LicenseDeal status enum — FROZEN (cross-spec contract for Specs #5/#6). */
export const LICENSE_DEAL_STATUSES = ['pending', 'signed', 'active', 'churned'] as const
/** Attribution path enum — FROZEN. `none` for unattributed `pending` deals. */
export const LICENSE_DEAL_ATTRIBUTION_PATHS = ['A', 'B', 'C', 'none'] as const
/** Attribution source enum — FROZEN. Mirrors the path with human-readable labels. */
export const LICENSE_DEAL_ATTRIBUTION_SOURCES = ['prospect', 'rfp', 'direct'] as const
/** Status states that lock attribution per invariant #7. */
export const LICENSE_DEAL_FROZEN_STATUSES = ['active', 'churned'] as const

export type LicenseDealStatus = (typeof LICENSE_DEAL_STATUSES)[number]
export type LicenseDealAttributionPath = (typeof LICENSE_DEAL_ATTRIBUTION_PATHS)[number]
export type LicenseDealAttributionSource = (typeof LICENSE_DEAL_ATTRIBUTION_SOURCES)[number]

/**
 * Forward status transitions allowed by the aggregate. `pending → signed → active`
 * is the happy path; `churned` is terminal. `pending → churned` is rejected
 * (a deal must reach `signed` before it can churn). US4.4b (`unreverse-status`)
 * provides the bypass for `active → signed` and `signed → pending`.
 */
export const LICENSE_DEAL_TRANSITIONS: Readonly<Record<LicenseDealStatus, readonly LicenseDealStatus[]>> = {
  pending: ['signed'],
  signed: ['active', 'churned'],
  active: ['churned'],
  churned: [],
}

/** B5 list filters. */
export const listLicenseDealsBackendSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(LICENSE_DEAL_STATUSES).optional(),
  attributionPath: z.enum(LICENSE_DEAL_ATTRIBUTION_PATHS).optional(),
  agencyId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
})

/** POST /api/backend/prm/license-deals — creates a `pending` deal (no auto-attribution). */
export const createLicenseDealSchema = z
  .object({
    licenseIdentifier: z.string().min(2).max(120),
    clientCompanyName: z.string().min(1).max(200),
    clientIndustry: z.string().max(120).nullable().optional(),
    type: z.string().max(40).default('enterprise'),
    isRenewal: z.boolean().default(false),
    previousLicenseDealId: z.string().uuid().nullable().optional(),
    annualValueUsd: z
      .union([z.number().nonnegative().max(1e12), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
      .nullable()
      .optional(),
    monthlyLicenseAmount: z
      .union([z.number().nonnegative().max(1e10), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
      .nullable()
      .optional(),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict()

/** PUT /api/backend/prm/license-deals/{id} — non-attribution edits only. */
export const updateLicenseDealSchema = z
  .object({
    licenseIdentifier: z.string().min(2).max(120).optional(),
    clientCompanyName: z.string().min(1).max(200).optional(),
    clientIndustry: z.string().max(120).nullable().optional(),
    type: z.string().max(40).optional(),
    isRenewal: z.boolean().optional(),
    previousLicenseDealId: z.string().uuid().nullable().optional(),
    annualValueUsd: z
      .union([z.number().nonnegative().max(1e12), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
      .nullable()
      .optional(),
    monthlyLicenseAmount: z
      .union([z.number().nonnegative().max(1e10), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
      .nullable()
      .optional(),
    notes: z.string().max(10_000).nullable().optional(),
    /** Optimistic concurrency token — `version` returned by GET. */
    ifMatchVersion: z.number().int().nonnegative().optional(),
  })
  .strict()

/** Discriminated input for `/license-deals/{id}/attribute`. */
export const attributePathASchema = z
  .object({
    attribution_path: z.literal('A'),
    prospect_id: z.string().uuid(),
    /** Echoed back so the server can detect override (when picked != default). */
    golden_rule_default_prospect_id: z.string().uuid(),
    /** Required iff non-default pick. Server enforces. */
    attribution_reasoning: z.string().min(1).max(2_000).optional(),
    competing_prospect_ids_to_retire: z.array(z.string().uuid()).default([]),
  })
  .strict()

export const attributePathBSchema = z
  .object({
    attribution_path: z.literal('B'),
    rfp_id: z.string().uuid(),
  })
  .strict()

export const attributePathCSchema = z
  .object({
    attribution_path: z.literal('C'),
    /** Server resolves to the chosen Agency. */
    attributed_agency_id: z.string().uuid(),
    /** Required for Path C audit. */
    attribution_reasoning: z.string().min(1).max(2_000),
  })
  .strict()

export const attributeLicenseDealSchema = z.discriminatedUnion('attribution_path', [
  attributePathASchema,
  attributePathBSchema,
  attributePathCSchema,
])

/** POST /api/backend/prm/license-deals/{id}/reverse — reassigns or unattributes. */
export const reverseLicenseDealSchema = z.object({
  reason: z.string().min(10).max(2_000),
  /** Optional new attribution. When omitted → unattribute (back to `pending` + `none`). */
  newAttribution: attributeLicenseDealSchema.optional(),
})

/** POST /api/backend/prm/license-deals/{id}/unreverse-status — US4.4b scoped bypass. */
export const unreverseLicenseDealStatusSchema = z.object({
  toStatus: z.enum(['signed', 'pending']),
  reason: z.string().min(10).max(2_000),
})

/** POST /api/backend/prm/license-deals/{id}/transition — explicit forward status moves. */
export const transitionLicenseDealStatusSchema = z.object({
  toStatus: z.enum(LICENSE_DEAL_STATUSES),
  reason: z.string().min(1).max(2_000).optional(),
  ifMatchVersion: z.number().int().nonnegative().optional(),
})

/** Portal `/api/portal/min` query. */
export const portalMinQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(3000).optional(),
})

export type CreateLicenseDealInput = z.infer<typeof createLicenseDealSchema>
export type UpdateLicenseDealInput = z.infer<typeof updateLicenseDealSchema>
export type AttributeLicenseDealInput = z.infer<typeof attributeLicenseDealSchema>
export type AttributePathAInput = z.infer<typeof attributePathASchema>
export type AttributePathBInput = z.infer<typeof attributePathBSchema>
export type AttributePathCInput = z.infer<typeof attributePathCSchema>
export type ReverseLicenseDealInput = z.infer<typeof reverseLicenseDealSchema>
export type UnreverseLicenseDealStatusInput = z.infer<typeof unreverseLicenseDealStatusSchema>
export type TransitionLicenseDealStatusInput = z.infer<typeof transitionLicenseDealStatusSchema>
export type ListLicenseDealsBackendInput = z.infer<typeof listLicenseDealsBackendSchema>
export type PortalMinQueryInput = z.infer<typeof portalMinQuerySchema>

/** Maps a `LicenseDeal.attributionPath` to its `attribution_source` peer. */
export function pathToAttributionSource(
  path: LicenseDealAttributionPath,
): LicenseDealAttributionSource {
  switch (path) {
    case 'A':
      return 'prospect'
    case 'B':
      return 'rfp'
    case 'C':
      return 'direct'
    case 'none':
    default:
      return 'direct'
  }
}

/** Builds the saga correlation key — license_deal_id + ':' + attribution_source. */
export function licenseDealCorrelationKey(
  licenseDealId: string,
  attributionSource: LicenseDealAttributionSource,
): string {
  return `${licenseDealId}:${attributionSource}`
}

/** Returns true when the LicenseDeal status freezes attribution (invariant #7). */
export function isAttributionFrozen(status: string): boolean {
  return (LICENSE_DEAL_FROZEN_STATUSES as readonly string[]).includes(status)
}

/* ------------------------------------------------------------------ *
 * RFP broadcast & response (Spec #5)                                  *
 * ------------------------------------------------------------------ */

export const RFP_STATUSES = ['draft', 'published', 'scoring', 'selection_made', 'closed'] as const
export type RfpStatus = (typeof RFP_STATUSES)[number]

export const RFP_ELIGIBILITY_FILTERS = ['all_active', 'by_min_tier', 'explicit'] as const
export type RfpEligibilityFilter = (typeof RFP_ELIGIBILITY_FILTERS)[number]

export const RFP_BUDGET_BUCKETS = ['<50k', '50k-250k', '250k-1m', '1m+', 'unknown'] as const
export type RfpBudgetBucket = (typeof RFP_BUDGET_BUCKETS)[number]

export const RFP_TIMELINE_BUCKETS = ['0-3m', '3-6m', '6-12m', '12m+', 'unknown'] as const
export type RfpTimelineBucket = (typeof RFP_TIMELINE_BUCKETS)[number]

export const RFP_RESPONSE_STATUSES = ['draft', 'submitted'] as const
export type RfpResponseStatus = (typeof RFP_RESPONSE_STATUSES)[number]

/** Statuses on which a portal CustomerUser may see the RFP at all (invariant #15). */
export const RFP_PORTAL_VISIBLE_STATUSES = ['published', 'scoring', 'selection_made'] as const

/** Internal shape for create + update — refined externally. */
const rfpDraftBase = z.object({
  title: z.string().min(1).max(200),
  received_from: z.string().min(1).max(200),
  received_at: z.coerce.date(),
  description: z.string().min(1),
  tech_requirements: z.string().min(1),
  domain_requirements: z.string().min(1),
  industry: z.string().nullable().optional(),
  budget_bucket: z.enum(RFP_BUDGET_BUCKETS).nullable().optional(),
  timeline_bucket: z.enum(RFP_TIMELINE_BUCKETS).nullable().optional(),
  required_capabilities: z.array(z.string()).default([]),
  additional_criterion_name: z.string().max(120).nullable().optional(),
  deadline_to_respond: z.coerce.date().nullable().optional(),
  eligibility_filter: z.enum(RFP_ELIGIBILITY_FILTERS),
  min_tier: z.enum(AGENCY_TIERS).nullable().optional(),
  explicit_agency_ids: z.array(z.string().uuid()).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
})

/** Backend create-draft payload (US5.1). */
export const createRfpDraftSchema = rfpDraftBase
  .superRefine((v, ctx) => {
    if (v.eligibility_filter === 'by_min_tier' && !v.min_tier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_tier'],
        message: 'min_tier is required when eligibility_filter = by_min_tier',
      })
    }
    if (
      v.eligibility_filter === 'explicit' &&
      (!v.explicit_agency_ids || v.explicit_agency_ids.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['explicit_agency_ids'],
        message: 'explicit_agency_ids must be non-empty when eligibility_filter = explicit',
      })
    }
  })

export type CreateRfpDraftInput = z.infer<typeof createRfpDraftSchema>

/** Backend update-draft payload — every field optional. */
export const updateRfpDraftSchema = rfpDraftBase.partial()

export type UpdateRfpDraftInput = z.infer<typeof updateRfpDraftSchema>

/** Backend publish payload (US5.2) — optional confirmation list lets the UI guard against drift. */
export const publishRfpSchema = z.object({
  confirmedAgencyIds: z.array(z.string().uuid()).optional(),
})

export type PublishRfpInput = z.infer<typeof publishRfpSchema>

/** Backend unpublish payload — reason mandatory per §3.3 idempotency table. */
export const unpublishRfpSchema = z.object({
  reason: z.string().min(1).max(2_000),
})

export type UnpublishRfpInput = z.infer<typeof unpublishRfpSchema>

/** Portal P10 draft auto-save payload — every field optional (submit enforces required set). */
export const draftRfpResponseSchema = z.object({
  tech_experience: z.string().max(40_000).nullable().optional(),
  domain_experience: z.string().max(40_000).nullable().optional(),
  differentiators: z.string().max(40_000).nullable().optional(),
  attached_case_study_ids: z.array(z.string().uuid()).max(5).default([]),
})

export type DraftRfpResponseInput = z.infer<typeof draftRfpResponseSchema>

/** Portal P10 decline payload (US5.5). */
export const declineRfpBroadcastSchema = z.object({
  decline_reason: z.string().max(2_000).nullable().optional(),
})

export type DeclineRfpBroadcastInput = z.infer<typeof declineRfpBroadcastSchema>

/** Backend list query (B6). */
export const listRfpsBackendSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(RFP_STATUSES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
})

/** Portal inbox query (P9 / US5.3). */
export const listRfpsPortalSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  tab: z.enum(['unread', 'responded', 'declined', 'all']).default('all'),
})
