import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  CustomerUser,
  CustomerUserRole,
  CustomerRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Agency, AgencyMember } from '../../../data/entities'
import { ROLE_SLUGS } from '../../../data/validators'

/**
 * POST /api/prm/test-fixtures/agency-member-link — TEST-ONLY fixture seam.
 *
 * Bypasses the partner-invite/email/accept dance for Playwright integration
 * tests. Given a pre-created `CustomerUser` and a target Agency, this route
 * inserts an *active linked* `AgencyMember` row directly (no
 * `CustomerUserInvitation`, no `prm.agency_member.added` event side-effects
 * on the email path) so a portal-side test can authenticate as
 * `partner_admin` / `partner_member` immediately.
 *
 * Privacy / safety contract:
 *   - Auth: staff Bearer JWT with `prm.agency.invite_admin` (same as the
 *     production invite route). We deliberately reuse the production feature
 *     so the fixture cannot widen authorisation.
 *   - Gate: `OM_PRM_TEST_FIXTURES_ENABLED=1`. Without that env this returns
 *     `404 Not found`, byte-identical to a non-existent route — production
 *     deployments leak no signal. The integration runner sets this in the
 *     ephemeral env via the test config.
 *
 * Tracked in POST-MVP-FOLLOW-UPS.md (Customer-portal Playwright auth helper).
 */

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.agency.invite_admin'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const linkBodySchema = z.object({
  agencyId: z.string().regex(UUID_RE),
  customerUserId: z.string().regex(UUID_RE),
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  roleSlug: z.enum(ROLE_SLUGS),
  githubProfile: z.string().min(1).max(64).nullable().optional(),
})

function fixturesEnabled(): boolean {
  return process.env.OM_PRM_TEST_FIXTURES_ENABLED === '1'
}

function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  if (!fixturesEnabled()) return notFound()

  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = linkBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const agency = await findOneWithDecryption(
    em,
    Agency,
    { id: parsed.data.agencyId, tenantId: auth.tenantId, deletedAt: null } as any,
    undefined,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )
  if (!agency) {
    return NextResponse.json({ ok: false, error: 'Agency not found' }, { status: 404 })
  }

  const customerUser = await em.findOne(CustomerUser, {
    id: parsed.data.customerUserId,
    tenantId: auth.tenantId,
    deletedAt: null,
  } as any)
  if (!customerUser) {
    return NextResponse.json({ ok: false, error: 'CustomerUser not found' }, { status: 404 })
  }

  // Idempotency-friendly: if a member already exists for this CustomerUser in
  // this Agency, return it instead of double-inserting (mirrors the test
  // fixture pattern of "ensure exists").
  const existing = await em.findOne(AgencyMember, {
    customerUserId: parsed.data.customerUserId,
    agencyId: agency.id,
    deletedAt: null,
  } as any)
  if (existing) {
    return NextResponse.json({
      ok: true,
      agencyMemberId: existing.id,
      reused: true,
    })
  }

  // NB: in production, `CustomerInvitationService.acceptInvitation` creates
  // the new CustomerUser with `invitation.organizationId === agency.organizationId`,
  // so a real partner is always in the agency's organization after accept.
  // Several PRM portal routes lean on that invariant — see e.g. the
  // `agency.organizationId === auth.orgId` guard in
  // `PATCH /api/prm/portal/agency/[id]/member/[memberId]/route.ts` and the
  // `organizationId: scope.organizationId` lookup in `assertBroadcastedOrNotFound`.
  //
  // We deliberately do NOT migrate the CustomerUser's organizationId in this
  // seam right now: the existing portal/rfp visibility scope reads RFPs by
  // `auth.orgId` (which staff seeds against staff's org, not the agency's),
  // so flipping the customer's org here while leaving the RFP scope untouched
  // would regress the T5-003 P10 submit flow. The mismatched org-vs-route
  // contract is a real bug — see TC-PRM-T0-001 commit for details — and is
  // tracked as a deferred follow-up. Until the route-side fix lands, callers
  // in this seam stay in the staff org so the `T5-002`/`T5-003` portal-RFP
  // path remains green.

  // Resolve and assign the customer role on CustomerUser (so the customer JWT
  // carries `partner_admin`/`partner_member` features end-to-end).
  const role = await findOneWithDecryption(
    em,
    CustomerRole,
    {
      tenantId: auth.tenantId,
      slug: parsed.data.roleSlug,
      deletedAt: null,
    } as any,
    undefined,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
  )
  if (!role) {
    return NextResponse.json(
      {
        ok: false,
        error: `Role "${parsed.data.roleSlug}" is not seeded in this tenant. Run PRM tenant setup first.`,
      },
      { status: 500 },
    )
  }

  // Idempotent role assignment.
  const existingRoleLink = await em.findOne(CustomerUserRole, {
    user: customerUser.id as any,
    role: role.id as any,
    deletedAt: null,
  } as any)
  if (!existingRoleLink) {
    const userRole = em.create(CustomerUserRole, {
      user: customerUser,
      role,
      createdAt: new Date(),
    } as any)
    em.persist(userRole)
  }

  const lowerEmail = parsed.data.email.trim().toLowerCase()
  const member = em.create(AgencyMember, {
    tenantId: agency.tenantId,
    agencyId: agency.id,
    customerUserId: customerUser.id,
    invitationId: null,
    email: lowerEmail,
    emailLookup: lowerEmail,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    githubProfile: parsed.data.githubProfile ?? null,
    isActive: true,
    invitedAt: new Date(),
    activatedAt: new Date(),
    agencyStatus: agency.status,
    roleSlug: parsed.data.roleSlug,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any)
  em.persist(member)
  await em.flush()

  return NextResponse.json(
    {
      ok: true,
      agencyMemberId: member.id,
      reused: false,
    },
    { status: 201 },
  )
}

const successSchema = z.object({
  ok: z.literal(true),
  agencyMemberId: z.string().uuid(),
  reused: z.boolean(),
})
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  details: z.record(z.string(), z.any()).optional(),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Test-only — link an existing CustomerUser to an Agency as a partner_admin/partner_member',
  description:
    'TEST-ONLY route. Creates an active AgencyMember row linked to an existing CustomerUser, bypassing the invite/email/accept flow. Gated by OM_PRM_TEST_FIXTURES_ENABLED=1; returns 404 otherwise.',
  tags: ['PRM Test Fixtures'],
  requestBody: { schema: linkBodySchema, description: 'Link payload' },
  responses: [
    { status: 200, description: 'Idempotent — member already linked', schema: successSchema },
    { status: 201, description: 'Created', schema: successSchema },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Authentication required', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Disabled or agency/customer not found', schema: errorSchema },
    { status: 500, description: 'Customer role not seeded', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Test-only — link CustomerUser to Agency',
  description:
    'Bypasses the partner-invite/email/accept dance for Playwright integration tests. Disabled by default (OM_PRM_TEST_FIXTURES_ENABLED=1).',
  methods: { POST: postDoc },
}
