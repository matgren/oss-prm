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
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { RfpResponse } from '../../../../data/entities'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import type { RfpService } from '../../../../lib/rfpService'
import {
  assertBroadcastedOrNotFound,
  RfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../lib/rfpVisibility'

/**
 * Portal P10 — Agency-side RFP detail (Spec #5 §3.2 / US5.3).
 *
 *   GET /api/prm/portal/rfp/{id}     → full RFP brief + own-Agency response
 *
 * Visibility gate: every code path funnels through `assertBroadcastedOrNotFound`
 * before touching RFP-shaped data. Any failure returns the canonical
 * `{ ok: false, error: 'Not found' }` 404 — byte-identical to a fake-UUID 404
 * (R3 / invariant #15).
 *
 * Side effect (US5.3 / §3.3): on first call, stamps
 * `RfpBroadcast.first_opened_at` and emits `prm.rfp_broadcast.first_opened`.
 * Idempotent — second GET is a no-op (no extra event, no stamp drift).
 */
export const metadata = {}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> | { id: string } },
) {
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

  const params = await Promise.resolve(ctx.params)
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    // Unlinked CustomerUsers can't be broadcasted-to; uniform 404.
    return rfpNotFoundResponse()
  }

  const em = container.resolve('em') as EntityManager

  let rfp
  let broadcast
  try {
    const result = await assertBroadcastedOrNotFound(params.id, member.agencyId, em, {
      organizationId: auth.orgId,
    })
    rfp = result.rfp
    broadcast = result.broadcast
  } catch (err) {
    if (err instanceof RfpVisibilityNotFoundError) return rfpNotFoundResponse()
    throw err
  }

  // First-open side effect (idempotent at the DB layer).
  const rfpService = container.resolve('rfpService') as RfpService
  await rfpService.markBroadcastFirstOpened(broadcast, { organizationId: auth.orgId })

  // Optional own-Agency response (used by P10 to pre-fill the form).
  const response = await findOneWithDecryption(
    em,
    RfpResponse,
    {
      rfpId: rfp.id,
      agencyId: member.agencyId,
      organizationId: auth.orgId,
    } as any,
    undefined,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )

  return NextResponse.json({
    ok: true,
    rfp: {
      id: rfp.id,
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
      status: rfp.status,
    },
    broadcast: {
      id: broadcast.id,
      broadcastedAt: broadcast.broadcastAt.toISOString(),
      firstOpenedAt: broadcast.firstOpenedAt ? broadcast.firstOpenedAt.toISOString() : null,
      declinedAt: broadcast.declinedAt ? broadcast.declinedAt.toISOString() : null,
      declineReason: broadcast.declineReason ?? null,
    },
    response: response
      ? {
          id: response.id,
          status: response.status,
          techExperience: response.techExperience ?? null,
          domainExperience: response.domainExperience ?? null,
          differentiators: response.differentiators ?? null,
          attachedCaseStudyIds: response.attachedCaseStudyIds ?? [],
          firstSubmittedAt: response.firstSubmittedAt ? response.firstSubmittedAt.toISOString() : null,
          lastUpdatedAt: response.lastUpdatedAt.toISOString(),
        }
      : null,
  })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string() }),
  ]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Portal RFP detail (P10 / US5.3)',
  description: 'Returns the full RFP brief + own-Agency response (if any). Stamps first_opened_at on first call. 404 envelope is byte-identical regardless of failure cause (invariant #15).',
  tags: ['PRM Portal'],
  responses: [
    { status: 200, description: 'OK' },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Missing portal.partner.access', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404 — uniform body)', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal RFP detail',
  methods: { GET: getDoc },
}
