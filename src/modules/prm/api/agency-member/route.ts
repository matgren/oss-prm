import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency, AgencyMember } from '../../data/entities'

/**
 * B3 cross-agency members read-only listing (also exposes the GH-profile conflict-search
 * surface for OM-staff diagnostics).
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency_member.read_all'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(120).optional(),
  githubProfile: z.string().trim().min(1).max(64).optional(),
  agencyId: z.string().uuid().optional(),
})

export const agencyMemberSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  agencyId: z.string().uuid(),
  customerUserId: z.string().uuid().nullable(),
  invitationId: z.string().uuid().nullable(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  roleInAgency: z.string().nullable(),
  githubProfile: z.string().nullable(),
  isActive: z.boolean(),
  invitedAt: z.string(),
  activatedAt: z.string().nullable(),
  agencyStatus: z.string(),
  roleSlug: z.string(),
  agencyName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export function summariseAgencyMember(member: AgencyMember, agencyName?: string) {
  return {
    id: member.id,
    tenantId: member.tenantId,
    agencyId: member.agencyId,
    customerUserId: member.customerUserId ?? null,
    invitationId: member.invitationId ?? null,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    roleInAgency: member.roleInAgency ?? null,
    githubProfile: member.githubProfile ?? null,
    isActive: member.isActive,
    invitedAt: member.invitedAt.toISOString(),
    activatedAt: member.activatedAt ? member.activatedAt.toISOString() : null,
    agencyStatus: member.agencyStatus,
    roleSlug: member.roleSlug,
    ...(agencyName ? { agencyName } : {}),
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  }
}

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
  const { page, pageSize, q, githubProfile, agencyId } = parsed.data

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const where: Record<string, unknown> = { tenantId: auth.tenantId, deletedAt: null }
  if (agencyId) where.agencyId = agencyId
  if (githubProfile) where.githubProfile = githubProfile
  if (q) {
    const escaped = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`
    Object.assign(where, {
      $or: [
        { firstName: { $ilike: escaped } },
        { lastName: { $ilike: escaped } },
        { email: { $ilike: escaped } },
      ],
    })
  }
  const [items, total] = await em.findAndCount(AgencyMember, where as any, {
    orderBy: { createdAt: 'desc' },
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })

  // Hydrate agency_name (avoid N+1).
  const agencyIds = Array.from(new Set(items.map((m) => m.agencyId)))
  const agencyNameById = new Map<string, string>()
  if (agencyIds.length > 0) {
    const agencies = await em.find(
      Agency,
      { id: { $in: agencyIds } as any, tenantId: auth.tenantId, deletedAt: null },
      { fields: ['id', 'name'] as any },
    )
    for (const a of agencies) agencyNameById.set(a.id, a.name)
  }

  return NextResponse.json({
    ok: true,
    items: items.map((m) => summariseAgencyMember(m, agencyNameById.get(m.agencyId))),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'Cross-agency members read-only (B3)',
  tags: ['PRM Agencies'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(agencyMemberSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [{ status: 401, description: 'Unauthenticated', schema: errorSchema }],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Cross-agency members (read-only)',
  methods: { GET: getDoc },
}
