import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { AgencyService } from '../../../../lib/agencyService'
import type { AgencyMemberService } from '../../../../lib/agencyMemberService'
import { PRM_ERROR_CODES } from '../../../../lib/errors'
import { summariseAgencyMember, agencyMemberSchema } from '../../../agency-member/route'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency_member.read_all'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
  }
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
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
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const members = await memberService.findByAgency(agency.id, { tenantId: auth.tenantId })
  return NextResponse.json({ ok: true, items: members.map((m) => summariseAgencyMember(m)) })
}

const okListSchema = z.object({ ok: z.literal(true), items: z.array(agencyMemberSchema) })
const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'List agency members (B2 Members tab)',
  tags: ['PRM Agencies'],
  responses: [{ status: 200, description: 'OK', schema: okListSchema }],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 404, description: 'Agency not found', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Agency members list (per agency)',
  methods: { GET: getDoc },
}
