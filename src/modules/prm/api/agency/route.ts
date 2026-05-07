import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency } from '../../data/entities'
import { createAgencySchema } from '../../data/validators'
import type { AgencyService } from '../../lib/agencyService'
import { isPrmDomainError, toPrmErrorBody } from '../../lib/errors'

/**
 * Backend Agency CRUD route.
 *
 * Auth + RBAC enforced declaratively via the route metadata; the framework's catch-all
 * runs `RbacService.userHasAllFeatures` against the listed features before invoking
 * the handler. Tenant scoping is applied inside the handler against `auth.tenantId`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency.read'] },
  POST: { requireAuth: true, requireFeatures: ['prm.agency.create'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['active', 'historical']).optional(),
  tier: z.enum(['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core']).optional(),
  q: z.string().trim().min(1).max(120).optional(),
})

function summariseAgency(agency: Agency) {
  return {
    id: agency.id,
    organizationId: agency.organizationId,
    tenantId: agency.tenantId,
    name: agency.name,
    slug: agency.slug,
    description: agency.description,
    websiteUrl: agency.websiteUrl,
    logoUrl: agency.logoUrl,
    headquartersCountry: agency.headquartersCountry,
    headquartersCity: agency.headquartersCity,
    teamSizeBucket: agency.teamSizeBucket,
    industries: agency.industries ?? [],
    services: agency.services ?? [],
    techCapabilities: agency.techCapabilities ?? [],
    tier: agency.tier,
    status: agency.status,
    contractSigned: agency.contractSigned,
    ndaSigned: agency.ndaSigned,
    onboarded: agency.onboarded,
    /** Optimistic-concurrency token — clients echo back as `ifMatchVersion` on PATCH. */
    version: agency.version,
    createdAt: agency.createdAt.toISOString(),
    updatedAt: agency.updatedAt.toISOString(),
  }
}

export { summariseAgency }

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, status, tier, q } = parsed.data
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const where: Record<string, unknown> = { tenantId: auth.tenantId, deletedAt: null }
  if (status) where.status = status
  if (tier) where.tier = tier
  if (q) where.name = { $ilike: `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%` }

  const [items, total] = await findAndCountWithDecryption(
    em,
    Agency,
    where as any,
    {
      orderBy: { createdAt: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
    { tenantId: auth.tenantId },
  )
  return NextResponse.json({
    ok: true,
    items: items.map(summariseAgency),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = createAgencySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const agencyService = container.resolve('agencyService') as AgencyService
  try {
    const agency = await agencyService.createAgencyWithOrganization(parsed.data, {
      tenantId: auth.tenantId,
      userId: typeof auth.sub === 'string' ? auth.sub : null,
    })
    return NextResponse.json({ ok: true, agency: summariseAgency(agency) }, { status: 201 })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const agencySummarySchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  headquartersCountry: z.string(),
  headquartersCity: z.string().nullable(),
  teamSizeBucket: z.string().nullable(),
  industries: z.array(z.string()),
  services: z.array(z.string()),
  techCapabilities: z.array(z.string()),
  tier: z.string(),
  status: z.string(),
  contractSigned: z.boolean(),
  ndaSigned: z.boolean(),
  onboarded: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List agencies (B1)',
  description: 'Returns paginated agencies for the calling tenant.',
  tags: ['PRM Agencies'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(agencySummarySchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Create agency (US1.1)',
  description: 'Creates a paired Organization + Agency in one transaction.',
  tags: ['PRM Agencies'],
  requestBody: { schema: createAgencySchema, description: 'Agency creation payload' },
  responses: [
    { status: 201, description: 'Created', schema: z.object({ ok: z.literal(true), agency: agencySummarySchema }) },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 409, description: 'Slug already taken', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Agency CRUD (B1)',
  description: 'Backend-only CRUD over the PRM Agency aggregate.',
  methods: { GET: getDoc, POST: postDoc },
}

export const __agencyApiTesting = { listQuerySchema, summariseAgency }
