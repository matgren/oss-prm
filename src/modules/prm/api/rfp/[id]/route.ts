import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Rfp } from '../../../data/entities'
import { updateRfpDraftSchema } from '../../../data/validators'
import type { RfpService } from '../../../lib/rfpService'
import { isPrmDomainError, toPrmErrorBody } from '../../../lib/errors'
import { summariseRfp } from '../route'

/**
 * Backend RFP detail + update routes (Spec #5 §3.1).
 *
 *   GET   /api/prm/rfp/{id} — B7 detail. `prm.rfp.create`.
 *   PATCH /api/prm/rfp/{id} — Update draft. `prm.rfp.create`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
  PATCH: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RouteCtx = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const params = await Promise.resolve(ctx.params)
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid RFP id' }, { status: 400 })
  }
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const rfp = await findOneWithDecryption(
    em,
    Rfp,
    { id: params.id, organizationId: auth.orgId, deletedAt: null } as any,
    undefined,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )
  if (!rfp) {
    return NextResponse.json({ ok: false, error: 'RFP not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, rfp: summariseRfp(rfp) })
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const params = await Promise.resolve(ctx.params)
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid RFP id' }, { status: 400 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = updateRfpDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const rfp = await service.updateDraft(params.id, parsed.data, { organizationId: auth.orgId })
    return NextResponse.json({ ok: true, rfp: summariseRfp(rfp) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read RFP (B7)',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'OK' },
    { status: 404, description: 'Not found.', schema: errorSchema },
  ],
}

const patchDoc: OpenApiMethodDoc = {
  summary: 'Update RFP draft',
  description: 'Only allowed while status=draft. Returns 409 otherwise.',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'OK' },
    { status: 400, description: 'Validation failed.', schema: errorSchema },
    { status: 409, description: 'RFP not in draft status.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM RFP detail + update',
  methods: { GET: getDoc, PATCH: patchDoc },
}
