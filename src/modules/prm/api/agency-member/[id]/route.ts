import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { ROLE_SLUGS, updateAgencyMemberBackendSchema } from '../../../data/validators'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import { PRM_ERROR_CODES, PrmDomainError, toPrmErrorBody } from '../../../lib/errors'
import { summariseAgencyMember } from '../route'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency_member.read_all'] },
  PATCH: { requireAuth: true, requireFeatures: ['prm.agency_member.write_all'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid member id' }, { status: 400 })
  }
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findById(params.id, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: false, error: { code: 'agency_member_not_found', message: 'Member not found' } }, { status: 404 })
  }
  return NextResponse.json({ ok: true, agencyMember: summariseAgencyMember(member) })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid member id' }, { status: 400 })
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
  const parsed = updateAgencyMemberBackendSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findById(params.id, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: false, error: { code: 'agency_member_not_found', message: 'Member not found' } }, { status: 404 })
  }

  const willChangeRole =
    typeof parsed.data.roleSlug === 'string' && parsed.data.roleSlug !== member.roleSlug

  try {
    const updated = await memberService.update(member, parsed.data, {
      allowRoleChange: true,
      changedByUserId: typeof auth.sub === 'string' ? auth.sub : null,
    })

    // If a role change happened AND the member already has a CustomerUser, sync the
    // CustomerUserRole row (US1.6 lockout recovery: promote partner_member → partner_admin).
    if (willChangeRole && updated.customerUserId) {
      await syncCustomerRoleAssignment(container, {
        tenantId: auth.tenantId,
        organizationId: member.tenantId, // org will be re-resolved below
        customerUserId: updated.customerUserId,
        roleSlug: updated.roleSlug,
      })
    }

    return NextResponse.json({ ok: true, agencyMember: summariseAgencyMember(updated) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

async function syncCustomerRoleAssignment(
  container: any,
  args: { tenantId: string; organizationId: string; customerUserId: string; roleSlug: string },
): Promise<void> {
  const em = container.resolve('em') as EntityManager
  const user = await em.findOne(CustomerUser, { id: args.customerUserId, deletedAt: null })
  if (!user) return
  const role = await em.findOne(CustomerRole, {
    tenantId: user.tenantId,
    slug: args.roleSlug,
    deletedAt: null,
  })
  if (!role) return
  // Drop other partner_* role assignments first (idempotent — reversible by re-running).
  const partnerSlugSet = new Set<string>(ROLE_SLUGS)
  const allPartnerRoles = await em.find(CustomerRole, {
    tenantId: user.tenantId,
    deletedAt: null,
  })
  const partnerRoleIds = allPartnerRoles.filter((r) => partnerSlugSet.has(r.slug as any)).map((r) => r.id)
  if (partnerRoleIds.length > 0) {
    const existingAssignments = await em.find(CustomerUserRole, {
      user: user.id as any,
      role: { $in: partnerRoleIds } as any,
      deletedAt: null,
    } as any)
    for (const assignment of existingAssignments) {
      assignment.deletedAt = new Date()
      em.persist(assignment)
    }
  }
  const created = em.create(CustomerUserRole, {
    user,
    role,
    createdAt: new Date(),
  } as any)
  em.persist(created)
  await em.flush()
}

const okSchema = z.object({ ok: z.literal(true) })
const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read agency member (B2/B3)',
  tags: ['PRM Agency Members'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [{ status: 404, description: 'Not found', schema: errorSchema }],
}

const patchDoc: OpenApiMethodDoc = {
  summary: 'Update agency member (US1.6 lockout recovery)',
  tags: ['PRM Agency Members'],
  requestBody: { schema: updateAgencyMemberBackendSchema, description: 'Member partial update' },
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Conflict', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Agency member detail + update',
  methods: { GET: getDoc, PATCH: patchDoc },
}
