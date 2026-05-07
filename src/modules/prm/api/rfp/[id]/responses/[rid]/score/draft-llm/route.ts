import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Rfp, RfpResponse } from '../../../../../../../data/entities'
import { generateScoringDraft } from '../../../../../../../lib/llmScoringDraft'
import { PrmDomainError, isPrmDomainError, toPrmErrorBody, PRM_ERROR_CODES } from '../../../../../../../lib/errors'

/**
 * POST /api/prm/rfp/{id}/responses/{rid}/score/draft-llm — Spec #6 §3.2.
 *
 * Generates an LLM-assisted score draft for the OM PartnerOps user to
 * review + edit before committing via §3.1. **No DB writes** — endpoint
 * is idempotent and side-effect-free.
 *
 * Auth: `prm.rfp.score`. Returns 503 when no LLM provider is configured.
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

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  try {
    const rfp = await em.findOne(Rfp, {
      id: params.id,
      organizationId: auth.orgId,
      deletedAt: null,
    } as any)
    if (!rfp) {
      return NextResponse.json(
        toPrmErrorBody(new PrmDomainError(PRM_ERROR_CODES.RFP_NOT_FOUND, 'RFP not found', 404)),
        { status: 404 },
      )
    }
    const response = await em.findOne(RfpResponse, {
      id: params.rid,
      rfpId: params.id,
      organizationId: auth.orgId,
    } as any)
    if (!response) {
      return NextResponse.json(
        toPrmErrorBody(
          new PrmDomainError(
            PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
            'RfpResponse not found',
            404,
          ),
        ),
        { status: 404 },
      )
    }
    if (response.status !== 'submitted') {
      return NextResponse.json(
        toPrmErrorBody(
          new PrmDomainError(
            PRM_ERROR_CODES.RESPONSE_NOT_SUBMITTED,
            `Cannot draft for response in status "${response.status}". Only submitted responses are draftable.`,
            400,
          ),
        ),
        { status: 400 },
      )
    }

    const draft = await generateScoringDraft({ rfp, response })
    return NextResponse.json({
      ok: true,
      tech_fit_score: draft.tech_fit_score,
      domain_fit_score: draft.domain_fit_score,
      optional_score: draft.optional_score,
      reasoning: draft.reasoning,
      llm_model_id: draft.llm_model_id,
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
  summary: 'LLM-assisted scoring draft (US5.6 LLM, no save)',
  description:
    'Generates a structured-output scoring draft for OM PartnerOps to review + edit. No DB writes. Returns 503 when no LLM provider is configured.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'Draft returned.' },
    { status: 400, description: 'Response not submitted (cannot draft a draft response).', schema: errorSchema },
    { status: 404, description: 'RFP / RfpResponse not found.', schema: errorSchema },
    { status: 503, description: 'LLM provider not configured / failed.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'LLM scoring draft',
  methods: { POST: postDoc },
}
