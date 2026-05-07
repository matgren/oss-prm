import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { portalMinQuerySchema } from '../../../data/validators'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import type { LicenseDealService } from '../../../lib/licenseDealService'

/**
 * Portal P2 MIN widget aggregate (Spec #3 §3.2 / US4.5).
 *
 * Read-only — returns yearly MIN attribution data for the caller's Agency. Tenant
 * isolation is enforced by deriving `agency_id` from the auth session (never
 * client-supplied). LicenseDeals where `attributed_agency_id = currentAgencyId AND
 * status IN ('signed','active')` count toward the year's MIN.
 *
 * `LicenseDealPublicDTO` exposes only fields the Agency may see per §1.4.4 — no
 * competing Prospects, other Agencies, or `attribution_reasoning`.
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
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
    await requireCustomerFeature(auth, ['prm.min.read_own_agency'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const url = new URL(req.url)
  const parsed = portalMinQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({
      ok: true,
      year: parsed.data.year ?? new Date().getUTCFullYear(),
      ownCount: 0,
      ownAnnualValueUsd: 0,
      ownDeals: [],
    })
  }

  const now = new Date()
  const year = parsed.data.year ?? now.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1))

  const licenseDealService = container.resolve('licenseDealService') as LicenseDealService
  const deals = await licenseDealService.listForMinWidget(
    { tenantId: auth.tenantId, agencyId: member.agencyId },
    { yearStart, yearEnd },
  )

  // Public-facing DTO — exclude attribution_reasoning + competing prospects.
  const ownDeals = deals.map((d) => ({
    licenseIdentifier: d.licenseIdentifier,
    clientIndustry: d.clientIndustry ?? null,
    closedAt: d.closedAt?.toISOString() ?? null,
    signedAt: d.signedAt?.toISOString() ?? null,
    annualValueUsd: d.annualValueUsd ? bucketAnnualValue(Number(d.annualValueUsd)) : null,
    status: d.status,
  }))
  const ownAnnualValueUsd = deals.reduce((sum, d) => sum + Number(d.annualValueUsd ?? 0), 0)

  return NextResponse.json({
    ok: true,
    year,
    ownCount: deals.length,
    ownAnnualValueUsd: Number(ownAnnualValueUsd.toFixed(2)),
    ownDeals,
  })
}

/** Bucket annual values into $50k bands so individual contract sizes aren't exposed. */
function bucketAnnualValue(value: number): { low: number; high: number } {
  const band = 50_000
  const low = Math.floor(value / band) * band
  return { low, high: low + band }
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const dealSchema = z.object({
  licenseIdentifier: z.string(),
  clientIndustry: z.string().nullable(),
  closedAt: z.string().nullable(),
  signedAt: z.string().nullable(),
  annualValueUsd: z.object({ low: z.number(), high: z.number() }).nullable(),
  status: z.string(),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'MIN widget aggregate (P2 / US4.5)',
  description: 'Yearly MIN aggregate for the caller’s Agency. Read-only. Tenant-isolated.',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        year: z.number().int(),
        ownCount: z.number().int(),
        ownAnnualValueUsd: z.number(),
        ownDeals: z.array(dealSchema),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'MIN widget feature missing', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal MIN widget aggregate',
  methods: { GET: getDoc },
}
