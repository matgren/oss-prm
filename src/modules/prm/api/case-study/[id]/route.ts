import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { CaseStudy } from '../../../data/entities'
import { toCaseStudyDto } from '../../../lib/caseStudyService'
import { PRM_ERROR_CODES } from '../../../lib/errors'

/**
 * B8 — backend Case Study detail.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.case_study.read_all'] },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const cs = await em.findOne(CaseStudy, { id: params.id, organizationId: auth.orgId } as any)
  if (!cs) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.CASE_STUDY_NOT_FOUND, message: 'Case study not found.' } },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) })
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read case study detail (B8)',
  tags: ['PRM Backend Case Studies'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), caseStudy: itemSchema }) },
    { status: 404, description: 'Not found' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — case study detail (B8)',
  methods: { GET: getDoc },
}
