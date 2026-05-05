import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { hasFeature } from '@open-mercato/shared/security/features'
import {
  listProspectsPortalSchema,
  registerProspectSchema,
  PROSPECT_PORTAL_TRANSITIONS,
} from '../../../data/validators'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import type { ProspectService, ProspectActor } from '../../../lib/prospectService'
import { PRM_ERROR_CODES, PrmDomainError, toPrmErrorBody } from '../../../lib/errors'
import { Prospect } from '../../../data/entities'

/**
 * Portal prospect list + register endpoints (Spec #2 — wip-scoreboard).
 *
 *   GET  /api/prm/portal/prospects          → US3.3 own-agency list
 *   POST /api/prm/portal/prospects          → US3.1 register a Prospect
 */
export const metadata = {}

export function summariseProspect(p: Prospect, opts?: { canTransitionTo?: string[]; canEdit?: boolean }) {
  return {
    id: p.id,
    agencyId: p.agencyId,
    organizationId: p.organizationId,
    companyName: p.companyName,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    source: p.source,
    status: p.status,
    lostReason: p.lostReason ?? null,
    notes: p.notes ?? null,
    registeredAt: p.registeredAt.toISOString(),
    statusChangedAt: p.statusChangedAt.toISOString(),
    registeredByAgencyMemberId: p.registeredByAgencyMemberId,
    canEdit: opts?.canEdit ?? false,
    canTransitionTo: opts?.canTransitionTo ?? [],
  }
}

export async function GET(req: Request) {
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
    await requireCustomerFeature(auth, ['prm.prospect.read_own_agency'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const url = new URL(req.url)
  const parsed = listProspectsPortalSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    // No agency link → empty list (do not 404; the portal nav may show prospect link before linking).
    return NextResponse.json({
      ok: true,
      items: [],
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total: 0,
      totalPages: 1,
    })
  }

  const prospectService = container.resolve('prospectService') as ProspectService
  const { items, total } = await prospectService.listForAgency(parsed.data, {
    tenantId: auth.tenantId,
    agencyId: member.agencyId,
  })

  const features = auth.resolvedFeatures
  const isPartnerAdmin = hasFeature(features, 'prm.prospect.transition_any_in_agency')
  const actor: ProspectActor = {
    type: 'customer_user',
    customerUserId: auth.sub,
    agencyMemberId: member.id,
    isPartnerAdmin,
  }

  const summary = items.map((p) => {
    const allowed = prospectService.computeAllowedTransitions(p, actor)
    const canEdit =
      isPartnerAdmin ||
      (hasFeature(features, 'prm.prospect.transition_own_authored') &&
        p.registeredByAgencyMemberId === member.id)
    return summariseProspect(p, { canEdit, canTransitionTo: allowed })
  })

  return NextResponse.json({
    ok: true,
    items: summary,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
  })
}

export async function POST(req: Request) {
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
    await requireCustomerFeature(auth, ['prm.prospect.register'], rbac)
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
  const parsed = registerProspectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND,
          message: 'Your account is not linked to an agency yet.',
        },
      },
      { status: 403 },
    )
  }

  const prospectService = container.resolve('prospectService') as ProspectService
  try {
    const prospect = await prospectService.register(parsed.data, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      agencyId: member.agencyId,
      registeredByAgencyMemberId: member.id,
    })
    return NextResponse.json(
      {
        ok: true,
        prospect: summariseProspect(prospect, {
          canEdit: true,
          canTransitionTo: [...PROSPECT_PORTAL_TRANSITIONS.filter((s) => s !== 'dormant')],
        }),
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

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const prospectSchema = z.object({
  id: z.string().uuid(),
  agencyId: z.string().uuid(),
  organizationId: z.string().uuid(),
  companyName: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  source: z.string(),
  status: z.string(),
  lostReason: z.string().nullable(),
  notes: z.string().nullable(),
  registeredAt: z.string(),
  statusChangedAt: z.string(),
  registeredByAgencyMemberId: z.string().uuid(),
  canEdit: z.boolean(),
  canTransitionTo: z.array(z.string()),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List own-agency prospects (P5 / US3.3)',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(prospectSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Register a Prospect (P6 / US3.1)',
  tags: ['PRM Portal'],
  requestBody: { schema: registerProspectSchema, description: 'Prospect registration payload' },
  responses: [
    {
      status: 201,
      description: 'Created',
      schema: z.object({ ok: z.literal(true), prospect: prospectSchema }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Not linked to agency', schema: errorSchema },
    { status: 409, description: 'Agency historical', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal prospects list + register',
  description: 'Authenticated CustomerUser session — own-agency scoped.',
  methods: { GET: getDoc, POST: postDoc },
}
