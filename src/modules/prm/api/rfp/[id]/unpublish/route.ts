import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { unpublishRfpSchema } from '../../../../data/validators'
import type { RfpService } from '../../../../lib/rfpService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseRfp } from '../../route'

/**
 * POST /api/prm/rfp/{id}/unpublish — undo of publish (Spec §3.3 idempotency table).
 *
 * Refuses (409) if any broadcast has firstOpenedAt or declinedAt, OR if any
 * RfpResponse exists. R6 mitigation — preserves audit trail.
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
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = unpublishRfpSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const rfp = await service.unpublish(
      params.id,
      { reason: parsed.data.reason },
      { organizationId: auth.orgId, userId: auth.sub },
    )
    return NextResponse.json({ ok: true, id: rfp.id, status: rfp.status, rfp: summariseRfp(rfp) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const postDoc: OpenApiMethodDoc = {
  summary: 'Unpublish RFP (undo of publish)',
  description:
    'Reverts published → draft. Refuses if any broadcast has been opened or declined, or any RfpResponse exists (R6 audit-integrity).',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Reverted.' },
    { status: 404, description: 'RFP not found.', schema: errorSchema },
    { status: 409, description: 'Refused — agencies have interacted.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM RFP unpublish',
  methods: { POST: postDoc },
}
