import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency, AgencyMember } from '../../../../data/entities'
import { authenticateServiceRequest } from '../../../../lib/serviceAuthMiddleware'

/**
 * GET /api/prm/service/wic/profiles — US6.1 (Spec #4 §3.2).
 *
 * Returns the authoritative roster n8n should classify. Service-identity auth
 * via ServiceAuthMiddleware (no session, no ACL feature — shared secret IS
 * the authorization).
 *
 * v1 returns the **current-live** roster regardless of `?month=` parameter.
 * Historical month-at-start scoping is a v2 concern (a quiet month plus
 * mid-month activations would otherwise drop active rows that were inactive at
 * month-start). Tracked in POST-MVP-FOLLOW-UPS.
 */

export const metadata = {
  GET: { requireAuth: false },
}

const querySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
})

const ENDPOINT = 'GET /api/prm/service/wic/profiles'

type ProfileRow = {
  agency_member_id: string
  github_profile: string
  agency_slug: string
  is_active: boolean
}

export async function listActiveProfiles(em: EntityManager): Promise<ProfileRow[]> {
  // Two-step query (no cross-module ORM relations per AGENTS rule).
  // 1. Fetch active onboarded agencies.
  // 2. Fetch active members with github_profile non-null whose agencyId is in step 1.
  const agencies = await em.find(
    Agency,
    { status: 'active', onboarded: true, deletedAt: null },
    { fields: ['id', 'slug'] as never },
  )
  if (agencies.length === 0) return []
  const agencyById = new Map<string, string>()
  for (const a of agencies) agencyById.set(a.id, a.slug)
  const agencyIds = Array.from(agencyById.keys())

  const members = await em.find(AgencyMember, {
    agencyId: { $in: agencyIds },
    isActive: true,
    deletedAt: null,
    githubProfile: { $ne: null },
  } as any)

  const out: ProfileRow[] = []
  for (const member of members) {
    const slug = agencyById.get(member.agencyId)
    if (!slug) continue
    if (!member.githubProfile || member.githubProfile.trim() === '') continue
    out.push({
      agency_member_id: member.id,
      github_profile: member.githubProfile,
      agency_slug: slug,
      is_active: member.isActive,
    })
  }
  return out
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const auth = await authenticateServiceRequest(req, { endpoint: ENDPOINT })
  if (!auth.ok) return auth.response

  const month = parsed.data.month ?? defaultMonth(new Date())

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const profiles = await listActiveProfiles(em)

  return NextResponse.json({ month, profiles })
}

export function defaultMonth(now: Date): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const profileRowSchema = z.object({
  agency_member_id: z.string().uuid(),
  github_profile: z.string(),
  agency_slug: z.string(),
  is_active: z.boolean(),
})

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'WIC profiles roster (US6.1)',
  description:
    'Returns the authoritative github-profile roster for the n8n WIC classifier. Service-identity auth via shared secret + timestamp headers (SPEC-053b).',
  tags: ['PRM WIC Service'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        month: z.string(),
        profiles: z.array(profileRowSchema),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Bad headers/query', schema: errorSchema },
    { status: 401, description: 'Bad/missing X-Om-Import-Secret', schema: errorSchema },
    { status: 408, description: 'Timestamp outside ±5min window', schema: errorSchema },
    { status: 503, description: 'WIC import secret not configured', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM WIC service — profiles roster',
  description: 'Service-identity GET endpoint for n8n WIC classifier roster polling.',
  methods: { GET: getDoc },
}
