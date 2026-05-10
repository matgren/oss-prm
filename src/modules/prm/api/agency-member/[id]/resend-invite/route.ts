import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import type { AgencyService } from '../../../../lib/agencyService'
import type { ReinviteCooldownService } from '../../../../lib/reinviteCooldownService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { sendPartnerInviteEmail } from '../../../../emails/sendPartnerInviteEmail'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.agency_member.write_all'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * OM-staff backend mirror of the portal resend-invite endpoint
 * (`/api/prm/portal/agency/{id}/member/{memberId}/resend-invite`). Same service
 * call, same `(agency_id, lower(email))` cooldown bucket, no `partner_member`-only
 * gate (staff can resend for `partner_admin` rows too — they originally invited them).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid member id' }, { status: 400 })
  }
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const agencyService = container.resolve('agencyService') as AgencyService

  const member = await memberService.findById(params.id, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND, message: 'Member not found' } },
      { status: 404 },
    )
  }

  const agency = await agencyService.findById(member.agencyId, { tenantId: auth.tenantId })
  if (!agency) {
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
        invitedByUserId: typeof auth.sub === 'string' ? auth.sub : null,
        invitedByCustomerUserId: null,
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
  summary: 'Resend agency member invitation (OM-staff backend)',
  tags: ['PRM Agency Members'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 400, description: 'Invalid id', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Conflict (activated / deactivated / historical)', schema: errorSchema },
    { status: 429, description: 'Cooldown active', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Backend agency member resend invitation',
  methods: { POST: postDoc },
}
