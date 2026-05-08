import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { updateMarketingMaterialSchema } from '../../../data/validators'
import {
  type MarketingMaterialService,
  toMarketingMaterialDto,
} from '../../../lib/marketingMaterialService'
import { isPrmDomainError, toPrmErrorBody } from '../../../lib/errors'

/**
 * B9 — backend Marketing Material detail / update / hard-delete.
 *
 *   GET    /api/prm/marketing-material/:id
 *   PUT    /api/prm/marketing-material/:id
 *   DELETE /api/prm/marketing-material/:id (only legal while never-published)
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.marketing_material.read'] },
  PUT: { requireAuth: true, requireFeatures: ['prm.marketing_material.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['prm.marketing_material.write'] },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    const m = await service.getById(params.id, { organizationId: auth.orgId })
    const attachments = await service.listAttachments(m, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    return NextResponse.json({ ok: true, material: toMarketingMaterialDto(m, attachments) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export async function PUT(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = updateMarketingMaterialSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    const m = await service.update(params.id, parsed.data, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    const attachments = await service.listAttachments(m, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    return NextResponse.json({ ok: true, material: toMarketingMaterialDto(m, attachments) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export async function DELETE(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  try {
    await service.delete(params.id, { organizationId: auth.orgId })
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const itemSchema = z.object({ id: z.string().uuid(), title: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read marketing material',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), material: itemSchema }) },
    { status: 404, description: 'Not found' },
  ],
}

const putDoc: OpenApiMethodDoc = {
  summary: 'Update marketing material',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), material: itemSchema }) },
  ],
}

const deleteDoc: OpenApiMethodDoc = {
  summary: 'Hard-delete (only while never-published)',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'Deleted' },
    { status: 409, description: 'Has been published — unpublish first.' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM backend — marketing material detail',
  methods: { GET: getDoc, PUT: putDoc, DELETE: deleteDoc },
}
