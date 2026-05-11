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
import {
  LIBRARY_CACHE_TAG,
  LIBRARY_CACHE_TTL_MS,
  agencyTierTag,
  buildLibraryCacheKey,
} from '../../../lib/libraryCache'

/**
 * P11 — Portal Marketing Library (Spec #7 §3.4 / US7.2).
 *
 *   GET /api/prm/portal/library
 *
 * Server-applied tier gate (`min_tier_rank ≤ viewer_rank`) — defense-in-depth:
 * the cache key includes the viewer's `agencyId` and `tier`, AND the SQL
 * filter inside `MarketingMaterialService.listPublishedForViewer` re-applies
 * the visibility rule on every cache miss. Either layer alone would be
 * sufficient; both together survive a cache-key drift.
 *
 * Cache (Spec #7 §3.4):
 *   key   = `prm:portal:library:${orgId}:${agencyId}:${tier|null}:${sha1(params)}`
 *   tags  = [`prm:library`, `prm:agency:${agencyId}:tier:${tier|null}`]
 *   ttl   = 15 minutes (`LIBRARY_CACHE_TTL_MS`)
 *
 * Per-feature `cache.deleteByTags` invalidator subscribers
 * (`subscribers/marketing-library-{published,unpublished,updated}-invalidator.ts`,
 * `subscribers/agency-tier-change-library-invalidator.ts`) react to
 * `prm.marketing_material.{published,unpublished,updated}` and
 * `prm.agency.tier_changed` and bust the matching tags.
 *
 * Cache reads/writes soft-fail to a direct DB query — never break the user.
 *
 * The `min_tier` field is NEVER exposed to the portal viewer — a viewer
 * below tier never sees the row at all; an at-tier viewer doesn't need
 * to know the gate exists.
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
}

type LibraryResponseBody = {
  ok: true
  items: ReturnType<typeof toPublicLibraryDto>[]
  facets: ReturnType<typeof computeFacets>
  page: number
  pageSize: number
  total: number
  totalPages: number
}

type CacheLikeRW = {
  get?: (key: string) => Promise<unknown>
  set?: (
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[] },
  ) => Promise<unknown>
}

async function tryReadCache(
  cache: CacheLikeRW | null,
  key: string,
): Promise<LibraryResponseBody | null> {
  if (!cache || typeof cache.get !== 'function') return null
  try {
    const cached = await cache.get(key)
    if (cached && typeof cached === 'object' && (cached as { ok?: unknown }).ok === true) {
      return cached as LibraryResponseBody
    }
    return null
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[prm:portal:library] cache.get failed; falling through to DB', err)
    }
    return null
  }
}

async function tryWriteCache(
  cache: CacheLikeRW | null,
  key: string,
  body: LibraryResponseBody,
  tags: string[],
): Promise<void> {
  if (!cache || typeof cache.set !== 'function') return
  try {
    await cache.set(key, body, { ttl: LIBRARY_CACHE_TTL_MS, tags })
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[prm:portal:library] cache.set failed; serving uncached response', err)
    }
  }
}

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
    // Empty no-op response — intentionally NOT cached (no agencyId means
    // we'd have to invent a synthetic key, and the response is cheap).
    return NextResponse.json({
      ok: true,
      items: [],
      facets: { material_types: [], topics: [] },
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    })
  }

  const em = container.resolve('em') as EntityManager
  const agency = await em.findOne(Agency, { id: member.agencyId } as any)
  const viewerTier = agency?.tier ?? null
  // Single role slug from the AgencyMember (the canonical mirror of the
  // customer-role assignment for v1 — partner_admin / partner_member).
  const viewerRoleSlugs = member.roleSlug ? [member.roleSlug] : []

  const url = new URL(req.url)
  const params = Object.fromEntries(url.searchParams.entries())
  if (url.searchParams.has('topics')) {
    ;(params as any).topics = url.searchParams.getAll('topics')
  }
  const parsed = listLibraryPortalSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, materialType, topics } = parsed.data

  // Cache layer. Soft-fail at every point — the §8.4 perf model leans on
  // the cache but correctness leans on the DB query + tier gate.
  let cache: CacheLikeRW | null = null
  try {
    cache = container.resolve<CacheLikeRW>('cache')
  } catch {
    cache = null
  }
  const cacheKey = buildLibraryCacheKey({
    orgId: auth.orgId,
    agencyId: member.agencyId,
    tier: viewerTier,
    params: { page, pageSize, materialType, topics, viewerRoleSlugs },
  })
  const cacheTags = [LIBRARY_CACHE_TAG, agencyTierTag(member.agencyId, viewerTier)]

  const cached = await tryReadCache(cache, cacheKey)
  if (cached) return NextResponse.json(cached)

  const service = container.resolve('marketingMaterialService') as MarketingMaterialService
  // Tenant-wide visibility per the shared-library model: OM Marketing
  // publishes once, every agency in the tenant sees it (gated by tier +
  // role + topics). Replaces the legacy organizationId-equality scoping
  // that hid cross-org materials from agency viewers.
  const { items, total } = await service.listPublishedForViewer(
    { tenantId: auth.tenantId, viewerTier },
    {
      materialType,
      topics,
      viewerRoleSlugs,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  )

  // Facets are computed across the same tier-gated + role-gated result set
  // (full set, not the paginated slice) so the user sees a consistent option
  // list.
  const allForFacets = await service.listPublishedForViewer(
    { tenantId: auth.tenantId, viewerTier },
    { materialType: undefined, topics: undefined, viewerRoleSlugs, limit: 1_000, offset: 0 },
  )
  const facets = computeFacets(allForFacets.items)

  const body: LibraryResponseBody = {
    ok: true,
    items: items.map(toPublicLibraryDto),
    facets,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }

  // Fire-and-forget cache write — failure does not block the response.
  await tryWriteCache(cache, cacheKey, body, cacheTags)

  return NextResponse.json(body)
}

function computeFacets(rows: ReadonlyArray<{ materialType: string; topics: string[] }>) {
  const types = new Map<string, number>()
  const topicsMap = new Map<string, number>()
  for (const row of rows) {
    types.set(row.materialType, (types.get(row.materialType) ?? 0) + 1)
    for (const t of row.topics) topicsMap.set(t, (topicsMap.get(t) ?? 0) + 1)
  }
  return {
    material_types: [...types.entries()].map(([value, count]) => ({ value, count })),
    topics: [...topicsMap.entries()].map(([value, count]) => ({ value, count })),
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
