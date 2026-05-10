import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { LicenseDealService } from '../../../lib/licenseDealService'

/**
 * Backend `GET /api/prm/license-deal/next-identifier`.
 *
 * Returns the next `OM-YYYY-NNNN` the server would assign on create. Used by
 * the New License Deal form to preview the auto-generated identifier in a
 * disabled field. Informational only — the create handler regenerates
 * atomically on submit (race-safe via retry).
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  const identifier = await service.generateNextIdentifier(auth.tenantId)
  return NextResponse.json({ ok: true, identifier })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Suggest the next license identifier',
  description:
    'Preview the next `OM-YYYY-NNNN` the server would assign on create. Informational — the create handler regenerates atomically and retries on race.',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({ ok: z.literal(true), identifier: z.string() }),
    },
  ],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Next license identifier suggestion',
  methods: { GET: getDoc },
}
