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
  RfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../../../lib/rfpVisibility'

/**
 * POST /api/prm/portal/rfp/{id}/response/submit (Spec #5 §3.2 / US5.4 step 5).
 *
 * Idempotent submit transition. Author-scope is enforced HERE (route-layer)
 * because it depends on the caller's role-slug:
 *   - PartnerAdmin: any draft.
 *   - PartnerMember: only own draft (`submitted_by_member_id = self`).
 *
 * Visibility gate runs first — silent 404 (invariant #15).
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  POST: { requireAuth: false },
}

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

  const params = await Promise.resolve(ctx.params)
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) return rfpNotFoundResponse()

  const em = container.resolve('em') as EntityManager
  try {
    await assertBroadcastedOrNotFound(params.id, member.agencyId, em, {
      organizationId: auth.orgId,
    })
  } catch (err) {
    if (err instanceof RfpVisibilityNotFoundError) return rfpNotFoundResponse()
    throw err
  }

  // Author-scope check — fetch the response BEFORE delegating, so we can return
  // 403 (authorization) rather than 404 (visibility) when M2 attempts to submit
  // M1's draft. The service then runs the structural guards.
  const response = await em.findOne(
    RfpResponse,
    { rfpId: params.id, agencyId: member.agencyId, organizationId: auth.orgId } as any,
  )
  if (response && member.roleSlug === 'partner_member' && response.submittedByMemberId !== member.id) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only the Partner Member who started this draft (or a Partner Admin) can submit it.',
        },
      },
      { status: 403 },
    )
  }

  const rfpService = container.resolve('rfpService') as RfpService
  try {
    const { response: updated, isInitialSubmission } = await rfpService.submitResponse(
      params.id,
      member.agencyId,
      { organizationId: auth.orgId },
    )
    return NextResponse.json({
      ok: true,
      id: updated.id,
      status: updated.status,
      firstSubmittedAt: updated.firstSubmittedAt?.toISOString() ?? null,
      lastUpdatedAt: updated.lastUpdatedAt.toISOString(),
      isInitialSubmission,
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
  summary: 'Submit RFP response',
  description: 'Transitions RfpResponse from draft → submitted. Idempotent.',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'Submitted',
      schema: z.object({
        ok: z.literal(true),
        id: z.string().uuid(),
        status: z.literal('submitted'),
        firstSubmittedAt: z.string().nullable(),
        lastUpdatedAt: z.string(),
        isInitialSubmission: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Required fields missing or deadline passed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Author-scope violation (PartnerMember not author)', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404)', schema: errorSchema },
    { status: 409, description: 'RFP not in published status', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Submit RFP response',
  methods: { POST: postDoc },
}
