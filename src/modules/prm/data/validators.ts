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
