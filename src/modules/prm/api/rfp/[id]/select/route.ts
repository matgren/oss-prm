import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { selectRfpWinnerSchema } from '../../../../data/validators'
import type { RfpService } from '../../../../lib/rfpService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * POST /api/prm/rfp/{id}/select — Spec #6 §3.3 (US5.7).
 *
 * Coupled graph save — writes Rfp.selectedAgencyId, transitions to
 * `selection_made`, emits `prm.rfp.selection_made` (or
 * `prm.rfp.selection_changed` on re-selection).
 *
 * Auth: `prm.rfp.select`. Backend-only.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.select'] },
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
  const parsed = selectRfpWinnerSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const result = await service.selectWinner(params.id, parsed.data, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({
      ok: true,
      rfp_id: result.rfp.id,
      winner_agency_id: result.winnerAgencyId,
      winner_rfp_response_id: parsed.data.winner_rfp_response_id,
      rfp_status: result.rfp.status,
      runners_up_agency_ids: result.runnersUpAgencyIds,
      is_reselection: result.isReselection,
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
  summary: 'Select RFP winner (US5.7)',
  description:
    'Coupled graph save: writes Rfp.selectedAgencyId + selection_decided_at + selection_decided_by_user_id + selection_reasoning AND transitions Rfp.status to selection_made. First-time emits prm.rfp.selection_made; re-selection emits prm.rfp.selection_changed.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Winner committed.' },
    { status: 400, description: 'Validation failed.', schema: errorSchema },
    { status: 404, description: 'RFP / Winner response not found.', schema: errorSchema },
    { status: 409, description: 'Invalid transition / no scored responses / winner not scored.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Select RFP winner',
  methods: { POST: postDoc },
}
