import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  type CaseStudyService,
  toCaseStudyDto,
} from '../../../../../lib/caseStudyService'
import type { AgencyMemberService } from '../../../../../lib/agencyMemberService'
import { isPrmDomainError, toPrmErrorBody } from '../../../../../lib/errors'

/**
 * Portal P7 — restore (undelete) a Case Study (compensation pair to soft-delete).
 *
 *   POST /api/prm/portal/case-study/:id/restore
 *
 * Returns 409 if the row is not in `deleted` state.
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  POST: { requireAuth: false },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function POST(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
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
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: false, error: 'Agency membership not found' }, { status: 403 })
  }
  const service = container.resolve('caseStudyService') as CaseStudyService
  try {
    const cs = await service.restore(
      params.id,
      { organizationId: auth.orgId, agencyId: member.agencyId },
      { customerUserId: auth.sub },
    )
    return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Restore own-Agency case study from soft-delete',
  tags: ['PRM Portal Case Studies'],
  responses: [
    { status: 200, description: 'Restored', schema: z.object({ ok: z.literal(true), caseStudy: z.any() }) },
    { status: 409, description: 'Not in deleted state' },
    { status: 404, description: 'Not found' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM portal — Case Study restore',
  methods: { POST: postDoc },
}
