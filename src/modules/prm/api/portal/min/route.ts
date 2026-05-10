import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Agency } from '../../../data/entities'
import { portalMinQuerySchema } from '../../../data/validators'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import type { LicenseDealService } from '../../../lib/licenseDealService'
import { getPartnershipYearWindow } from '../../../lib/partnershipYear'

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
      calendarYear: parsed.data.year ?? new Date().getUTCFullYear(),
      partnershipYear: null,
      period: { partnershipYear: null, warnings: ['partnership_start_date_missing'] as const },
      ownCount: 0,
      ownAnnualValueUsd: 0,
      ownDeals: [],
    })
  }

  const em = container.resolve('em') as EntityManager
  const agency = await em.findOne(Agency, { id: member.agencyId, tenantId: auth.tenantId })
  const now = new Date()
  const currentCalendarYear = now.getUTCFullYear()

  // Window resolution per SPEC-2026-05-10:
  //  - ?partnershipYear=N → use partnership-year window (400 if anchor missing).
  //  - ?year=N → if anchor set: deprecated, reinterpret as the partnership year containing Jan 1 of N.
  //              if anchor missing: keep calendar-year semantics.
  //  - neither: current partnership year (if anchor set) or current calendar year.
  let yearStart: Date
  let yearEnd: Date
  let priorStart: Date | null = null
  let priorEnd: Date | null = null
  let partnershipYearNumber: number | null = null
  let calendarYear: number = currentCalendarYear
  const warnings: string[] = []

  if (parsed.data.partnershipYear != null) {
    if (!agency?.partnershipStartDate) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'anchor_missing',
            message:
              'Agency partnership_start_date is not set; use ?year=<calendar-year> as a fallback or ask OM staff to set the anchor.',
          },
        },
        { status: 400 },
      )
    }
    // Walk from anchor to the requested partnership year.
    const anchor = agency.partnershipStartDate
    const probeAsOf = new Date(anchor)
    probeAsOf.setUTCFullYear(anchor.getUTCFullYear() + parsed.data.partnershipYear - 1)
    const window = getPartnershipYearWindow(agency, probeAsOf)!
    yearStart = window.start
    yearEnd = window.end
    partnershipYearNumber = window.yearNumber
    calendarYear = window.start.getUTCFullYear()
    if (partnershipYearNumber > 1) {
      const priorProbe = new Date(anchor)
      priorProbe.setUTCFullYear(anchor.getUTCFullYear() + partnershipYearNumber - 2)
      const prior = getPartnershipYearWindow(agency, priorProbe)!
      priorStart = prior.start
      priorEnd = prior.end
    }
  } else if (parsed.data.year != null) {
    if (agency?.partnershipStartDate) {
      // Re-interpret ?year=N as the partnership year containing calendar Jan 1.
      warnings.push('year_param_deprecated')
      const asOf = new Date(Date.UTC(parsed.data.year, 0, 1))
      const window = getPartnershipYearWindow(agency, asOf)!
      yearStart = window.start
      yearEnd = window.end
      partnershipYearNumber = window.yearNumber
      calendarYear = parsed.data.year
      if (partnershipYearNumber > 1) {
        const priorProbe = new Date(window.start)
        priorProbe.setUTCFullYear(priorProbe.getUTCFullYear() - 1)
        const prior = getPartnershipYearWindow(agency, priorProbe)!
        priorStart = prior.start
        priorEnd = prior.end
      }
    } else {
      // No anchor → keep calendar-year semantics, no warning.
      yearStart = new Date(Date.UTC(parsed.data.year, 0, 1))
      yearEnd = new Date(Date.UTC(parsed.data.year + 1, 0, 1))
      calendarYear = parsed.data.year
      warnings.push('partnership_start_date_missing')
    }
  } else if (agency?.partnershipStartDate) {
    const window = getPartnershipYearWindow(agency, now)!
    yearStart = window.start
    yearEnd = window.end
    partnershipYearNumber = window.yearNumber
    calendarYear = window.start.getUTCFullYear()
    if (partnershipYearNumber > 1) {
      const priorProbe = new Date(window.start)
      priorProbe.setUTCFullYear(priorProbe.getUTCFullYear() - 1)
      const prior = getPartnershipYearWindow(agency, priorProbe)!
      priorStart = prior.start
      priorEnd = prior.end
    }
  } else {
    yearStart = new Date(Date.UTC(currentCalendarYear, 0, 1))
    yearEnd = new Date(Date.UTC(currentCalendarYear + 1, 0, 1))
    warnings.push('partnership_start_date_missing')
  }

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

  let priorYearMinCount: number | null = null
  if (priorStart && priorEnd) {
    const priorDeals = await licenseDealService.listForMinWidget(
      { tenantId: auth.tenantId, agencyId: member.agencyId },
      { yearStart: priorStart, yearEnd: priorEnd },
    )
    priorYearMinCount = priorDeals.length
  }

  return NextResponse.json({
    ok: true,
    year: calendarYear,
    calendarYear,
    partnershipYear: partnershipYearNumber,
    period: {
      partnershipYear:
        partnershipYearNumber != null
          ? {
              start: yearStart.toISOString(),
              end: yearEnd.toISOString(),
              number: partnershipYearNumber,
              priorYearMinCount,
            }
          : null,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
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
        calendarYear: z.number().int(),
        partnershipYear: z.number().int().nullable(),
        period: z.object({
          partnershipYear: z
            .object({
              start: z.string(),
              end: z.string(),
              number: z.number().int(),
              priorYearMinCount: z.number().int().nullable(),
            })
            .nullable(),
          warnings: z.array(z.string()).optional(),
        }),
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
