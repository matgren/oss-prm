import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Rfp } from '../../data/entities'
import { createRfpDraftSchema, listRfpsBackendSchema, RFP_STATUSES } from '../../data/validators'
import type { RfpService } from '../../lib/rfpService'
import { isPrmDomainError, toPrmErrorBody } from '../../lib/errors'

/**
 * Backend RFP CRUD route (Spec #5 §3.1).
 *
 *   GET  /api/prm/rfp     — B6 list. Requires `prm.rfp.create`.
 *   POST /api/prm/rfp     — US5.1 create draft. Requires `prm.rfp.create`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
  POST: { requireAuth: true, requireFeatures: ['prm.rfp.create'] },
}

export function summariseRfp(rfp: Rfp) {
  return {
    id: rfp.id,
    organizationId: rfp.organizationId,
    title: rfp.title,
    receivedFrom: rfp.receivedFrom,
    receivedAt: rfp.receivedAt.toISOString(),
    description: rfp.description,
    techRequirements: rfp.techRequirements,
    domainRequirements: rfp.domainRequirements,
    industry: rfp.industry ?? null,
    budgetBucket: rfp.budgetBucket ?? null,
    timelineBucket: rfp.timelineBucket ?? null,
    requiredCapabilities: rfp.requiredCapabilities ?? [],
    additionalCriterionName: rfp.additionalCriterionName ?? null,
    deadlineToRespond: rfp.deadlineToRespond ? rfp.deadlineToRespond.toISOString() : null,
    eligibilityFilter: rfp.eligibilityFilter,
    minTier: rfp.minTier ?? null,
    explicitAgencyIds: rfp.explicitAgencyIds ?? null,
    status: rfp.status,
    selectedAgencyId: rfp.selectedAgencyId ?? null,
    isPathBLocked: rfp.isPathBLocked,
    notes: rfp.notes ?? null,
    publishedAt: rfp.publishedAt ? rfp.publishedAt.toISOString() : null,
    closedAt: rfp.closedAt ? rfp.closedAt.toISOString() : null,
    createdByUserId: rfp.createdByUserId,
    createdAt: rfp.createdAt.toISOString(),
    updatedAt: rfp.updatedAt.toISOString(),
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listRfpsBackendSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, status, q } = parsed.data
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const where: Record<string, unknown> = { organizationId: auth.orgId, deletedAt: null }
  if (status) where.status = status
  if (q) where.title = { $ilike: `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%` }
  const [items, total] = await findAndCountWithDecryption(
    em,
    Rfp,
    where as any,
    {
      orderBy: { createdAt: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )
  return NextResponse.json({
    ok: true,
    items: items.map(summariseRfp),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = createRfpDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('rfpService') as RfpService
  try {
    const rfp = await service.createDraft(parsed.data, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({ ok: true, id: rfp.id, rfp: summariseRfp(rfp) }, { status: 201 })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const rfpResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  title: z.string(),
  status: z.enum(RFP_STATUSES),
  eligibilityFilter: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List RFPs (B6)',
  description: 'Returns paginated RFPs for the calling organization. Backend-only.',
  tags: ['PRM RFPs'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(rfpResponseSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Create RFP draft (US5.1)',
  description: 'Creates an RFP at status=draft. Validates eligibility filter companion fields.',
  tags: ['PRM RFPs'],
  responses: [
    {
      status: 201,
      description: 'Created',
      schema: z.object({ ok: z.literal(true), id: z.string().uuid(), rfp: rfpResponseSchema }),
    },
    {
      status: 400,
      description: 'Validation failed.',
      schema: z.object({ ok: z.literal(false), error: z.string() }),
    },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM RFP CRUD (B6/B7)',
  description: 'Backend-only CRUD over the PRM RFP aggregate.',
  methods: { GET: getDoc, POST: postDoc },
}
