import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { AgencyService } from '../../../../../../../lib/agencyService'
import type { AgencyMemberService } from '../../../../../../../lib/agencyMemberService'
import type { ReinviteCooldownService } from '../../../../../../../lib/reinviteCooldownService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../../../../../lib/errors'
import { sendPartnerInviteEmail } from '../../../../../../../emails/sendPartnerInviteEmail'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). Setting `requireAuth: false` defers
// auth to the handler so the customer JWT path can run.
export const metadata = {
  POST: { requireAuth: false },
}

/**
 * US1.5+ — PartnerAdmin re-issues an invitation for a partner_member that has not
 * yet activated. Mirrors `auth/api/users/resend-invite/route.ts` (the canonical OM
 * staff-user resend pattern). Cooldown reuses the same `(agency_id, lower(email))`
 * key as the create-invite path so `TC-PRM-T0-006-reinvite-cooldown` invariants
 * cover both flows.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string; memberId: string } },
) {
  if (!UUID_RE.test(params.id) || !UUID_RE.test(params.memberId)) {
    return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
  }
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
    await requireCustomerFeature(auth, ['prm.agency_member.manage_partner_member'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const agencyService = container.resolve('agencyService') as AgencyService
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findById(params.memberId, { tenantId: auth.tenantId })
  if (!member || member.agencyId !== params.id) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND, message: 'Member not found' } },
      { status: 404 },
    )
  }

  const agency = await agencyService.findById(member.agencyId, { tenantId: auth.tenantId })
  if (!agency || agency.organizationId !== auth.orgId) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } },
      { status: 404 },
    )
  }
  if (agency.status !== 'active') {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_HISTORICAL, message: 'Agency is historical' } },
      { status: 409 },
    )
  }

  // Portal can only manage partner_member rows — same gate as PATCH route.
  if (member.roleSlug !== 'partner_member') {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: PRM_ERROR_CODES.ROLE_NOT_SELF_ASSIGNABLE,
          message: 'Only partner_member rows can be managed from the portal.',
        },
      },
      { status: 403 },
    )
  }

  const cooldown = container.resolve('reinviteCooldownService') as ReinviteCooldownService
  let rateLimiter: RateLimiterService | null = null
  try {
    rateLimiter = container.resolve('rateLimiterService') as RateLimiterService
  } catch {
    rateLimiter = null
  }
  const cooldownResult = await cooldown.consume(rateLimiter, agency.id, member.email)
  if (!cooldownResult.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: PRM_ERROR_CODES.INVITE_COOLDOWN_ACTIVE,
          message: 'A recent invite for this email is still pending — please wait before re-inviting.',
          details: { retryAfterSeconds: cooldownResult.retryAfterSeconds },
        },
      },
      {
        status: 429,
        headers: { 'Retry-After': String(cooldownResult.retryAfterSeconds) },
      },
    )
  }

  const em = container.resolve('em') as EntityManager
  try {
    const result = await em.transactional(async () =>
      memberService.resendInvite({
        member,
        agency,
        invitedByUserId: null,
        invitedByCustomerUserId: auth.sub,
      }),
    )
    await sendPartnerInviteEmail({
      to: result.member.email,
      firstName: result.member.firstName,
      lastName: result.member.lastName,
      rawToken: result.rawToken,
      tenantId: agency.tenantId,
      organizationId: agency.organizationId,
      agencyName: agency.name,
      roleSlug: result.member.roleSlug,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn(
        `[prm] partner invite resend email dispatch failed for agencyMemberId=${result.member.id}: ${message}`,
        { agencyId: agency.id, agencyMemberId: result.member.id, invitationId: result.invitation.id },
      )
    })
    return NextResponse.json({
      ok: true,
      agencyMemberId: result.member.id,
      invitationId: result.invitation.id,
      expiresAt: result.invitation.expiresAt.toISOString(),
    })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const okSchema = z.object({
  ok: z.literal(true),
  agencyMemberId: z.string().uuid(),
  invitationId: z.string().uuid(),
  expiresAt: z.string(),
})
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Resend partner_member invitation (P4)',
  tags: ['PRM Portal'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 400, description: 'Invalid id', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden / role-not-self-assignable', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Conflict (activated / deactivated / historical)', schema: errorSchema },
    { status: 429, description: 'Cooldown active', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal members resend invitation',
  methods: { POST: postDoc },
}
