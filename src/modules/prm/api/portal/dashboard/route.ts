import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { hasFeature } from '@open-mercato/shared/security/features'
import type { AgencyMemberService } from '../../../lib/agencyMemberService'
import type { AgencyService } from '../../../lib/agencyService'
import { computeTierProgress } from '../../../lib/tierRequirements'
import { getPartnershipYearWindow } from '../../../lib/partnershipYear'
import type { LicenseDealService } from '../../../lib/licenseDealService'
import type { AgencyTier } from '../../../data/validators'

/**
 * Portal P2 dashboard aggregate (Spec #2 — wip-scoreboard).
 *
 * Single endpoint that returns everything the dashboard needs in one round-trip:
 *   - WIP widget: monthly + yearly counts of prospects in `status NOT IN ('lost')`
 *     with `source = 'agency_owned'` per invariant #14.
 *   - WIC widget: per-member breakdown of WIC contributions for the current month + year.
 *     The `prm_wic_contributions` table is owned by Spec #4 (wic-ingestion). When the
 *     table doesn't exist yet OR contains zero rows, we surface `{ awaiting: true }`
 *     and the widget renders the placeholder.
 *   - Tier widget: current Agency.tier + computed pct-to-next-tier.
 *   - Agency status banner data: surface `agency.status === 'historical'` for the
 *     onboarding-incomplete + historical-cascade UX.
 *
 * Cache invalidation tag:
 *   `prm.agency.{agencyId}.dashboard.{yyyy-mm}` — events `prm.prospect.*` for that
 *   agency invalidate the tag. Cache layer wiring is added when the dashboard hits
 *   sustained traffic; v1 ships uncached (per spec §3.1 60s TTL — the per-route
 *   cache wrapping is a follow-up since the framework's cache attachment hooks live
 *   at the CRUD-factory layer that this hand-rolled portal route does not use).
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  GET: { requireAuth: false },
}

const queryParser = z.object({
  /** Optional override for the WIP/WIC year. Defaults to current UTC year. */
  year: z.coerce.number().int().min(2000).max(3000).optional(),
  /** Optional override for the WIP/WIC month (1-12). Defaults to current UTC month. */
  month: z.coerce.number().int().min(1).max(12).optional(),
})

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
    await requireCustomerFeature(auth, ['prm.dashboard.view'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const url = new URL(req.url)
  const parsed = queryParser.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) {
    return NextResponse.json({ ok: true, dashboard: null })
  }
  const agencyService = container.resolve('agencyService') as AgencyService
  const agency = await agencyService.findById(member.agencyId, { tenantId: auth.tenantId })
  if (!agency) {
    return NextResponse.json({ ok: true, dashboard: null })
  }

  const now = new Date()
  const year = parsed.data.year ?? now.getUTCFullYear()
  const month = parsed.data.month ?? now.getUTCMonth() + 1
  const monthStart = new Date(Date.UTC(year, month - 1, 1))
  const monthEnd = new Date(Date.UTC(year, month, 1))

  // Partnership-year window (SPEC-2026-05-10). When the anchor is set, the
  // "this year" toggles on WIP / WIC and the MIN window all use this same
  // window. When null, fall back to calendar year + surface a warning.
  const partnershipWindow = getPartnershipYearWindow(agency, now)
  const yearStart = partnershipWindow?.start ?? new Date(Date.UTC(year, 0, 1))
  const yearEnd = partnershipWindow?.end ?? new Date(Date.UTC(year + 1, 0, 1))
  const periodWarnings: string[] = partnershipWindow ? [] : ['partnership_start_date_missing']

  // Prior partnership-year window (for the MIN rollover affordance — caption
  // "Year N-1 closed with X licenses" during the first 30 days of a new year).
  let priorWindow: { start: Date; end: Date } | null = null
  if (partnershipWindow && partnershipWindow.yearNumber > 1) {
    const priorProbe = new Date(partnershipWindow.start)
    priorProbe.setUTCFullYear(priorProbe.getUTCFullYear() - 1)
    const prior = getPartnershipYearWindow(agency, priorProbe)
    if (prior) priorWindow = { start: prior.start, end: prior.end }
  }

  const em = container.resolve('em') as EntityManager
  const knex = em.getKnex()

  // --- WIP widget query (invariant #14 filter) -----------------------------
  const wipBaseQuery = knex('prm_prospects')
    .where('tenant_id', auth.tenantId)
    .where('agency_id', agency.id)
    .whereNull('deleted_at')
    .where('source', 'agency_owned')
    .whereNot('status', 'lost')

  const [wipMonthRow] = (await wipBaseQuery
    .clone()
    .where('registered_at', '>=', monthStart)
    .where('registered_at', '<', monthEnd)
    .count<{ count: string }[]>('* as count')) as Array<{ count: string }>
  const [wipYearRow] = (await wipBaseQuery
    .clone()
    .where('registered_at', '>=', yearStart)
    .where('registered_at', '<', yearEnd)
    .count<{ count: string }[]>('* as count')) as Array<{ count: string }>

  // Per-status breakdown for the year (used by P2 sub-widget in dashboards).
  const statusRows = (await wipBaseQuery
    .clone()
    .where('registered_at', '>=', yearStart)
    .where('registered_at', '<', yearEnd)
    .groupBy('status')
    .select<{ status: string; count: string }[]>('status')
    .count('* as count')) as Array<{ status: string; count: string }>

  // --- WIC widget query (Spec #4 owns the table) ---------------------------
  // Best-effort introspect: if the table doesn't exist OR is empty, signal `awaiting`
  // so the widget renders the placeholder.
  let wic: {
    awaiting: boolean
    monthlyTotal: number
    yearlyTotal: number
    perMember: Array<{ agencyMemberId: string; firstName: string; lastName: string; monthly: number; yearly: number }>
  } = { awaiting: true, monthlyTotal: 0, yearlyTotal: 0, perMember: [] }
  try {
    const tableExists = (await knex.raw(
      `select to_regclass('public.prm_wic_contributions') as oid`,
    )) as { rows: Array<{ oid: string | null }> }
    const exists = tableExists.rows?.[0]?.oid !== null
    if (exists) {
      const tableInfo = (await knex.raw(
        `select column_name from information_schema.columns where table_name = 'prm_wic_contributions'`,
      )) as { rows: Array<{ column_name: string }> }
      const cols = new Set(tableInfo.rows.map((r) => r.column_name))
      const memberCol = cols.has('agency_member_id')
        ? 'agency_member_id'
        : cols.has('member_id')
          ? 'member_id'
          : null
      const dateCol = cols.has('contributed_at')
        ? 'contributed_at'
        : cols.has('imported_at')
          ? 'imported_at'
          : cols.has('contribution_date')
            ? 'contribution_date'
            : null
      const valueCol = cols.has('contribution_count')
        ? 'contribution_count'
        : cols.has('value')
          ? 'value'
          : cols.has('count')
            ? 'count'
            : null
      if (memberCol && dateCol && valueCol && cols.has('agency_id') && cols.has('tenant_id')) {
        const wicBase = knex('prm_wic_contributions')
          .where('tenant_id', auth.tenantId)
          .where('agency_id', agency.id)
        const monthlyAgg = (await wicBase
          .clone()
          .where(dateCol, '>=', monthStart)
          .where(dateCol, '<', monthEnd)
          .sum<{ total: string }[]>(`${valueCol} as total`)) as Array<{ total: string }>
        const yearlyAgg = (await wicBase
          .clone()
          .where(dateCol, '>=', yearStart)
          .where(dateCol, '<', yearEnd)
          .sum<{ total: string }[]>(`${valueCol} as total`)) as Array<{ total: string }>
        const monthlyByMember = (await wicBase
          .clone()
          .where(dateCol, '>=', monthStart)
          .where(dateCol, '<', monthEnd)
          .groupBy(memberCol)
          .select<{ member: string; total: string }[]>(`${memberCol} as member`)
          .sum(`${valueCol} as total`)) as Array<{ member: string; total: string }>
        const yearlyByMember = (await wicBase
          .clone()
          .where(dateCol, '>=', yearStart)
          .where(dateCol, '<', yearEnd)
          .groupBy(memberCol)
          .select<{ member: string; total: string }[]>(`${memberCol} as member`)
          .sum(`${valueCol} as total`)) as Array<{ member: string; total: string }>
        const memberRows = (await knex('prm_agency_members')
          .where('agency_id', agency.id)
          .whereNull('deleted_at')
          .select<
            { id: string; first_name: string; last_name: string }[]
          >('id', 'first_name', 'last_name')) as Array<{
          id: string
          first_name: string
          last_name: string
        }>
        const monthlyMap = new Map(monthlyByMember.map((r) => [r.member, Number(r.total ?? 0)]))
        const yearlyMap = new Map(yearlyByMember.map((r) => [r.member, Number(r.total ?? 0)]))
        const perMember = memberRows.map((m) => ({
          agencyMemberId: m.id,
          firstName: m.first_name,
          lastName: m.last_name,
          monthly: monthlyMap.get(m.id) ?? 0,
          yearly: yearlyMap.get(m.id) ?? 0,
        }))
        const monthlyTotal = Number(monthlyAgg[0]?.total ?? 0)
        const yearlyTotal = Number(yearlyAgg[0]?.total ?? 0)
        wic = {
          awaiting: monthlyTotal === 0 && yearlyTotal === 0,
          monthlyTotal,
          yearlyTotal,
          perMember,
        }
      }
    }
  } catch {
    // Schema introspection failed — keep the awaiting placeholder.
    wic = { awaiting: true, monthlyTotal: 0, yearlyTotal: 0, perMember: [] }
  }

  // --- MIN counts for rollover affordance (SPEC-2026-05-10) ----------------
  // Only computed when partnershipWindow is present — calendar-year MIN is
  // already exposed by /api/prm/portal/min, no need to duplicate.
  let priorYearMinCount: number | null = null
  if (partnershipWindow && priorWindow) {
    try {
      const licenseDealService = container.resolve('licenseDealService') as LicenseDealService
      const priorDeals = await licenseDealService.listForMinWidget(
        { tenantId: auth.tenantId, agencyId: agency.id },
        { yearStart: priorWindow.start, yearEnd: priorWindow.end },
      )
      priorYearMinCount = priorDeals.length
    } catch {
      priorYearMinCount = null
    }
  }

  // --- Tier widget ---------------------------------------------------------
  const wipMonthly = Number(wipMonthRow?.count ?? 0)
  const wipYearly = Number(wipYearRow?.count ?? 0)
  const tier = computeTierProgress({
    current: agency.tier as AgencyTier,
    currentWip: wipYearly,
    currentMonthlyWic: wic.monthlyTotal,
  })

  const features = auth.resolvedFeatures
  const canViewWic = hasFeature(features, 'prm.wic.read_own_agency')
  const canViewTier = hasFeature(features, 'prm.tier_requirement.read')

  return NextResponse.json({
    ok: true,
    dashboard: {
      agency: {
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
        status: agency.status,
        tier: agency.tier,
      },
      period: {
        year,
        month,
        partnershipYear: partnershipWindow
          ? {
              start: partnershipWindow.start.toISOString(),
              end: partnershipWindow.end.toISOString(),
              number: partnershipWindow.yearNumber,
              priorYearMinCount,
            }
          : null,
        ...(periodWarnings.length > 0 ? { warnings: periodWarnings } : {}),
      },
      wip: {
        monthly: wipMonthly,
        yearly: wipYearly,
        byStatus: Object.fromEntries(
          statusRows.map((r) => [r.status, Number(r.count ?? 0)]),
        ) as Record<string, number>,
      },
      wic: canViewWic
        ? wic
        : { awaiting: true, monthlyTotal: 0, yearlyTotal: 0, perMember: [] },
      tier: canViewTier
        ? {
            current: tier.current,
            next: tier.next,
            pctToNext: tier.pctToNext,
          }
        : null,
    },
  })
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const getDoc: OpenApiMethodDoc = {
  summary: 'Portal dashboard aggregate (P2)',
  description:
    'Single round-trip aggregate for the portal P2 dashboard: WIP, WIC, tier-progress, agency banner.',
  tags: ['PRM Portal'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        dashboard: z.union([z.null(), z.record(z.string(), z.any())]),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Dashboard feature missing', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal dashboard aggregate',
  methods: { GET: getDoc },
}
