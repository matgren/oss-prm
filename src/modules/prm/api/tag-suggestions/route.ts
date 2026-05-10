import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency, CaseStudy } from '../../data/entities'
import { unionTagSlugs } from '../../lib/tagSuggestions'

// Staff-auth route — framework catch-all enforces auth + `prm.rfp.create`.
// Drives the B-RFP `requiredCapabilities` autocomplete (tenant-wide tech tags only).
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
}

// In v1 the tenant-wide endpoint only exposes `technologies` — B-RFP's only
// tenant-wide need per SPEC-2026-05-11 §5.1.2. Services and other fields stay
// per-agency.
const querySchema = z.object({
  field: z.literal('technologies'),
})

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({ field: url.searchParams.get('field') })
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Invalid `field` parameter (expected "technologies").' },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  // Tenant-scoping: load all active, non-deleted agencies in the tenant, then
  // their non-deleted case studies. CaseStudy has no tenant_id column — we
  // join via Agency.id list. The collated row set is small at v1 scale; see
  // §14.1 for the deferred UNNEST-based projection swap.
  const agencies = await em.find(
    Agency,
    { tenantId: auth.tenantId, deletedAt: null },
    { fields: ['id', 'techCapabilities'] as any },
  )
  if (agencies.length === 0) {
    return NextResponse.json({ ok: true, items: [] })
  }
  const agencyIds = agencies.map((a) => a.id)
  const caseStudies = await em.find(
    CaseStudy,
    { agencyId: { $in: agencyIds }, deletedAt: null },
    { fields: ['id', 'technologiesUsed'] as any },
  )

  const sources: Array<readonly string[] | null | undefined> = [
    ...agencies.map((a) => a.techCapabilities),
    ...caseStudies.map((cs) => cs.technologiesUsed),
  ]

  return NextResponse.json({ ok: true, items: unionTagSlugs(sources) })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Tenant-wide technology tag suggestions',
  description:
    'Union of every active agency\'s `techCapabilities` and every non-deleted case-study\'s `technologiesUsed` ' +
    'across the caller\'s tenant. Drives the B-RFP `requiredCapabilities` autocomplete. ' +
    'Per SPEC-2026-05-11 §5.1.2.',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK — alphabetised, case-insensitive deduped, UUID-filtered tag list',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(z.object({ value: z.string(), label: z.string() })),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid query', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Backend tenant-wide technology tag suggestions (B-RFP driver)',
  description: 'Staff auth — `prm.rfp.create`. SPEC-2026-05-11 §5.1.2 / §6.4.',
  methods: { GET: getDoc },
}
