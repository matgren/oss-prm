import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { listLibraryPortalSchema } from '../../../data/validators'
import {
  type MarketingMaterialService,
  toPublicLibraryDto,
} from '../../../lib/marketingMaterialService'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import { Agency } from '../../../data/entities'

/**
 * P11 — Portal Marketing Library (Spec #7 §3.4 / US7.2).
 *
 *   GET /api/prm/portal/library
 *
 * Server-applied tier gate (`min_tier_rank ≤ viewer_rank`). Cache tags:
 *   `prm:library`
 *   `prm:agency:${agencyId}:tier:${tier}`
 * Per-feature `cache.deleteByTags` invalidator subscribers (commit 5)
 * react to `prm.marketing_material.published / unpublished / updated`
 * and `prm.agency.tier_changed`.
 *
 * The `min_tier` field is NEVER exposed to the portal viewer — a viewer
 * below tier never sees the row at all; an at-tier viewer doesn't need
 * to know the gate exists.
 */
export const metadata = {}

export async function GET(req: Request) {
  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }
  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, ['portal.partner.access'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({
      ok: true,
      items: [],
      facets: { material_types: [], topics: [], audiences: [] },
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    })
  }

  const em = container.resolve('em') as EntityManager
  const agency = await em.findOne(Agency, { id: member.agencyId } as any)
  const viewerTier = agency?.tier ?? null

  const url = new URL(req.url)
  const params = Object.fromEntries(url.searchParams.entries())
  if (url.searchParams.has('topics')) {
    ;(params as any).topics = url.searchParams.getAll('topics')
  }
  if (url.searchParams.has('audiences')) {
    ;(params as any).audiences = url.searchParams.getAll('audiences')
  }
  const parsed = listLibraryPortalSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, materialType, topics, audiences } = parsed.data

  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  const { items, total } = await service.listPublishedForViewer(
    { organizationId: auth.orgId, viewerTier },
    {
      materialType,
      topics,
      audiences,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  )

  // Facets are computed across the same tier-gated result set (full set,
  // not the paginated slice) so the user sees a consistent option list.
  const allForFacets = await service.listPublishedForViewer(
    { organizationId: auth.orgId, viewerTier },
    { materialType: undefined, topics: undefined, audiences: undefined, limit: 1_000, offset: 0 },
  )
  const facets = computeFacets(allForFacets.items)

  return NextResponse.json({
    ok: true,
    items: items.map(toPublicLibraryDto),
    facets,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

function computeFacets(rows: ReadonlyArray<{ materialType: string; topics: string[]; audiences: string[] }>) {
  const types = new Map<string, number>()
  const topicsMap = new Map<string, number>()
  const audiencesMap = new Map<string, number>()
  for (const row of rows) {
    types.set(row.materialType, (types.get(row.materialType) ?? 0) + 1)
    for (const t of row.topics) topicsMap.set(t, (topicsMap.get(t) ?? 0) + 1)
    for (const a of row.audiences) audiencesMap.set(a, (audiencesMap.get(a) ?? 0) + 1)
  }
  return {
    material_types: [...types.entries()].map(([value, count]) => ({ value, count })),
    topics: [...topicsMap.entries()].map(([value, count]) => ({ value, count })),
    audiences: [...audiencesMap.entries()].map(([value, count]) => ({ value, count })),
  }
}

const itemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  materialType: z.string(),
  primaryAttachmentDownloadPath: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Portal Marketing Library list (P11)',
  description: 'Tier-gated list of published MarketingMaterials for the calling Agency.',
  tags: ['PRM Portal Library'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(itemSchema),
        facets: z.object({
          material_types: z.array(z.object({ value: z.string(), count: z.number() })),
          topics: z.array(z.object({ value: z.string(), count: z.number() })),
          audiences: z.array(z.object({ value: z.string(), count: z.number() })),
        }),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM portal — Marketing Library',
  methods: { GET: getDoc },
}
