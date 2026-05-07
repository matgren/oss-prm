import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  createMarketingMaterialSchema,
  listMarketingMaterialBackendSchema,
} from '../../data/validators'
import {
  type MarketingMaterialService,
  toMarketingMaterialDto,
} from '../../lib/marketingMaterialService'
import { isPrmDomainError, toPrmErrorBody } from '../../lib/errors'

/**
 * B9 — backend Marketing Material list + create (Spec #7 §3.3 / US7.1).
 *
 *   GET  /api/prm/marketing-material   — list (read access)
 *   POST /api/prm/marketing-material   — create unpublished material (write)
 *
 * Read separated from write so OM PartnerOps can read-only-browse without
 * the publish gate. OM Marketing has both `read` + `write` + `publish`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.marketing_material.read'] },
  POST: { requireAuth: true, requireFeatures: ['prm.marketing_material.write'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listMarketingMaterialBackendSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, materialType, visibility, isPublished, q } = parsed.data
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  const { items, total } = await service.list(
    { organizationId: auth.orgId },
    { materialType, visibility, isPublished, q, limit: pageSize, offset: (page - 1) * pageSize },
  )
  return NextResponse.json({
    ok: true,
    items: items.map(toMarketingMaterialDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = createMarketingMaterialSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    const m = await service.create(parsed.data, { organizationId: auth.orgId, userId: auth.sub })
    return NextResponse.json({ ok: true, material: toMarketingMaterialDto(m) }, { status: 201 })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'List marketing materials (B9)',
  tags: ['PRM Backend Marketing'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(itemSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Create marketing material (B9)',
  description: 'Creates an unpublished MarketingMaterial. Use the `/publish` action to make it visible.',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 201, description: 'Created', schema: z.object({ ok: z.literal(true), material: itemSchema }) },
    { status: 400, description: 'Validation failed' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — marketing materials (B9)',
  methods: { GET: getDoc, POST: postDoc },
}
