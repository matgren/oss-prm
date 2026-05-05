import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  findOneWithDecryption,
  findWithDecryption,
} from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  listProspectsBackendSchema,
  normalizeCompanyName,
  normalizeContactEmail,
} from '../../data/validators'
import { Agency, Prospect } from '../../data/entities'
import { summariseProspect } from '../portal/prospects/route'

/**
 * Backend B4 — cross-agency Prospect read (Spec #2 §3.2 — wip-scoreboard).
 *
 * Read-only. Used by OM PartnerOps for audit and (Phase 3) by Spec #3's attribution
 * candidate-picker. No writes go through here; all Prospect mutations are portal-only.
 *
 * Reads from `prm_prospect_candidate_index` (the projection) so candidate-search
 * can leverage the normalized keys. Default ordering is `registered_at ASC` to match
 * the Golden Rule (oldest-first) candidate-picker.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.prospect.read_cross_agency'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listProspectsBackendSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, agencyId, status, normalizedCompanyName, lowercasedContactEmail } = parsed.data

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const knex = em.getKnex()

  const wantsKeyedFilter = !!normalizedCompanyName || !!lowercasedContactEmail
  let prospectIds: string[] | null = null
  let total = 0

  if (wantsKeyedFilter) {
    // Server normalizes the input to match the index column.
    const ixQuery = knex('prm_prospect_candidate_index as ix')
      .where('ix.agency_id', knex.raw('ix.agency_id'))
      .orderBy('ix.registered_at', 'asc')
    if (agencyId) ixQuery.where('ix.agency_id', agencyId)
    if (status) ixQuery.where('ix.current_status', status)
    if (normalizedCompanyName) {
      ixQuery.where('ix.normalized_company_name', normalizeCompanyName(normalizedCompanyName))
    }
    if (lowercasedContactEmail) {
      ixQuery.where('ix.lowercased_contact_email', normalizeContactEmail(lowercasedContactEmail))
    }
    // Tenant scope is asserted via the join below by filtering on prm_prospects.tenant_id.
    const idsQuery = ixQuery
      .clone()
      .join('prm_prospects as p', 'p.id', 'ix.prospect_id')
      .where('p.tenant_id', auth.tenantId)
      .whereNull('p.deleted_at')
      .select('ix.prospect_id')
    const totalRow = (await idsQuery
      .clone()
      .clearOrder()
      .clearSelect()
      .count<{ count: string }[]>('* as count')) as Array<{ count: string }>
    total = Number(totalRow[0]?.count ?? 0)
    const idRows = (await idsQuery.limit(pageSize).offset((page - 1) * pageSize)) as Array<{
      prospect_id: string
    }>
    prospectIds = idRows.map((r) => r.prospect_id)
    if (prospectIds.length === 0) {
      return NextResponse.json({
        ok: true,
        items: [],
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      })
    }
  }

  const where: Record<string, unknown> = { tenantId: auth.tenantId, deletedAt: null }
  if (prospectIds) where.id = { $in: prospectIds }
  if (agencyId) where.agencyId = agencyId
  if (status) where.status = status

  // Default route reads through the projection table for candidate-picker fairness.
  // When no normalized-key filter is provided, fall back to direct list ordered ascending
  // by registered_at (Golden Rule).
  const items = await findWithDecryption(
    em,
    Prospect,
    where as any,
    {
      orderBy: { registeredAt: 'asc' as const, id: 'asc' as const },
      limit: prospectIds ? prospectIds.length : pageSize,
      offset: prospectIds ? 0 : (page - 1) * pageSize,
    },
    { tenantId: auth.tenantId },
  )

  if (!prospectIds) {
    const totalCount = (await knex('prm_prospects')
      .where('tenant_id', auth.tenantId)
      .whereNull('deleted_at')
      .modify((q) => {
        if (agencyId) q.where('agency_id', agencyId)
        if (status) q.where('status', status)
      })
      .count<{ count: string }[]>('* as count')) as Array<{ count: string }>
    total = Number(totalCount[0]?.count ?? 0)
  }

  // Resolve agency names in a single follow-up query (denormalised into response payload).
  const distinctAgencyIds = Array.from(new Set(items.map((p) => p.agencyId)))
  const agencyById = new Map<string, string>()
  if (distinctAgencyIds.length > 0) {
    const agencies = await findWithDecryption(
      em,
      Agency,
      { id: { $in: distinctAgencyIds }, tenantId: auth.tenantId, deletedAt: null } as any,
      undefined,
      { tenantId: auth.tenantId },
    )
    for (const a of agencies) agencyById.set(a.id, a.name)
  }

  return NextResponse.json({
    ok: true,
    items: items.map((p) => ({
      ...summariseProspect(p),
      agencyName: agencyById.get(p.agencyId) ?? null,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const prospectSchema = z.object({
  id: z.string().uuid(),
  agencyId: z.string().uuid(),
  agencyName: z.string().nullable(),
  organizationId: z.string().uuid(),
  companyName: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  source: z.string(),
  status: z.string(),
  lostReason: z.string().nullable(),
  notes: z.string().nullable(),
  registeredAt: z.string(),
  statusChangedAt: z.string(),
  registeredByAgencyMemberId: z.string().uuid(),
})

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List prospects across all agencies (B4 / Spec #3 candidate-picker)',
  description:
    'OM staff cross-agency read. Filters use the projection table for normalized-key search. Default order is registered_at ASC (Golden Rule).',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(prospectSchema),
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
    { status: 403, description: 'Forbidden (cross-agency feature missing)', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'B4 cross-agency Prospect list',
  description: 'OM PartnerOps + Admin only. No writes.',
  methods: { GET: getDoc },
}

export const __prospectsApiTesting = { listProspectsBackendSchema }
