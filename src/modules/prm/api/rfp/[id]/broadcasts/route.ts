import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency, Rfp, RfpBroadcast, RfpResponse } from '../../../../data/entities'

/**
 * GET /api/prm/rfp/{id}/broadcasts — Spec #6 §3.6 (B11 audit page).
 *
 * Returns the per-Agency audit of a published RFP's lifecycle:
 *   - Broadcast at, first opened at, declined at + reason.
 *   - Response status (none / draft / submitted).
 *   - Final outcome (selected / not_selected / no_decision).
 *
 * Read-only; no writes allowed. Auth: `prm.rfp.create` (existing OM
 * PartnerOps gate; the audit is part of the RFP author's surface).
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

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
  const url = new URL(req.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize } = parsed.data
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const rfp = await em.findOne(Rfp, {
    id: params.id,
    organizationId: auth.orgId,
    deletedAt: null,
  } as any)
  if (!rfp) {
    return NextResponse.json({ ok: false, error: 'RFP not found' }, { status: 404 })
  }

  const broadcasts = await em.find(
    RfpBroadcast,
    { rfpId: params.id, organizationId: auth.orgId } as any,
    { orderBy: { broadcastAt: 'desc' } } as any,
  )
  const total = broadcasts.length
  const page0 = (page - 1) * pageSize
  const paged = broadcasts.slice(page0, page0 + pageSize)

  const agencyIds = Array.from(new Set(paged.map((b) => b.agencyId)))
  const agencies = await findWithDecryption<Agency>(
    em,
    Agency,
    { id: { $in: agencyIds } } as any,
    { fields: ['id', 'name'] as never },
    { tenantId: null, organizationId: null },
  )
  const agencyNameById = new Map<string, string>()
  for (const a of agencies) agencyNameById.set(a.id, a.name)

  const responses = await em.find(
    RfpResponse,
    { rfpId: params.id, organizationId: auth.orgId, agencyId: { $in: agencyIds } } as any,
  )
  const responseByAgencyId = new Map<string, RfpResponse>()
  for (const r of responses) responseByAgencyId.set(r.agencyId, r)

  const items = paged.map((b) => {
    const response = responseByAgencyId.get(b.agencyId)
    const responseStatus =
      response?.status ?? (b.declinedAt ? 'declined' : 'none')
    let finalOutcome: 'selected' | 'not_selected' | 'no_decision'
    if (rfp.selectedAgencyId === b.agencyId) {
      finalOutcome = 'selected'
    } else if (rfp.selectedAgencyId) {
      finalOutcome = 'not_selected'
    } else {
      finalOutcome = 'no_decision'
    }
    return {
      broadcast_id: b.id,
      agency_id: b.agencyId,
      agency_name: agencyNameById.get(b.agencyId) ?? null,
      broadcast_at: b.broadcastAt.toISOString(),
      first_opened_at: b.firstOpenedAt ? b.firstOpenedAt.toISOString() : null,
      declined_at: b.declinedAt ? b.declinedAt.toISOString() : null,
      declined_reason: b.declineReason ?? null,
      response_status: responseStatus,
      final_outcome: finalOutcome,
    }
  })

  return NextResponse.json({
    ok: true,
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({}).passthrough()]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'B11 RFP Broadcasts audit (Spec #6 §3.6)',
  description:
    'Read-only audit of a single RFP\'s broadcast set. Returns per-Agency rows with broadcast/open/decline timing, response status, and final outcome (selected / not_selected / no_decision).',
  tags: ['PRM RFPs'],
  responses: [
    { status: 200, description: 'OK' },
    { status: 400, description: 'Validation failed.', schema: errorSchema },
    { status: 404, description: 'RFP not found.', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'B11 RFP Broadcasts audit',
  methods: { GET: getDoc },
}
