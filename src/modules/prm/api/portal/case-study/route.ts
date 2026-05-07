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
  createCaseStudySchema,
  listCaseStudyPortalSchema,
  ADMIN_ONLY_CASE_STUDY_FIELDS,
} from '../../../data/validators'
import {
  type CaseStudyService,
  type CaseStudyDto,
  toCaseStudyDto,
} from '../../../lib/caseStudyService'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import { PRM_ERROR_CODES, isPrmDomainError, toPrmErrorBody } from '../../../lib/errors'
import { safeEmit } from '../../../lib/safeEmit'

/**
 * Portal P7 / P8 — own-Agency Case Study list + create.
 *
 *   GET  /api/prm/portal/case-study  — own-Agency list (excludes soft-deleted by default).
 *   POST /api/prm/portal/case-study  — create draft (PartnerAdmin / PartnerMember).
 *
 * Marketing-only fields (`mayPublishOnOmWebsite`, `publishedUrl`) are
 * stripped + rejected with `422 case_study_forbidden_field` per invariant
 * #6. Diagnostic event `prm.agency.admin_field_access_rejected` emitted
 * for OM-staff visibility (same pattern as Spec #1's Agency portal guard).
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
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
    await requireCustomerFeature(auth, ['portal.partner.access'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({
      ok: true,
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    })
  }

  const url = new URL(req.url)
  const parsed = listCaseStudyPortalSchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, q, includeDeleted } = parsed.data
  const service = container.resolve('caseStudyService') as CaseStudyService
  const { items, total } = await service.listForAgency(
    { organizationId: auth.orgId, agencyId: member.agencyId },
    {
      includeDeleted,
      q,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  )
  return NextResponse.json({
    ok: true,
    items: items.map(toCaseStudyDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
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

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const guard = await assertNoAdminFields(body, auth)
  if (guard) return guard

  const parsed = createCaseStudySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const service = container.resolve('caseStudyService') as CaseStudyService
  try {
    const cs = await service.createDraft(parsed.data, {
      organizationId: auth.orgId,
      agencyId: member.agencyId,
    })
    return NextResponse.json({ ok: true, caseStudy: toCaseStudyDto(cs) }, { status: 201 })
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

/**
 * Strips and rejects Marketing-only fields per invariant #6. Mirrors the
 * Agency portal interceptor pattern shipped in Spec #1.
 */
export async function assertNoAdminFields(
  body: unknown,
  auth: { orgId: string; tenantId: string; sub: string },
): Promise<NextResponse | null> {
  if (!body || typeof body !== 'object') return null
  const keys = Object.keys(body as Record<string, unknown>)
  const violations = keys.filter((k) => (ADMIN_ONLY_CASE_STUDY_FIELDS as readonly string[]).includes(k))
  if (violations.length === 0) return null
  await safeEmit('prm.agency.admin_field_access_rejected', {
    organization_id: auth.orgId,
    customer_user_id: auth.sub,
    field_keys: violations,
    surface: 'portal.case_study',
  })
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: PRM_ERROR_CODES.CASE_STUDY_FORBIDDEN_FIELD,
        message: 'Marketing-only fields cannot be set from the partner portal.',
        details: { fields: violations },
      },
    },
    { status: 422 },
  )
}

const caseStudyResponseSchema = z.object({
  id: z.string().uuid(),
  agencyId: z.string().uuid(),
  title: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'List own-Agency case studies (P7)',
  description: 'Tenant-scoped, agency-scoped Case Study list. Excludes soft-deleted by default.',
  tags: ['PRM Portal Case Studies'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(caseStudyResponseSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Create case study draft (US2.2)',
  description: 'Creates a Case Study under the calling Agency. Marketing-only fields rejected with 422.',
  tags: ['PRM Portal Case Studies'],
  responses: [
    {
      status: 201,
      description: 'Created',
      schema: z.object({
        ok: z.literal(true),
        caseStudy: caseStudyResponseSchema,
      }),
    },
    {
      status: 422,
      description: 'Marketing-only field write rejected (invariant #6)',
      schema: z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
    },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM portal — own-Agency Case Studies (P7/P8)',
  description: 'Tenant-scoped + agency-scoped CRUD over Case Studies.',
  methods: { GET: getDoc, POST: postDoc },
}

export type CaseStudyApiDto = CaseStudyDto
