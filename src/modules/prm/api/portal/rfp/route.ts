import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Rfp, RfpBroadcast, RfpResponse } from '../../../data/entities'
import { listRfpPortalInboxSchema, RFP_PORTAL_VISIBLE_STATUSES } from '../../../data/validators'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'

/**
 * Portal P9 — Agency-side RFP inbox (Spec #5 §3.2 / US5.3).
 *
 *   GET /api/prm/portal/rfp        → tabbed inbox list
 *
 * Visibility (invariant #15): an Agency only sees RFPs it was broadcasted to.
 * The list is built by:
 *   1. Resolving the calling CustomerUser → AgencyMember → agencyId.
 *   2. Loading `RfpBroadcast` rows for that agencyId in the active tenant.
 *   3. Joining each broadcast against its `Rfp` (filtered to portal-visible
 *      statuses — `published`, `scoring`, `selection_made`).
 *
 * Tabs (UI-driven; semantics frozen for downstream Spec #6/#7 widgets):
 *   - `unread`     — broadcasts with `first_opened_at IS NULL` and no response,
 *                    not declined.
 *   - `responded`  — at least one `RfpResponse` row exists for this Agency.
 *   - `declined`   — `declined_at IS NOT NULL`.
 *   - `all`        — every broadcast for the Agency in a portal-visible RFP
 *                    status (this is the v1 superset).
 *
 * Pagination is over broadcast rows (not RFPs); the response shape mirrors
 * the rest of the portal listing routes for client-side reuse.
 */
export const metadata = {}

export type RfpPortalInboxItem = {
  broadcastId: string
  rfpId: string
  rfp: {
    id: string
    title: string
    receivedFrom: string
    receivedAt: string
    status: string
    industry: string | null
    budgetBucket: string | null
    timelineBucket: string | null
    deadlineToRespond: string | null
  }
  broadcastedAt: string
  firstOpenedAt: string | null
  declinedAt: string | null
  declineReason: string | null
  hasResponse: boolean
  responseStatus: 'draft' | 'submitted' | null
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

  const url = new URL(req.url)
  const parsed = listRfpPortalInboxSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, tab } = parsed.data

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    // Unlinked CustomerUsers see an empty inbox — same shape as a real list.
    return NextResponse.json({
      ok: true,
      items: [],
      page,
      pageSize,
      total: 0,
      totalPages: 1,
      tab,
    })
  }

  const em = container.resolve('em') as EntityManager
  const baseWhere: Record<string, unknown> = {
    agencyId: member.agencyId,
    organizationId: auth.orgId,
  }
  // Tab → broadcast-level filter (the response-existence checks happen below).
  if (tab === 'unread') {
    baseWhere.firstOpenedAt = null
    baseWhere.declinedAt = null
  } else if (tab === 'declined') {
    baseWhere.declinedAt = { $ne: null }
  }

  const broadcasts = await em.find(RfpBroadcast, baseWhere as any, {
    orderBy: { broadcastAt: 'desc' },
  })

  // Filter against portal-visible RFP statuses + (optionally) response state.
  const rfpIds = broadcasts.map((b) => b.rfpId)
  if (rfpIds.length === 0) {
    return NextResponse.json({
      ok: true,
      items: [],
      page,
      pageSize,
      total: 0,
      totalPages: 1,
      tab,
    })
  }

  const rfps = await findWithDecryption<Rfp>(
    em,
    Rfp,
    { id: { $in: rfpIds }, organizationId: auth.orgId, deletedAt: null } as any,
    { fields: ['id', 'title', 'receivedFrom', 'receivedAt', 'status', 'industry', 'budgetBucket', 'timelineBucket', 'deadlineToRespond'] as never },
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )
  const rfpById = new Map(rfps.map((r) => [r.id, r]))

  // Response existence — needed for `responded` tab + every item's hasResponse flag.
  const responses = await em.find(RfpResponse, {
    rfpId: { $in: rfpIds },
    agencyId: member.agencyId,
    organizationId: auth.orgId,
  } as any)
  const responseByRfpId = new Map(responses.map((r) => [r.rfpId, r]))

  const filtered = broadcasts
    .map((b) => ({ broadcast: b, rfp: rfpById.get(b.rfpId) ?? null }))
    .filter((row) => row.rfp !== null)
    .filter((row) => (RFP_PORTAL_VISIBLE_STATUSES as readonly string[]).includes(row.rfp!.status))
    .filter((row) => {
      if (tab === 'responded') {
        return responseByRfpId.has(row.broadcast.rfpId)
      }
      if (tab === 'unread') {
        // No response yet AND broadcast has no first-open / decline stamp.
        return !responseByRfpId.has(row.broadcast.rfpId)
      }
      return true
    })

  const total = filtered.length
  const start = (page - 1) * pageSize
  const slice = filtered.slice(start, start + pageSize)
  const items: RfpPortalInboxItem[] = slice.map(({ broadcast, rfp }) => {
    const response = responseByRfpId.get(broadcast.rfpId) ?? null
    return {
      broadcastId: broadcast.id,
      rfpId: broadcast.rfpId,
      rfp: {
        id: rfp!.id,
        title: rfp!.title,
        receivedFrom: rfp!.receivedFrom,
        receivedAt: rfp!.receivedAt.toISOString(),
        status: rfp!.status,
        industry: rfp!.industry ?? null,
        budgetBucket: rfp!.budgetBucket ?? null,
        timelineBucket: rfp!.timelineBucket ?? null,
        deadlineToRespond: rfp!.deadlineToRespond ? rfp!.deadlineToRespond.toISOString() : null,
      },
      broadcastedAt: broadcast.broadcastAt.toISOString(),
      firstOpenedAt: broadcast.firstOpenedAt ? broadcast.firstOpenedAt.toISOString() : null,
      declinedAt: broadcast.declinedAt ? broadcast.declinedAt.toISOString() : null,
      declineReason: broadcast.declineReason ?? null,
      hasResponse: response !== null,
      responseStatus: (response?.status as 'draft' | 'submitted' | undefined) ?? null,
    }
  })

  return NextResponse.json({
    ok: true,
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    tab,
  })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const inboxItemSchema = z.object({
  broadcastId: z.string().uuid(),
  rfpId: z.string().uuid(),
  rfp: z.object({
    id: z.string().uuid(),
    title: z.string(),
    receivedFrom: z.string(),
    receivedAt: z.string(),
    status: z.string(),
    industry: z.string().nullable(),
    budgetBucket: z.string().nullable(),
    timelineBucket: z.string().nullable(),
    deadlineToRespond: z.string().nullable(),
  }),
  broadcastedAt: z.string(),
  firstOpenedAt: z.string().nullable(),
  declinedAt: z.string().nullable(),
  declineReason: z.string().nullable(),
  hasResponse: z.boolean(),
  responseStatus: z.enum(['draft', 'submitted']).nullable(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Portal RFP inbox (P9 / US5.3)',
  description: 'Tabbed list of RFPs broadcasted to the calling Agency. Visibility-gated by RfpBroadcast presence + portal-visible RFP statuses.',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(inboxItemSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
        tab: z.string(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Missing portal.partner.access', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal RFP inbox',
  description: 'Authenticated CustomerUser session — own-agency scoped to broadcasts.',
  methods: { GET: getDoc },
}
