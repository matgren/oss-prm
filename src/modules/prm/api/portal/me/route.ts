import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireCustomerAuth } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import type { AgencyService } from '../../../lib/agencyService'
import { summariseAgencyMember } from '../../agency-member/route'

/**
 * Convenience endpoint for the portal shell — resolves the current `CustomerUser` to
 * its (active) `AgencyMember` and `Agency`, so portal pages can navigate to
 * `/portal/agency/{id}` and `/portal/members/{id}` without a separate lookup.
 */
export const metadata = {}

export async function GET(req: Request) {
  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }
  const container = await createRequestContainer()
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: true, member: null, agency: null })
  }
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(member.agencyId, { tenantId: auth.tenantId })
  return NextResponse.json({
    ok: true,
    member: summariseAgencyMember(member),
    agency: agency
      ? {
          id: agency.id,
          name: agency.name,
          slug: agency.slug,
          status: agency.status,
        }
      : null,
  })
}

const okSchema = z.object({
  ok: z.literal(true),
  member: z.record(z.string(), z.any()).nullable(),
  agency: z.record(z.string(), z.any()).nullable(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Resolve current portal user → agency + member',
  tags: ['PRM Portal'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [{ status: 401, description: 'Unauthenticated', schema: z.object({ ok: z.literal(false), error: z.string() }) }],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal me',
  methods: { GET: getDoc },
}
