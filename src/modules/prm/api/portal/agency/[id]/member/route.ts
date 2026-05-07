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
import { portalInviteAgencyMemberSchema } from '../../../../../data/validators'
import type { AgencyService } from '../../../../../lib/agencyService'
import type { AgencyMemberService } from '../../../../../lib/agencyMemberService'
import type { ReinviteCooldownService } from '../../../../../lib/reinviteCooldownService'
import { PRM_ERROR_CODES, PrmDomainError, toPrmErrorBody } from '../../../../../lib/errors'
import { sendPartnerInviteEmail } from '../../../../../emails/sendPartnerInviteEmail'
import { summariseAgencyMember } from '../../../../agency-member/route'
import { AgencyMember } from '../../../../../data/entities'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

async function ensureAgencyForCaller(
  container: any,
  auth: { tenantId: string; orgId: string },
  agencyId: string,
) {
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(agencyId, { tenantId: auth.tenantId })
  if (!agency || agency.organizationId !== auth.orgId) return null
  return agency
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
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
    await requireCustomerFeature(auth, ['prm.agency_member.read'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }
  const agency = await ensureAgencyForCaller(container, auth, params.id)
  if (!agency) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } },
      { status: 404 },
    )
  }
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const members = await memberService.findByAgency(agency.id, { tenantId: auth.tenantId })
  return NextResponse.json({ ok: true, items: members.map((m) => summariseAgencyMember(m)) })
}

/**
 * US1.5 — PartnerAdmin invites a `partner_member`. Role is implicit; the schema
 * forbids `partner_admin` (would also be rejected by `customer_assignable: false`).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
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
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  // Defence-in-depth — reject any role_slug attempt other than partner_member.
  if (body && typeof body === 'object' && 'roleSlug' in (body as Record<string, unknown>)) {
    const requested = (body as Record<string, unknown>).roleSlug
    if (requested && requested !== 'partner_member') {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: PRM_ERROR_CODES.ROLE_NOT_SELF_ASSIGNABLE,
            message: 'Partner Admins cannot promote members from the portal — contact OM PartnerOps.',
          },
        },
        { status: 403 },
      )
    }
  }
  const parsed = portalInviteAgencyMemberSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const agency = await ensureAgencyForCaller(container, auth, params.id)
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
        input: { ...parsed.data, roleSlug: 'partner_member' },
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
        `[prm] partner invite email dispatch failed for agencyMemberId=${result.member.id}: ${message}`,
        { agencyId: agency.id, agencyMemberId: result.member.id, invitationId: result.invitation.id },
      )
    })
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

const okSchema = z.object({ ok: z.literal(true) })
const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'List own-agency members (P4)',
  tags: ['PRM Portal'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [{ status: 401, description: 'Unauthenticated', schema: errorSchema }],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Invite partner_member (US1.5)',
  tags: ['PRM Portal'],
  requestBody: { schema: portalInviteAgencyMemberSchema, description: 'Member invite payload' },
  responses: [{ status: 201, description: 'Created', schema: okSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden / role-not-self-assignable', schema: errorSchema },
    { status: 404, description: 'Agency not found', schema: errorSchema },
    { status: 409, description: 'Conflict (gh-profile or historical)', schema: errorSchema },
    { status: 429, description: 'Cooldown active', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal members list & invite',
  methods: { GET: getDoc, POST: postDoc },
}

// Suppress unused-import warning when consumers don't read AgencyMember directly.
const _AGENCY_MEMBER = AgencyMember
void _AGENCY_MEMBER
