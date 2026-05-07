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
import { PrmDomainError } from '../../../../../lib/errors'
import type { AgencyMemberService } from '../../../../../lib/agencyMemberService'
import type { RfpService } from '../../../../../lib/rfpService'
import {
  assertBroadcastedOrNotFound,
  RfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../../lib/rfpVisibility'

/**
 * POST /api/prm/portal/rfp/{id}/undecline (Spec #5 §3.3 idempotency table).
 *
 * Reverses a decline. PartnerAdmin-only. Allowed only while RFP is still
 * `published` (cannot un-decline post-scoring transition).
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

  if (member.roleSlug !== 'partner_admin') {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Only Partner Admins can reverse a decline.',
        },
      },
      { status: 403 },
    )
  }

  const em = container.resolve('em') as EntityManager
  try {
    await assertBroadcastedOrNotFound(params.id, member.agencyId, em, {
      organizationId: auth.orgId,
    })
  } catch (err) {
    if (err instanceof RfpVisibilityNotFoundError) return rfpNotFoundResponse()
    throw err
  }

  const rfpService = container.resolve('rfpService') as RfpService
  try {
    const { broadcast, reverted } = await rfpService.undeclineBroadcast(
      params.id,
      member.agencyId,
      { organizationId: auth.orgId },
    )
    return NextResponse.json({
      ok: true,
      id: broadcast.id,
      declinedAt: broadcast.declinedAt?.toISOString() ?? null,
      declineReason: broadcast.declineReason ?? null,
      reverted,
    })
  } catch (err) {
    if (err instanceof PrmDomainError) {
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
  summary: 'Reverse a decline (PartnerAdmin only)',
  description: 'Clears declined_at + decline_reason. Idempotent.',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'Reverted',
      schema: z.object({
        ok: z.literal(true),
        id: z.string().uuid(),
        declinedAt: z.string().nullable(),
        declineReason: z.string().nullable(),
        reverted: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Not a Partner Admin', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404)', schema: errorSchema },
    { status: 409, description: 'RFP no longer published', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Reverse RFP decline',
  methods: { POST: postDoc },
}
