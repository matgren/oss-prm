import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { unpublishMarketingMaterialSchema } from '../../../../data/validators'
import {
  type MarketingMaterialService,
  toMarketingMaterialDto,
} from '../../../../lib/marketingMaterialService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * B9 — unpublish action.
 *
 * Sets `unpublished_at = NOW()`. Emits `prm.marketing_material.unpublished`.
 * Body accepts an optional `reason` (audit trail).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.marketing_material.publish'] },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function POST(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const parsed = unpublishMarketingMaterialSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    const m = await service.unpublish(
      params.id,
      parsed.data,
      { organizationId: auth.orgId },
      { userId: auth.sub },
    )
    return NextResponse.json({ ok: true, material: toMarketingMaterialDto(m) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const postDoc: OpenApiMethodDoc = {
  summary: 'Unpublish marketing material',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), material: itemSchema }) },
    { status: 409, description: 'Material was never published' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — unpublish marketing material',
  methods: { POST: postDoc },
}
