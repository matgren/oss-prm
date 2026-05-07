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

// ---------------------------------------------------------------------------
// WIC ingestion (Spec #4 — wic-ingestion).
// ---------------------------------------------------------------------------

export const WIC_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const
export type WicLevel = (typeof WIC_LEVELS)[number]

export const WIC_REJECTION_REASONS = [
  'unknown_github_profile',
  'ambiguous_github_profile',
  'malformed_month',
  'unknown_level',
  'invalid_payload',
] as const
export type WicRejectionReason = (typeof WIC_REJECTION_REASONS)[number]

export const WIC_RESOLUTION_ACTIONS = [
  'accepted_after_fix',
  'rolled_back',
  'ignored',
] as const
export type WicResolutionAction = (typeof WIC_RESOLUTION_ACTIONS)[number]

/**
 * Envelope-level Zod schema for POST /api/prm/service/wic/imports/{batch_id}.
 *
 * Note: per §3.3, **row-level Zod failures are NOT 422s** — they become per-row audit-log
 * entries with `rejection_reason='invalid_payload'`. Only envelope-shape failures (e.g.
 * `rows` not an array, missing `script_version`) trigger 422 here. Use
 * `wicImportRowEnvelopeSchema.safeParse` per row for permissive row-level checks.
 */
export const wicImportEnvelopeSchema = z.object({
  script_version: z.string().min(1, 'script_version is required'),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  rows: z.array(z.unknown()).max(10_000, 'rows[] limit is 10,000 per batch'),
})
export type WicImportEnvelope = z.infer<typeof wicImportEnvelopeSchema>

/**
 * Per-row Zod schema. Failures here lead to per-row rejection (NOT 422). The route handler
 * runs `wicImportRowSchema.safeParse(row)` for each row and routes the failure into
 * `WicImportAuditLog` with `rejection_reason='invalid_payload'`.
 */
export const wicImportRowSchema = z.object({
  row_index: z.coerce.number().int().min(0),
  github_profile: z.string().trim().min(1).max(120),
  person_display_name: z.string().trim().max(200).optional().nullable(),
  contribution_month: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'contribution_month must be YYYY-MM-DD'),
  wic_level: z.string().trim().min(1).max(8),
  wic_score: z.coerce.number().finite(),
  contribution_count: z.coerce.number().int().min(0).default(0),
  bounty_bonus: z.coerce.number().finite().default(0),
  why_bonus: z.string().max(2000).optional().nullable(),
  what_included: z.string().max(8000).optional().nullable(),
  what_excluded: z.string().max(8000).optional().nullable(),
  computed_at: z.string().datetime({ offset: true }),
})
export type WicImportRow = z.infer<typeof wicImportRowSchema>

/** Helper: returns true iff `YYYY-MM-DD` is the first day of its month. */
export function isFirstOfMonth(isoDate: string): boolean {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const day = Number.parseInt(m[3]!, 10)
  return day === 1
}

/** Helper: extracts YYYY-MM from a YYYY-MM-DD string. */
export function monthFromDate(isoDate: string): string | null {
  const m = isoDate.match(/^(\d{4}-\d{2})-\d{2}$/)
  return m ? m[1]! : null
}
