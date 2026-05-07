'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  PortalCard,
  PortalCardHeader,
  PortalCardDivider,
} from '@open-mercato/ui/portal/components/PortalCard'
import { Button } from '@open-mercato/ui/primitives/button'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { cn } from '@open-mercato/shared/lib/utils'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { PartnerStatusBanner } from '../_components/PartnerStatusBanner'

type TierRequirement = {
  tier: string
  minWip: number
  minMonthlyWic: number
  rank: number
}

type DashboardResponse = {
  ok: true
  dashboard: {
    agency: {
      id: string
      name: string
      slug: string
      status: string
      tier: string
    }
    period: { year: number; month: number }
    wip: {
      monthly: number
      yearly: number
      byStatus: Record<string, number>
    }
    wic: {
      awaiting: boolean
      monthlyTotal: number
      yearlyTotal: number
      perMember: Array<{
        agencyMemberId: string
        firstName: string
        lastName: string
        monthly: number
        yearly: number
      }>
    }
    tier: {
      current: TierRequirement
      next: TierRequirement | null
      pctToNext: number
    } | null
  } | null
}

type ScopeMode = 'monthly' | 'yearly'

type MinResponse = {
  ok: true
  year: number
  ownCount: number
  ownAnnualValueUsd: number
  ownDeals: Array<{
    licenseIdentifier: string
    clientIndustry: string | null
    closedAt: string | null
    signedAt: string | null
    annualValueUsd: { low: number; high: number } | null
    status: string
  }>
}

function ScopeToggle(props: { value: ScopeMode; onChange: (v: ScopeMode) => void; t: (k: string, fb?: string) => string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-auto rounded-none px-2 py-1 text-xs hover:bg-transparent',
          props.value === 'monthly' ? 'bg-foreground text-background' : 'bg-background text-muted-foreground',
        )}
        onClick={() => props.onChange('monthly')}
      >
        {props.t('prm.portal.dashboard.toggle.monthly', 'This month')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-auto rounded-none px-2 py-1 text-xs hover:bg-transparent',
          props.value === 'yearly' ? 'bg-foreground text-background' : 'bg-background text-muted-foreground',
        )}
        onClick={() => props.onChange('yearly')}
      >
        {props.t('prm.portal.dashboard.toggle.yearly', 'This year')}
      </Button>
    </div>
  )
}

function NoAgencyState({ t }: { t: (k: string, fb?: string) => string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6">
      <h1 className="text-xl font-semibold">{t('prm.portal.dashboard.title', 'Dashboard')}</h1>
      <p className="text-sm text-muted-foreground">
        {t(
          'prm.portal.dashboard.notLinked',
          'Your account is not linked to an agency yet — your dashboard will appear here once OM PartnerOps activates your invite.',
        )}
      </p>
    </div>
  )
}

/**
 * P2 — Partner Portal Dashboard (Spec #2 — wip-scoreboard).
 *
 * Assembles three widgets via `PortalCard`:
 *   - WIP widget: prospect count NOT IN ('lost') AND source='agency_owned' (invariant #14)
 *   - WIC widget: per-member breakdown (Spec #4 owned data; placeholder when awaiting)
 *   - Tier-progress widget: pct-to-next
 *
 * Each widget has a monthly/yearly toggle (L-011: a single widget with a toggle, not two
 * widgets). The historical-status banner from Spec #1's cascade is rendered at the top.
 */
export default function PortalDashboardPage() {
  const t = useT()
  const [data, setData] = React.useState<DashboardResponse['dashboard'] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [wipScope, setWipScope] = React.useState<ScopeMode>('monthly')
  const [wicScope, setWicScope] = React.useState<ScopeMode>('monthly')
  const [min, setMin] = React.useState<MinResponse | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dashRes, minRes] = await Promise.all([
        apiCall<DashboardResponse>('/api/prm/portal/dashboard'),
        apiCall<MinResponse>('/api/prm/portal/min'),
      ])
      if (!dashRes.ok || !dashRes.result?.ok) {
        throw new Error(t('prm.portal.dashboard.loadError', 'Failed to load dashboard.'))
      }
      setData(dashRes.result.dashboard)
      // MIN widget is feature-gated separately — silently skip when 403.
      if (minRes.ok && minRes.result?.ok) setMin(minRes.result)
      else setMin(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) {
    return <LoadingMessage label={t('prm.portal.dashboard.loading', 'Loading…')} />
  }
  if (error) {
    return <ErrorMessage label={error} />
  }
  if (!data) {
    return <NoAgencyState t={t} />
  }

  const wip = data.wip
  const wic = data.wic
  const tier = data.tier
  const wipValue = wipScope === 'monthly' ? wip.monthly : wip.yearly
  const wicValue = wicScope === 'monthly' ? wic.monthlyTotal : wic.yearlyTotal

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">
          {t('prm.portal.dashboard.greeting', 'Welcome, {name}', { name: data.agency.name })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('prm.portal.dashboard.subtitle', 'Tier: {tier} · {month}/{year}', {
            tier: data.agency.tier,
            month: String(data.period.month).padStart(2, '0'),
            year: data.period.year,
          })}
        </p>
      </header>

      <PartnerStatusBanner
        status={data.agency.status}
        t={t}
        messageKey="prm.portal.dashboard.banner.historical"
        message="Your partnership is historical — most actions are paused. Contact OM PartnerOps to reactivate."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* WIP widget */}
        <PortalCard>
          <PortalCardHeader
            label={t('prm.portal.dashboard.wip.label', 'Pipeline')}
            title={t('prm.portal.dashboard.wip.title', 'Work In Progress')}
            description={t(
              'prm.portal.dashboard.wip.subtitle',
              'Active prospects (excluding lost).',
            )}
            action={<ScopeToggle value={wipScope} onChange={setWipScope} t={t} />}
          />
          <div className="mt-2 text-4xl font-semibold tracking-tight">{wipValue}</div>
          <PortalCardDivider />
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {Object.entries(wip.byStatus).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <span>{status}</span>
                <span className="font-medium text-foreground">{count}</span>
              </div>
            ))}
            {Object.keys(wip.byStatus).length === 0 ? (
              <span>{t('prm.portal.dashboard.wip.empty', 'No prospects yet — register one to populate this widget.')}</span>
            ) : null}
          </div>
        </PortalCard>

        {/* WIC widget */}
        <PortalCard>
          <PortalCardHeader
            label={t('prm.portal.dashboard.wic.label', 'Contributions')}
            title={t('prm.portal.dashboard.wic.title', 'Work In Code')}
            description={t(
              'prm.portal.dashboard.wic.subtitle',
              'Code contributions to OM repositories per member.',
            )}
            action={<ScopeToggle value={wicScope} onChange={setWicScope} t={t} />}
          />
          {wic.awaiting ? (
            <div className="mt-3 rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
              {t(
                'prm.portal.dashboard.wic.awaiting',
                'Awaiting WIC data — once your team has contributions to OM repositories they will appear here.',
              )}
            </div>
          ) : (
            <>
              <div className="mt-2 text-4xl font-semibold tracking-tight">{wicValue}</div>
              <PortalCardDivider />
              <div className="mt-2 space-y-1 text-xs">
                {wic.perMember.length === 0 ? (
                  <span className="text-muted-foreground">
                    {t('prm.portal.dashboard.wic.noMembers', 'No members tracked yet.')}
                  </span>
                ) : (
                  wic.perMember.map((m) => (
                    <div key={m.agencyMemberId} className="flex items-center justify-between text-muted-foreground">
                      <span className="truncate">
                        {m.firstName} {m.lastName}
                      </span>
                      <span className="font-medium text-foreground">
                        {wicScope === 'monthly' ? m.monthly : m.yearly}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </PortalCard>

        {/* Tier widget */}
        <PortalCard>
          <PortalCardHeader
            label={t('prm.portal.dashboard.tier.label', 'Tier')}
            title={t('prm.portal.dashboard.tier.title', 'Tier progress')}
            description={
              tier?.next
                ? t('prm.portal.dashboard.tier.subtitle', 'Towards {next}', { next: tier.next.tier })
                : t('prm.portal.dashboard.tier.atTop', 'At top tier — well done.')
            }
          />
          {tier ? (
            <>
              <div className="mt-2">
                <div className="text-2xl font-semibold tracking-tight">{tier.current.tier}</div>
                <div className="text-xs text-muted-foreground">
                  {t('prm.portal.dashboard.tier.current', 'Current tier')}
                </div>
              </div>
              {tier.next ? (
                <>
                  <PortalCardDivider />
                  <div className="mt-3 space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {t('prm.portal.dashboard.tier.pctToNext', '{pct}% to {next}', {
                        pct: Math.round(tier.pctToNext * 100),
                        next: tier.next.tier,
                      })}
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-foreground/70"
                        style={{ width: `${Math.round(tier.pctToNext * 100)}%` }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-2 text-xs text-muted-foreground">
                      <div>
                        <div>{t('prm.portal.dashboard.tier.minWip', 'WIP target')}</div>
                        <div className="font-medium text-foreground">{tier.next.minWip}</div>
                      </div>
                      <div>
                        <div>{t('prm.portal.dashboard.tier.minWic', 'Monthly WIC target')}</div>
                        <div className="font-medium text-foreground">{tier.next.minMonthlyWic}</div>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="mt-3 text-xs text-muted-foreground">
              {t('prm.portal.dashboard.tier.unavailable', 'Tier data is not available for your account.')}
            </div>
          )}
        </PortalCard>
      </div>

      {min ? (
        <PortalCard>
          <PortalCardHeader
            label={t('prm.min.label', 'MIN')}
            title={t('prm.min.title', 'MIN Attribution')}
            description={t(
              'prm.min.description',
              "Yearly Minimum Income Network attribution from this Agency's licensed deals.",
            )}
          />
          {min.ownCount === 0 ? (
            <div className="mt-3 rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
              {t(
                'prm.min.empty',
                'No attributed deals for this year yet — keep registering Prospects and the saga will fill this in.',
              )}
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('prm.min.summary.count', 'Attributed deals')}
                  </div>
                  <div className="text-3xl font-semibold tracking-tight">{min.ownCount}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('prm.min.summary.total', 'Total annual value (USD)')}
                  </div>
                  <div className="text-3xl font-semibold tracking-tight">
                    ${min.ownAnnualValueUsd.toLocaleString()}
                  </div>
                </div>
              </div>
              <PortalCardDivider />
              <ul className="space-y-1 text-xs">
                {min.ownDeals.slice(0, 8).map((d) => (
                  <li
                    key={d.licenseIdentifier}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate font-medium">{d.licenseIdentifier}</span>
                    <span className="truncate text-muted-foreground">
                      {d.clientIndustry ?? '—'}
                    </span>
                    <span className="text-muted-foreground">
                      {d.signedAt ? new Date(d.signedAt).toLocaleDateString() : '—'}
                    </span>
                    <span className="font-medium text-foreground">
                      {d.annualValueUsd
                        ? `$${d.annualValueUsd.low.toLocaleString()}–$${d.annualValueUsd.high.toLocaleString()}`
                        : '—'}
                    </span>
                    <span className="rounded-full border px-2 py-0.5">{d.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </PortalCard>
      ) : null}
    </div>
  )
}
