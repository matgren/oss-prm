import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { updateAgencyMemberPortalSchema } from '../../../../../../data/validators'
import type { AgencyMemberService } from '../../../../../../lib/agencyMemberService'
import type { AgencyService } from '../../../../../../lib/agencyService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../../../../lib/errors'
import { summariseAgencyMember } from '../../../../../agency-member/route'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  PATCH: { requireAuth: false },
}

export async function PATCH(
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

  // Authorization is dual-mode: self-edit (own row) OR partner_admin managing partner_member.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = updateAgencyMemberPortalSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const agencyService = container.resolve('agencyService') as AgencyService
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findById(params.memberId, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: false, error: { code: 'agency_member_not_found', message: 'Member not found' } }, { status: 404 })
  }
  if (member.agencyId !== params.id) {
    return NextResponse.json({ ok: false, error: { code: 'agency_member_not_found', message: 'Member not found' } }, { status: 404 })
  }

  const agency = await agencyService.findById(member.agencyId, { tenantId: auth.tenantId })
  if (!agency || agency.organizationId !== auth.orgId) {
    return NextResponse.json({ ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } }, { status: 404 })
  }

  const isSelfEdit = member.customerUserId === auth.sub

  if (isSelfEdit) {
    try {
      await requireCustomerFeature(auth, ['prm.agency_member.self_edit'], rbac)
    } catch (resp) {
      if (resp instanceof Response) return resp
      throw resp
    }
    // Self-edit cannot change isActive.
    if (typeof parsed.data.isActive === 'boolean') {
      return NextResponse.json(
        { ok: false, error: { code: PRM_ERROR_CODES.FORBIDDEN, message: 'Members cannot toggle their own active state.' } },
        { status: 403 },
      )
    }
  } else {
    try {
      await requireCustomerFeature(auth, ['prm.agency_member.manage_partner_member'], rbac)
    } catch (resp) {
      if (resp instanceof Response) return resp
      throw resp
    }
    // Caller cannot manage partner_admin rows from portal.
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
    // PartnerAdmin cannot deactivate self.
    if (parsed.data.isActive === false && member.customerUserId === auth.sub) {
      return NextResponse.json(
        { ok: false, error: { code: PRM_ERROR_CODES.CANNOT_DEACTIVATE_SELF, message: 'You cannot deactivate yourself.' } },
        { status: 403 },
      )
    }
  }

  try {
    const updated = await memberService.update(member, parsed.data, {
      allowRoleChange: false,
      changedByUserId: null,
    })
    return NextResponse.json({ ok: true, agencyMember: summariseAgencyMember(updated) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const okSchema = z.object({ ok: z.literal(true) })
const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const patchDoc: OpenApiMethodDoc = {
  summary: 'Update own member row or a partner_member (P4)',
  tags: ['PRM Portal'],
  requestBody: { schema: updateAgencyMemberPortalSchema, description: 'Partial member update' },
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Conflict', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal member update',
  methods: { PATCH: patchDoc },
}
