import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { updateLicenseDealSchema } from '../../../data/validators'
import type { LicenseDealService } from '../../../lib/licenseDealService'
import { PrmDomainError, toPrmErrorBody } from '../../../lib/errors'
import { summariseLicenseDeal } from '../route'

/**
 * Backend LicenseDeal detail / update / soft-delete (Spec #3 — attribution-loop, B5).
 *
 *   GET    /api/prm/license-deal/{id}   → detail
 *   PUT    /api/prm/license-deal/{id}   → update non-attribution fields
 *   DELETE /api/prm/license-deal/{id}   → soft-delete (only while pending)
 *
 * Attribution mutations are routed to the `/attribute` and `/reverse` sub-paths.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.license_deal.read'] },
  PUT: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
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

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const id = extractId(req)
  if (!id) return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  const deal = await service.findById(id, { tenantId: auth.tenantId })
  if (!deal) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true, licenseDeal: summariseLicenseDeal(deal) })
}

export async function PUT(req: Request) {
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
  const parsed = updateLicenseDealSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const deal = await service.update(id, parsed.data, {
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

export async function DELETE(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const id = extractId(req)
  if (!id) return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    await service.softDelete(id, {
      tenantId: auth.tenantId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })
    return new NextResponse(null, { status: 204 })
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

const getDoc: OpenApiMethodDoc = {
  summary: 'Read license deal detail',
  tags: ['PRM Backend'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), licenseDeal: z.record(z.string(), z.any()) }) },
  ],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
  ],
}

const putDoc: OpenApiMethodDoc = {
  summary: 'Update license deal non-attribution fields',
  tags: ['PRM Backend'],
  requestBody: { schema: updateLicenseDealSchema, description: 'Update payload (attribution fields rejected — use /attribute)' },
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), licenseDeal: z.record(z.string(), z.any()) }) },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Optimistic concurrency conflict / identifier taken', schema: errorSchema },
  ],
}

const deleteDoc: OpenApiMethodDoc = {
  summary: 'Soft-delete a license deal (status must be pending)',
  tags: ['PRM Backend'],
  responses: [{ status: 204, description: 'No Content' }],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 409, description: 'Status is not pending', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'License deal detail / update / soft-delete',
  methods: { GET: getDoc, PUT: putDoc, DELETE: deleteDoc },
}
