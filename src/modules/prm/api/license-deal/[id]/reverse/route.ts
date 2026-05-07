import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { reverseLicenseDealSchema } from '../../../../data/validators'
import type { LicenseDealService } from '../../../../lib/licenseDealService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseLicenseDeal } from '../../route'

/**
 * Backend `POST /api/prm/license-deal/{id}/reverse` (Spec #3 §3.1.2).
 *
 * Reassigns or unattributes a license deal. Pre-condition: status < active.
 * Emits `prm.license_deal.reversal_started` (drives the reverse saga LIFO
 * compensation), resets the aggregate to `pending` + `none`, and optionally
 * replays attribution if `newAttribution` is supplied.
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
  const parsed = reverseLicenseDealSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const result = await service.reverse(id, parsed.data, {
      tenantId: auth.tenantId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })
    return NextResponse.json(
      {
        ok: true,
        licenseDeal: summariseLicenseDeal(result.licenseDeal),
        emittedEvents: result.emittedEvents,
      },
      { status: 202 },
    )
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
  summary: 'Reverse / reassign a license deal attribution (US4.4)',
  tags: ['PRM Backend'],
  requestBody: { schema: reverseLicenseDealSchema },
  responses: [
    {
      status: 202,
      description: 'Accepted',
      schema: z.object({
        ok: z.literal(true),
        licenseDeal: z.record(z.string(), z.any()),
        emittedEvents: z.array(z.string()),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'License deal not found', schema: errorSchema },
    { status: 409, description: 'Attribution frozen — call /unreverse-status first', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Reverse license deal attribution',
  methods: { POST: postDoc },
}
