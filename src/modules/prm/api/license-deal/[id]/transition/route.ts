import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { transitionLicenseDealStatusSchema } from '../../../../data/validators'
import type { LicenseDealService } from '../../../../lib/licenseDealService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseLicenseDeal } from '../../route'

/**
 * Backend `POST /api/prm/license-deal/{id}/transition` (Spec #3 §3.1).
 *
 * Forward status transition (`pending → signed → active → churned`). Used by
 * OM PartnerOps when the deal lifecycle progresses naturally (e.g. signed →
 * active when the customer goes live, or active → churned when they leave).
 *
 * Backward moves go through `/unreverse-status` (US4.4b).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
}

function extractId(req: Request): string | null {
  try {
    const segments = new URL(req.url).pathname.split('/').filter(Boolean)
    const idx = segments.findIndex((s) => s === 'license-deal')
    return idx >= 0 && segments[idx + 1] ? decodeURIComponent(segments[idx + 1]) : null
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const id = extractId(req)
  if (!id) return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = transitionLicenseDealStatusSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const deal = await service.transitionStatus(id, parsed.data, {
      tenantId: auth.tenantId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })
    return NextResponse.json({ ok: true, licenseDeal: summariseLicenseDeal(deal) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Forward status transition for a license deal',
  tags: ['PRM Backend'],
  requestBody: { schema: transitionLicenseDealStatusSchema },
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), licenseDeal: z.record(z.string(), z.any()) }) },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'License deal not found', schema: errorSchema },
    { status: 409, description: 'Transition not allowed / version conflict', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'License deal status transition',
  methods: { POST: postDoc },
}
