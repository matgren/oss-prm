import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { AgencyService } from '../../../../../lib/agencyService'
import type { CaseStudyService } from '../../../../../lib/caseStudyService'
import { PRM_ERROR_CODES } from '../../../../../lib/errors'
import { unionTagSlugs } from '../../../../../lib/tagSuggestions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth`; the framework catch-all defaults to staff auth so
// we explicitly defer to handler-level checks.
export const metadata = {
  GET: { requireAuth: false },
}

const querySchema = z.object({
  field: z.enum(['technologies', 'services']),
})

const CASE_STUDY_SCAN_CAP = 500

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: 'Invalid agency id' }, { status: 400 })
  }

  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
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
  const rbac = container.resolve('customerRbacService') as CustomerRbacService

  try {
    await requireCustomerFeature(auth, ['prm.agency.view'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(params.id, { tenantId: auth.tenantId })
  if (!agency) {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } },
      { status: 404 },
    )
  }
  // Tenant-scope guard — portal user must belong to the same Organization as the Agency.
  // The `prm_agencies_organization_uniq` DB constraint guarantees 1-org-1-agency, so
  // an `auth.orgId` match is sufficient proof of caller-agency membership.
  if (agency.organizationId !== auth.orgId) {
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
  summary: 'Per-agency tag suggestions (portal)',
  description:
    'Returns the union of the caller agency\'s own profile tags and case-study tags for the requested field. ' +
    'Used by the portal P3 own-agency form and the P8 case-study form. Per SPEC-2026-05-11.',
  tags: ['PRM Portal'],
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
    { status: 404, description: 'Not found / out of scope', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal per-agency tag suggestions',
  description:
    'Authenticated CustomerUser session — own-agency scoped. SPEC-2026-05-11 §5.1.1.',
  methods: { GET: getDoc },
}
