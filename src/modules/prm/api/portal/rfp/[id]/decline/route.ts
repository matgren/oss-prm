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
import { declineRfpBroadcastSchema } from '../../../../../data/validators'
import { PrmDomainError } from '../../../../../lib/errors'
import type { AgencyMemberService } from '../../../../../lib/agencyMemberService'
import type { RfpService } from '../../../../../lib/rfpService'
import {
  assertBroadcastedOrNotFound,
  RfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../../lib/rfpVisibility'

/**
 * POST /api/prm/portal/rfp/{id}/decline (Spec #5 §3.2 / US5.5).
 *
 * PartnerAdmin-only — decline is an Agency-level decision (§6.2). PartnerMember
 * sessions are rejected with 403 BEFORE any state mutation.
 */
export const metadata = {}

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
  const parsed = declineRfpBroadcastSchema.safeParse(body)
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

  // PartnerAdmin-only (§6.2).
  if (member.roleSlug !== 'partner_admin') {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Only Partner Admins can decline an RFP.',
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
    const { broadcast, declined } = await rfpService.declineBroadcast(
      params.id,
      member.agencyId,
      { decline_reason: parsed.data.decline_reason ?? null },
      { organizationId: auth.orgId },
    )
    return NextResponse.json({
      ok: true,
      id: broadcast.id,
      declinedAt: broadcast.declinedAt?.toISOString() ?? null,
      declineReason: broadcast.declineReason ?? null,
      declined,
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
  summary: 'Decline RFP broadcast (PartnerAdmin only)',
  description: 'Sets declined_at + decline_reason on the agency-scoped broadcast. Idempotent.',
  tags: ['PRM Portal'],
  requestBody: {
    contentType: 'application/json',
    schema: declineRfpBroadcastSchema,
  },
  responses: [
    {
      status: 200,
      description: 'Declined',
      schema: z.object({
        ok: z.literal(true),
        id: z.string().uuid(),
        declinedAt: z.string().nullable(),
        declineReason: z.string().nullable(),
        declined: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Not a Partner Admin', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404)', schema: errorSchema },
    { status: 409, description: 'RFP no longer published', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Decline RFP',
  methods: { POST: postDoc },
}
