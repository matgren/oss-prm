import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency, MarketingMaterial } from '../../../../../data/entities'
import type { AgencyMemberService } from '../../../../../lib/agencyMemberService'
import { tierRank } from '../../../../../lib/tierRank'
import { z } from 'zod'

/**
 * P11 — download redirect (Spec #7 §3.4 / §6.3).
 *
 *   GET /api/prm/portal/library/:id/download
 *
 * Re-checks the publish state + tier gate before issuing the redirect.
 * This closes the window where an old URL could grant post-unpublish
 * access, even if the cached library list still references the row.
 *
 * The actual download URL is built by the `attachments` module's
 * `buildAttachmentImageUrl` helper. v1 returns the canonical path for
 * the attachment (`/api/attachments/.../{file}`) — the route ACL on
 * that side rejects cross-tenant access.
 */
export const metadata = {}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
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
  if (!member) return NextResponse.json({ ok: false, error: 'Not allowed' }, { status: 403 })

  const em = container.resolve('em') as EntityManager
  const agency = await em.findOne(Agency, { id: member.agencyId } as any)
  const viewerRank = tierRank(agency?.tier ?? null)
  const material = await em.findOne(MarketingMaterial, {
    id: params.id,
    organizationId: auth.orgId,
  } as any)
  if (!material) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }
  if (!material.publishedAt || material.unpublishedAt) {
    return NextResponse.json({ ok: false, error: 'Not available' }, { status: 404 })
  }
  if (material.visibility === 'tier_gated') {
    if (viewerRank === null || (material.minTierRank ?? Infinity) > viewerRank) {
      return NextResponse.json({ ok: false, error: 'Not available' }, { status: 404 })
    }
  }

  // v1 builds the canonical attachment path — the attachments module
  // owns the actual storage URL via its own route ACL. If the
  // attachments module ships a `buildAttachmentImageUrl` helper, the
  // server can swap to a 302; for v1 portability we return the JSON
  // surface and let the client follow it.
  const downloadUrl = `/api/attachments/${material.primaryAttachmentId}`
  return NextResponse.json({
    ok: true,
    download: { url: downloadUrl, attachmentId: material.primaryAttachmentId },
  })
}

const getDoc: OpenApiMethodDoc = {
  summary: 'Resolve marketing material download URL',
  description: 'Re-checks publish + tier gate at request time. Returns the attachment download URL.',
  tags: ['PRM Portal Library'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({ ok: z.literal(true), download: z.object({ url: z.string(), attachmentId: z.string().uuid() }) }),
    },
    { status: 404, description: 'Not available (unpublished or tier-gated below viewer)' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM portal — library download',
  methods: { GET: getDoc },
}
