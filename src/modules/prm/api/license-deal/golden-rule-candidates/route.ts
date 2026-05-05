import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { LicenseDealService } from '../../../lib/licenseDealService'

/**
 * Backend `GET /api/prm/license-deal/golden-rule-candidates` (Spec #3 §2 picker).
 *
 * Read-only helper for the B5 attribution-picker UX. Returns candidate Prospects
 * matching the LicenseDeal's normalized client-company name (and optionally the
 * contact email) ordered by `registered_at ASC`. Includes ALL statuses including
 * `lost` per W12 (invariant #14) — the picker UI flags those with a red badge.
 *
 * `isDefaultPick = true` is set on exactly one row — the oldest non-lost candidate.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
}

const querySchema = z.object({
  clientCompanyName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  const candidates = await service.findGoldenRuleCandidates(
    {
      clientCompanyName: parsed.data.clientCompanyName,
      contactEmail: parsed.data.contactEmail ?? null,
      limit: parsed.data.limit,
    },
    { tenantId: auth.tenantId },
  )
  return NextResponse.json({ ok: true, candidates })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const candidateSchema = z.object({
  prospectId: z.string().uuid(),
  agencyId: z.string().uuid(),
  organizationId: z.string().uuid(),
  companyName: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  status: z.string(),
  registeredAt: z.string(),
  registeredByAgencyMemberId: z.string().uuid(),
  isDefaultPick: z.boolean(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Golden Rule candidate picker for B5 attribution UX',
  description:
    'Returns candidate Prospects ordered by registered_at ASC. Includes ALL statuses including lost (invariant #14). Default pick = oldest non-lost.',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({ ok: z.literal(true), candidates: z.array(candidateSchema) }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Golden Rule candidate picker',
  methods: { GET: getDoc },
}
