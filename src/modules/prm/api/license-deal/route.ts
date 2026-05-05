import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  createLicenseDealSchema,
  listLicenseDealsBackendSchema,
} from '../../data/validators'
import { LicenseDeal } from '../../data/entities'
import type { LicenseDealService } from '../../lib/licenseDealService'
import { PrmDomainError, toPrmErrorBody } from '../../lib/errors'

/**
 * Backend LicenseDeal list + create (Spec #3 — attribution-loop, B5).
 *
 *   GET  /api/prm/license-deal          → list
 *   POST /api/prm/license-deal          → create (always lands as `pending`)
 *
 * Auth + RBAC enforced declaratively via metadata; tenant scoping applied
 * inside the handler against `auth.tenantId`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.license_deal.read'] },
  POST: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
}

export function summariseLicenseDeal(deal: LicenseDeal) {
  return {
    id: deal.id,
    tenantId: deal.tenantId,
    organizationId: deal.organizationId,
    licenseIdentifier: deal.licenseIdentifier,
    clientCompanyName: deal.clientCompanyName,
    clientIndustry: deal.clientIndustry ?? null,
    type: deal.type,
    status: deal.status,
    isRenewal: deal.isRenewal,
    previousLicenseDealId: deal.previousLicenseDealId ?? null,
    closedAt: deal.closedAt?.toISOString() ?? null,
    signedAt: deal.signedAt?.toISOString() ?? null,
    annualValueUsd: deal.annualValueUsd ?? null,
    monthlyLicenseAmount: deal.monthlyLicenseAmount ?? null,
    attributionPath: deal.attributionPath,
    attributionSource: deal.attributionSource,
    prospectId: deal.prospectId ?? null,
    rfpId: deal.rfpId ?? null,
    attributedAgencyId: deal.attributedAgencyId ?? null,
    attributionReasoning: deal.attributionReasoning ?? null,
    attributedAt: deal.attributedAt?.toISOString() ?? null,
    notes: deal.notes ?? null,
    version: deal.version,
    createdAt: deal.createdAt.toISOString(),
    updatedAt: deal.updatedAt.toISOString(),
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listLicenseDealsBackendSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  const { items, total } = await service.list(parsed.data, { tenantId: auth.tenantId })
  return NextResponse.json({
    ok: true,
    items: items.map(summariseLicenseDeal),
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
  })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = createLicenseDealSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const deal = await service.create(parsed.data, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })
    return NextResponse.json({ ok: true, licenseDeal: summariseLicenseDeal(deal) }, { status: 201 })
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

const licenseDealSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  licenseIdentifier: z.string(),
  clientCompanyName: z.string(),
  clientIndustry: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  isRenewal: z.boolean(),
  previousLicenseDealId: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
  signedAt: z.string().nullable(),
  annualValueUsd: z.string().nullable(),
  monthlyLicenseAmount: z.string().nullable(),
  attributionPath: z.string(),
  attributionSource: z.string(),
  prospectId: z.string().uuid().nullable(),
  rfpId: z.string().uuid().nullable(),
  attributedAgencyId: z.string().uuid().nullable(),
  attributionReasoning: z.string().nullable(),
  attributedAt: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List license deals (B5)',
  description: 'Backend cross-tenant license-deals list. Filters by status, attribution path, agency, and free-text query.',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(licenseDealSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Create a license deal (always lands as `pending`)',
  tags: ['PRM Backend'],
  requestBody: { schema: createLicenseDealSchema, description: 'License deal create payload' },
  responses: [
    {
      status: 201,
      description: 'Created',
      schema: z.object({ ok: z.literal(true), licenseDeal: licenseDealSchema }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 409, description: 'License identifier already taken', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'License deals list + create',
  description: 'OM PartnerOps backend — license-deal CRUD root.',
  methods: { GET: getDoc, POST: postDoc },
}
