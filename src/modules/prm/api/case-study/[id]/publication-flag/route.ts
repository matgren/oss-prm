import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { setCaseStudyPublicationFlagSchema } from '../../../../data/validators'
import {
  type CaseStudyService,
  toCaseStudyDto,
} from '../../../../lib/caseStudyService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * B8 — toggle the Case Study publication flag (US2.4).
 *
 *   PUT /api/prm/case-study/:id/publication-flag
 *
 * RBAC: requires `prm.case_study.toggle_publish` (OM Marketing + OM Admin
 * only). OM PartnerOps explicitly LACKS this feature — the Marketing /
 * PartnerOps role split is enforced here.
 *
 * Refine: a TRUE flag without a URL is legal (approved but not yet live).
 * A `published_url` set while flag = false is invalid (Zod refine + service
 * defence-in-depth).
 */
export const metadata = {
  PUT: { requireAuth: true, requireFeatures: ['prm.case_study.toggle_publish'] },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function PUT(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = setCaseStudyPublicationFlagSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('caseStudyService') as CaseStudyService
  try {
    const cs = await service.setPublicationFlag(
      params.id,
      parsed.data,
      { organizationId: auth.orgId },
      { userId: auth.sub },
    )
    return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const putDoc: OpenApiMethodDoc = {
  summary: 'Toggle case study publication flag (US2.4)',
  tags: ['PRM Backend Case Studies'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), caseStudy: itemSchema }) },
    { status: 422, description: 'Refine failed (publishedUrl set with flag = false)' },
    { status: 404, description: 'Not found' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — case study publication flag (B8)',
  methods: { PUT: putDoc },
}
