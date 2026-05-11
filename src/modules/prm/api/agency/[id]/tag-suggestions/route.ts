import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { AgencyService } from '../../../../lib/agencyService'
import type { CaseStudyService } from '../../../../lib/caseStudyService'
import { PRM_ERROR_CODES } from '../../../../lib/errors'
import { unionTagSlugs } from '../../../../lib/tagSuggestions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Staff-auth route — framework catch-all enforces auth + `prm.agency.read`.
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.agency.read'] },
}

const querySchema = z.object({
  field: z.enum(['technologies', 'services']),
})

const CASE_STUDY_SCAN_CAP = 500

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
  }

  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({ field: url.searchParams.get('field') })
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Invalid `field` parameter (expected "technologies" or "services").' },
      { status: 400 },
    )
  }
  const { field } = parsed.data

  const container = await createRequestContainer()
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(params.id, { tenantId: auth.tenantId })
  if (!agency) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } },
      { status: 404 },
    )
  }

  const caseStudyService = container.resolve('caseStudyService') as CaseStudyService
  const { items: caseStudies } = await caseStudyService.listForAgency(
    { organizationId: agency.organizationId, agencyId: agency.id },
    { includeDeleted: false, limit: CASE_STUDY_SCAN_CAP, offset: 0 },
  )

  const sources: Array<readonly string[] | null | undefined> =
    field === 'technologies'
      ? [agency.techCapabilities, ...caseStudies.map((cs) => cs.technologiesUsed)]
      : [agency.services, ...caseStudies.map((cs) => cs.servicesDelivered)]

  return NextResponse.json({ ok: true, items: unionTagSlugs(sources) })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Per-agency tag suggestions (backend)',
  description:
    'OM-staff variant of the per-agency tag-suggestion endpoint. Drives the B1 agency Profile tab. ' +
    'Same union/UUID-filter/dedup logic as the portal endpoint (shared via lib/tagSuggestions.ts). ' +
    'Per SPEC-2026-05-11.',
  tags: ['PRM Backend'],
  responses: [
    {
      status: 200,
      description: 'OK — alphabetised, case-insensitive deduped, UUID-filtered tag list',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(z.object({ value: z.string(), label: z.string() })),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid id or query', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 404, description: 'Agency not found', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Backend per-agency tag suggestions (B1 driver)',
  description: 'Staff auth — `prm.agency.read`. SPEC-2026-05-11 §5.1.1 / §6.1.',
  methods: { GET: getDoc },
}
