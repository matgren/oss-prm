import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { unreverseLicenseDealStatusSchema } from '../../../../data/validators'
import type { LicenseDealService } from '../../../../lib/licenseDealService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseLicenseDeal } from '../../route'

/**
 * Backend `POST /api/prm/license-deal/{id}/unreverse-status` (Spec #3 §3.1.3).
 *
 * US4.4b — scoped bypass of invariant #7. Allowed transitions:
 *   - active → signed (correction; lock stays per §8.6 decision)
 *   - signed → pending (releases lock; reassignment becomes legal)
 *
 * `churned` is REJECTED (terminal). Requires `prm.license_deal.reassign` feature
 * (the secondary-confirm gate) per spec §6.1.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.license_deal.write', 'prm.license_deal.reassign'] },
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
  const parsed = unreverseLicenseDealStatusSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const deal = await service.unreverseStatus(id, parsed.data, {
      tenantId: auth.tenantId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })
    return NextResponse.json({ ok: true, licenseDeal: summariseLicenseDeal(deal) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
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
  summary: 'Unreverse status (US4.4b — scoped bypass of invariant #7)',
  tags: ['PRM Backend'],
  requestBody: { schema: unreverseLicenseDealStatusSchema },
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), licenseDeal: z.record(z.string(), z.any()) }) },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Reassign feature missing', schema: errorSchema },
    { status: 404, description: 'License deal not found', schema: errorSchema },
    { status: 409, description: 'Transition not allowed / churned terminal', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Unreverse license deal status',
  methods: { POST: postDoc },
}
