import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  listCaseStudyBackendSchema,
} from '../../data/validators'
import {
  type CaseStudyService,
  toCaseStudyDto,
} from '../../lib/caseStudyService'

/**
 * B8 — backend Case Study list (Spec #7 §3.2 / US2.4).
 *
 *   GET /api/prm/case-study   — cross-Agency list, includes soft-deleted by default.
 *
 * Reading is OM PartnerOps + OM Marketing + OM Admin (`prm.case_study.read_all`).
 * The publication-flag toggle lives on a separate route — see `[id]/publication-flag`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.case_study.read_all'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listCaseStudyBackendSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, agencyId, mayPublish, isPublished, includeDeleted, q } = parsed.data
  const container = await createRequestContainer()
  const service = container.resolve('caseStudyService') as CaseStudyService
  const { items, total } = await service.listAll(
    { organizationId: auth.orgId },
    {
      agencyId,
      mayPublish,
      isPublished,
      includeDeleted,
      q,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  )
  return NextResponse.json({
    ok: true,
    items: items.map(toCaseStudyDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'List case studies cross-Agency (B8)',
  description: 'Backend list. Default `include_deleted = true` for Marketing reconciliation visibility.',
  tags: ['PRM Backend Case Studies'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(itemSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — case study cross-Agency list (B8)',
  methods: { GET: getDoc },
}
