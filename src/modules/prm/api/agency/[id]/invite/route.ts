import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { inviteAgencyMemberSchema } from '../../../../data/validators'
import type { AgencyService } from '../../../../lib/agencyService'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import type { ReinviteCooldownService } from '../../../../lib/reinviteCooldownService'
import { PRM_ERROR_CODES, PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { sendPartnerInviteEmail } from '../../../../emails/sendPartnerInviteEmail'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.agency.invite_admin'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
  }
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = inviteAgencyMemberSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(params.id, { tenantId: auth.tenantId })
  if (!agency) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } },
      { status: 404 },
    )
  }
  if (agency.status !== 'active') {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: PRM_ERROR_CODES.AGENCY_HISTORICAL,
          message: 'Cannot invite members for a historical agency. Reactivate first.',
        },
      },
      { status: 409 },
    )
  }

  // Re-invite cooldown: per (agency_id, lower(email)).
  const cooldown = container.resolve('reinviteCooldownService') as ReinviteCooldownService
  let rateLimiter: RateLimiterService | null = null
  try {
    rateLimiter = container.resolve('rateLimiterService') as RateLimiterService
  } catch {
    rateLimiter = null
  }
  const cooldownResult = await cooldown.consume(rateLimiter, agency.id, parsed.data.email)
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

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const em = container.resolve('em') as EntityManager
  try {
    const result = await em.transactional(async () =>
      memberService.invite({
        agency,
        input: parsed.data,
        invitedByUserId: typeof auth.sub === 'string' ? auth.sub : null,
        invitedByCustomerUserId: null,
      }),
    )
    // Best-effort email send — failure is logged but does not roll the tx back
    // (the invite token is durable, the email is the ephemeral side effect).
    await sendPartnerInviteEmail({
      to: result.member.email,
      firstName: result.member.firstName,
      lastName: result.member.lastName,
      rawToken: result.rawToken,
      tenantId: agency.tenantId,
      organizationId: agency.organizationId,
      agencyName: agency.name,
      roleSlug: result.member.roleSlug,
    }).catch(() => undefined)

    return NextResponse.json(
      {
        ok: true,
        agencyMemberId: result.member.id,
        invitationId: result.invitation.id,
        expiresAt: result.invitation.expiresAt.toISOString(),
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof PrmDomainError) {
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
const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const postDoc: OpenApiMethodDoc = {
  summary: 'Invite agency member (US1.2, US1.5)',
  tags: ['PRM Agencies'],
  requestBody: { schema: inviteAgencyMemberSchema, description: 'Member invite payload' },
  responses: [{ status: 201, description: 'Created', schema: okSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Agency not found', schema: errorSchema },
    { status: 409, description: 'Conflict (gh-profile or historical agency)', schema: errorSchema },
    { status: 429, description: 'Cooldown active', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Invite agency member',
  description:
    'Creates a CustomerUserInvitation, the placeholder AgencyMember (with GH-profile lock), and enqueues the partner invite email. Re-invite cooldown enforced per (agency_id, lower(email)).',
  methods: { POST: postDoc },
}
