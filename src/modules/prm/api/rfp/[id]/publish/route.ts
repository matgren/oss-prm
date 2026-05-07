import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { publishRfpSchema } from '../../../../data/validators'
import type { RfpService } from '../../../../lib/rfpService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseRfp } from '../../route'

/**
 * POST /api/prm/rfp/{id}/publish — US5.2.
 *
 * Transitions RFP draft → published, runs eligibility evaluator, writes
 * RfpBroadcast rows. Requires `prm.rfp.publish`.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.publish'] },
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
    // empty body is OK — confirmedAgencyIds is optional.
    body = {}
  }
  const parsed = publishRfpSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const result = await service.publish(
      params.id,
      { confirmedAgencyIds: parsed.data.confirmedAgencyIds },
      { tenantId: auth.tenantId, organizationId: auth.orgId, userId: auth.sub },
    )
    return NextResponse.json({
      ok: true,
      id: result.rfp.id,
      status: result.rfp.status,
      broadcastAgencyIds: result.broadcastAgencyIds,
      rfp: summariseRfp(result.rfp),
    })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const postDoc: OpenApiMethodDoc = {
  summary: 'Publish RFP + broadcast (US5.2)',
  description:
    'Transitions draft → published, evaluates eligibility, writes RfpBroadcast rows, emits prm.rfp.published + N prm.rfp_broadcast.created events. Optional confirmedAgencyIds guards against eligibility-set drift between preview and publish.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Published.' },
    { status: 404, description: 'RFP not found.', schema: errorSchema },
    { status: 409, description: 'Status not draft / zero eligible / drift.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM RFP publish',
  methods: { POST: postDoc },
}
