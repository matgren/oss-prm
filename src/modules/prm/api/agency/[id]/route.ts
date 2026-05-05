import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { updateAgencyBackendSchema } from '../../../data/validators'
import type { AgencyService } from '../../../lib/agencyService'
import { PrmDomainError, toPrmErrorBody, PRM_ERROR_CODES } from '../../../lib/errors'
import { summariseAgency } from '../route'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency.read'] },
  PATCH: { requireAuth: true, requireFeatures: ['prm.agency.update_all'] },
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
  return NextResponse.json({ ok: true, agency: summariseAgency(agency) })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
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
  const parsed = updateAgencyBackendSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  if ('slug' in (body as Record<string, unknown>)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'slug_is_immutable', message: 'Agency slug cannot be changed after creation.' },
      },
      { status: 400 },
    )
  }
  const container = await createRequestContainer()
  const agencyService = container.resolve('agencyService') as AgencyService
  try {
    const agency = await agencyService.updateAgency(params.id, parsed.data as Record<string, unknown>, {
      tenantId: auth.tenantId,
      userId: typeof auth.sub === 'string' ? auth.sub : null,
    })
    return NextResponse.json({ ok: true, agency: summariseAgency(agency) })
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
  summary: 'Read agency (B2)',
  tags: ['PRM Agencies'],
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
  ],
}

const patchDoc: OpenApiMethodDoc = {
  summary: 'Update agency (US1.1, US1.3, US1.7)',
  tags: ['PRM Agencies'],
  requestBody: { schema: updateAgencyBackendSchema, description: 'Partial agency update' },
  responses: [{ status: 200, description: 'OK', schema: okSchema }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Agency detail + update',
  description: 'Backend per-agency read + update.',
  methods: { GET: getDoc, PATCH: patchDoc },
}
