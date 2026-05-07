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
import { updateAgencyPortalSchema, ADMIN_ONLY_AGENCY_FIELDS } from '../../../../data/validators'
import type { AgencyService } from '../../../../lib/agencyService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseAgency } from '../../../agency/route'
import { safeEmit } from '../../../../lib/safeEmit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
  PATCH: { requireAuth: false },
}

const adminOnlyKeys = new Set<string>(ADMIN_ONLY_AGENCY_FIELDS)

function buildPortalAgencyView(
  agency: ReturnType<typeof summariseAgency>,
  features: string[],
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: agency.id,
    organizationId: agency.organizationId,
    name: agency.name,
    slug: agency.slug,
    description: agency.description,
    websiteUrl: agency.websiteUrl,
    logoUrl: agency.logoUrl,
    headquartersCountry: agency.headquartersCountry,
    headquartersCity: agency.headquartersCity,
    teamSizeBucket: agency.teamSizeBucket,
    industries: agency.industries,
    services: agency.services,
    techCapabilities: agency.techCapabilities,
    /** Optimistic-concurrency token — portal echoes back as `ifMatchVersion` on PATCH. */
    version: agency.version,
  }
  // Admin-only `_prm` block — gated on `prm.agency.read_admin_fields` (OQ-020).
  // Mirrors the response enricher; the enricher path runs when this route is
  // invoked through the CRUD factory in the future, this manual view is the
  // single source of truth in v1.
  if (hasFeature(features, 'prm.agency.read_admin_fields')) {
    view._prm = {
      tier: agency.tier,
      status: agency.status,
      contractSigned: agency.contractSigned,
      ndaSigned: agency.ndaSigned,
      onboarded: agency.onboarded,
    }
  }
  return view
}

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
    return NextResponse.json({ ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } }, { status: 404 })
  }
  // Tenant-scope guard — portal user must belong to the same Organization as the Agency.
  if (agency.organizationId !== auth.orgId) {
    return NextResponse.json({ ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } }, { status: 404 })
  }
  const summary = summariseAgency(agency)
  return NextResponse.json({ ok: true, agency: buildPortalAgencyView(summary, auth.resolvedFeatures) })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
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
  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, ['prm.agency.edit'], rbac)
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
  // Defence-in-depth: this is the second leg of invariant #6 enforcement at the route layer.
  // The interceptor (`api/interceptors.ts`) catches admin-only fields earlier; here we still
  // emit the diagnostic event and reject with the structured error envelope.
  const offending: string[] = []
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of Object.keys(body as Record<string, unknown>)) {
      if (adminOnlyKeys.has(key)) offending.push(key)
    }
  }
  if (offending.length > 0) {
    for (const field of offending) {
      await safeEmit(
        'prm.agency.admin_field_access_rejected',
        {
          agencyId: params.id,
          fieldName: field,
          customerUserId: auth.sub,
          attemptedAt: new Date().toISOString(),
        },
        { container, context: { agencyId: params.id, fieldName: field, customerUserId: auth.sub } },
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: PRM_ERROR_CODES.ADMIN_ONLY_FIELD,
          message: 'Admin-only field cannot be edited from the portal.',
          details: { fields: offending },
        },
      },
      { status: 403 },
    )
  }

  const parsed = updateAgencyPortalSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(params.id, { tenantId: auth.tenantId })
  if (!agency || agency.organizationId !== auth.orgId) {
    return NextResponse.json({ ok: false, error: { code: PRM_ERROR_CODES.AGENCY_NOT_FOUND, message: 'Agency not found' } }, { status: 404 })
  }
  if (agency.status !== 'active') {
    return NextResponse.json(
      { ok: false, error: { code: PRM_ERROR_CODES.AGENCY_HISTORICAL, message: 'This agency is historical — edits are disabled.' } },
      { status: 409 },
    )
  }

  try {
    const updated = await agencyService.updateAgency(agency.id, parsed.data as Record<string, unknown>, {
      tenantId: auth.tenantId,
      userId: null,
      reason: 'portal_edit',
    })
    const summary = summariseAgency(updated)
    return NextResponse.json({ ok: true, agency: buildPortalAgencyView(summary, auth.resolvedFeatures) })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]) })

const getDoc: OpenApiMethodDoc = {
  summary: 'Read own agency profile (P3)',
  tags: ['PRM Portal'],
  responses: [{ status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), agency: z.record(z.string(), z.any()) }) }],
  errors: [
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 404, description: 'Not found / out of scope', schema: errorSchema },
  ],
}

const patchDoc: OpenApiMethodDoc = {
  summary: 'Edit own agency profile (US2.1)',
  tags: ['PRM Portal'],
  requestBody: { schema: updateAgencyPortalSchema, description: 'Editable agency fields' },
  responses: [{ status: 200, description: 'OK', schema: z.object({ ok: z.literal(true), agency: z.record(z.string(), z.any()) }) }],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 403, description: 'Admin-only field rejected', schema: errorSchema },
    { status: 404, description: 'Not found', schema: errorSchema },
    { status: 409, description: 'Agency historical', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal agency profile',
  description: 'Authenticated CustomerUser session — own-agency scoped.',
  methods: { GET: getDoc, PATCH: patchDoc },
}
