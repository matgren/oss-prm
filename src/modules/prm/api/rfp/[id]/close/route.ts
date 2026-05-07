import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { closeRfpSchema } from '../../../../data/validators'
import type { RfpService } from '../../../../lib/rfpService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * POST /api/prm/rfp/{id}/close — Spec #6 §3.4 (US5.9). Terminal lifecycle.
 *
 * Auth: `prm.rfp.close`. Backend-only.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.close'] },
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RouteCtx = { params: Promise<{ id: string }> | { id: string } }

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const params = await Promise.resolve(ctx.params)
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid RFP id' }, { status: 400 })
  }
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const parsed = closeRfpSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const result = await service.closeRfp(params.id, parsed.data, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({
      ok: true,
      rfp_id: result.rfp.id,
      rfp_status: result.rfp.status,
      final_selected_agency_id: result.finalSelectedAgencyId,
    })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({}).passthrough()]) })

const postDoc: OpenApiMethodDoc = {
  summary: 'Close RFP (US5.9)',
  description:
    'Terminal lifecycle transition. Allowed from scoring / selection_made / reopened. close_reason required when no selection exists.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Closed.' },
    { status: 400, description: 'Validation / close_reason required.', schema: errorSchema },
    { status: 404, description: 'RFP not found.', schema: errorSchema },
    { status: 409, description: 'Invalid transition.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Close RFP',
  methods: { POST: postDoc },
}
