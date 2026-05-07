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
import { RfpResponse } from '../../../../../../data/entities'
import { isPrmDomainError } from '../../../../../../lib/errors'
import type { AgencyMemberService } from '../../../../../../lib/agencyMemberService'
import type { RfpService } from '../../../../../../lib/rfpService'
import {
  assertBroadcastedOrNotFound,
  isRfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../../../lib/rfpVisibility'

/**
 * POST /api/prm/portal/rfp/{id}/response/unsubmit (Spec #5 §3.2 / US5.4 step 5).
 *
 * Returns a previously-submitted response back to `draft`. Allowed only while
 * RFP is `published` AND deadline has not passed. PartnerMember author-scope
 * mirrors submit: M2 cannot unsubmit M1's response.
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  POST: { requireAuth: false },
}

const unsubmitBodySchema = z.object({
  reason: z.string().max(2_000).optional(),
})

export async function POST(
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

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const parsed = unsubmitBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const params = await Promise.resolve(ctx.params)
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) return rfpNotFoundResponse()

  const em = container.resolve('em') as EntityManager
  let scopedRfp
  try {
    const result = await assertBroadcastedOrNotFound(params.id, member.agencyId, em)
    scopedRfp = result.rfp
  } catch (err) {
    if (isRfpVisibilityNotFoundError(err)) return rfpNotFoundResponse()
    throw err
  }

  // Author-scope check; the broadcast above already authorized the caller.
  const response = await em.findOne(
    RfpResponse,
    { rfpId: params.id, agencyId: member.agencyId } as any,
  )
  if (response && member.roleSlug === 'partner_member' && response.submittedByMemberId !== member.id) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only the Partner Member who started this draft (or a Partner Admin) can withdraw it.',
        },
      },
      { status: 403 },
    )
  }

  const rfpService = container.resolve('rfpService') as RfpService
  try {
    // Service writes scope by the RFP's staff `organizationId`, NOT `auth.orgId`
    // (which is the agency's org). See POST-MVP-FOLLOW-UPS line 23.
    const { response: updated, reverted } = await rfpService.unsubmitResponse(
      params.id,
      member.agencyId,
      { reason: parsed.data.reason },
      { organizationId: scopedRfp.organizationId },
    )
    return NextResponse.json({
      ok: true,
      id: updated.id,
      status: updated.status,
      lastUpdatedAt: updated.lastUpdatedAt.toISOString(),
      reverted,
    })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        },
        { status: err.status },
      )
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

const postDoc: OpenApiMethodDoc = {
  summary: 'Withdraw a submitted RFP response',
  description: 'Reverts submitted → draft. Allowed only while RFP is published and before deadline.',
  tags: ['PRM Portal'],
  requestBody: {
    contentType: 'application/json',
    schema: unsubmitBodySchema,
  },
  responses: [
    {
      status: 200,
      description: 'Withdrawn',
      schema: z.object({
        ok: z.literal(true),
        id: z.string().uuid(),
        status: z.literal('draft'),
        lastUpdatedAt: z.string(),
        reverted: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Author-scope violation', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404)', schema: errorSchema },
    { status: 409, description: 'Deadline passed or RFP not published', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Withdraw RFP response',
  methods: { POST: postDoc },
}
