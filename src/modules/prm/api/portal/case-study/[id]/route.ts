import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { updateCaseStudySchema } from '../../../../data/validators'
import {
  type CaseStudyService,
  toCaseStudyDto,
} from '../../../../lib/caseStudyService'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import { PrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { assertNoAdminFields } from '../route'

/**
 * Portal P8 — Case Study detail (own-Agency).
 *
 *   GET /api/prm/portal/case-study/:id  → DTO
 *   PUT /api/prm/portal/case-study/:id  → updated DTO
 *
 * Marketing-only fields rejected with 422 (invariant #6).
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
  PUT: { requireAuth: false },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

async function resolveAgencyForCaller(req: Request) {
  const auth = await requireCustomerAuth(req)
  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  await requireCustomerFeature(auth, ['portal.partner.access'], rbac)
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return { error: NextResponse.json({ ok: false, error: 'Agency membership not found' }, { status: 403 }) }
  }
  return { auth, container, member }
}

export async function GET(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  let resolved
  try {
    resolved = await resolveAgencyForCaller(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }
  if ('error' in resolved) return resolved.error
  const { auth, container, member } = resolved
  const service = container.resolve('caseStudyService') as CaseStudyService
  try {
    const cs = await service.getOwnedById(params.id, {
      organizationId: auth.orgId,
      agencyId: member.agencyId,
    })
    return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export async function PUT(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  let resolved
  try {
    resolved = await resolveAgencyForCaller(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }
  if ('error' in resolved) return resolved.error
  const { auth, container, member } = resolved

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const guard = await assertNoAdminFields(body, auth)
  if (guard) return guard

  const parsed = updateCaseStudySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const service = container.resolve('caseStudyService') as CaseStudyService
  try {
    const cs = await service.updateDraft(params.id, parsed.data, {
      organizationId: auth.orgId,
      agencyId: member.agencyId,
    })
    return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const caseStudySchema = z.object({ id: z.string().uuid(), title: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read own-Agency case study (P8)',
  tags: ['PRM Portal Case Studies'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), caseStudy: caseStudySchema }) },
    { status: 404, description: 'Not found' },
  ],
}

const putDoc: OpenApiMethodDoc = {
  summary: 'Update own-Agency case study (P8)',
  tags: ['PRM Portal Case Studies'],
  responses: [
    { status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), caseStudy: caseStudySchema }) },
    { status: 422, description: 'Marketing-only field rejected' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM portal — Case Study detail',
  methods: { GET: getDoc, PUT: putDoc },
}
