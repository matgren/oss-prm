import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  type MarketingMaterialService,
  toMarketingMaterialDto,
} from '../../../../lib/marketingMaterialService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'

/**
 * B9 — publish action (Spec #7 §4.1 / US7.1).
 *
 * Sets `published_at = NOW()`, clears `unpublished_at`. Emits
 * `prm.marketing_material.published` which the per-feature cache
 * invalidator subscribes to.
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
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    const m = await service.publish(
      params.id,
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
  summary: 'Publish marketing material',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), material: itemSchema }) },
    { status: 404, description: 'Not found' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — publish marketing material',
  methods: { POST: postDoc },
}
