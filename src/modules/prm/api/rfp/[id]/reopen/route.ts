import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { reopenRfpSchema } from '../../../../data/validators'
import type { RfpService } from '../../../../lib/rfpService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * POST /api/prm/rfp/{id}/reopen — Spec #6 §3.5 (US5.10).
 *
 * Hard-guard invariant #17: rejects with 409 PATH_B_SIGNED_DEAL_LOCK
 * when a signed Path-B LicenseDeal is attributed to this RFP.
 *
 * Auth: `prm.rfp.reopen`. Backend-only.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.reopen'] },
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
  const parsed = reopenRfpSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const result = await service.reopenRfp(params.id, parsed.data, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({
      ok: true,
      rfp_id: result.rfp.id,
      rfp_status: result.rfp.status,
      reopened_deadline_at: result.rfp.reopenedDeadlineAt
        ? result.rfp.reopenedDeadlineAt.toISOString()
        : null,
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
  summary: 'Reopen RFP (US5.10) — hard-guard invariant #17 applies',
  description:
    'Re-opens a selected/closed RFP for a challenge round. **HARD GUARD**: returns 409 PATH_B_SIGNED_DEAL_LOCK when a signed Path-B LicenseDeal is attributed to this RFP — read-model fast-fail + live SQL re-check, no role bypass.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Reopened.' },
    { status: 400, description: 'Validation / deadline in past.', schema: errorSchema },
    { status: 404, description: 'RFP not found.', schema: errorSchema },
    { status: 409, description: 'Invalid transition or PATH_B_SIGNED_DEAL_LOCK.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Reopen RFP',
  methods: { POST: postDoc },
}
