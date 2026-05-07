import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { recordRfpResponseScoreSchema } from '../../../../../../data/validators'
import type { RfpService } from '../../../../../../lib/rfpService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../../../lib/errors'

/**
 * POST /api/prm/rfp/{id}/responses/{rid}/score — Spec #6 §3.1 (US5.6).
 *
 * Records a manual or LLM-assisted score on a submitted RfpResponse.
 * Append-only — re-scores insert v+1 and require `change_reason`.
 *
 * Auto-transitions RFP `published → scoring` on the first score recorded.
 *
 * Auth: `prm.rfp.score`. Backend-only (OM PartnerOps).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.score'] },
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RouteCtx = { params: Promise<{ id: string; rid: string }> | { id: string; rid: string } }

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const params = await Promise.resolve(ctx.params)
  if (!UUID_REGEX.test(params.id) || !UUID_REGEX.test(params.rid)) {
    return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = recordRfpResponseScoreSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const result = await service.recordScore(params.id, params.rid, parsed.data, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    const totalScore =
      result.score.techFitScore +
      result.score.domainFitScore +
      (result.score.includeOptional && typeof result.score.optionalScore === 'number'
        ? result.score.optionalScore
        : 0)
    return NextResponse.json({
      ok: true,
      rfp_response_score_id: result.score.id,
      version: result.score.version,
      total_score: totalScore,
      rfp_status: result.rfp.status,
      is_initial_score_on_rfp: result.isInitialScoreOnRfp,
    })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({}).passthrough()]) })

const postDoc: OpenApiMethodDoc = {
  summary: 'Record an RfpResponse score (US5.6)',
  description:
    'Append-only — every call inserts a new RfpResponseScore row with version = max + 1. Re-scores require `change_reason`. Source must be "manual" with null llm_model_id, or "llm_assisted" with non-null llm_model_id. RFP auto-transitions published → scoring on first score.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Score recorded.' },
    { status: 400, description: 'Validation failed.', schema: errorSchema },
    { status: 404, description: 'RFP or RfpResponse not found.', schema: errorSchema },
    { status: 409, description: 'RFP not accepting scores / response not submitted / change_reason required.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Record RfpResponse score',
  methods: { POST: postDoc },
}
