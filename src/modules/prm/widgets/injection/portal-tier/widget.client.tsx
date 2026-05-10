'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'
import { useDashboardData, type TierRequirement } from '../_shared/useDashboardData'

export default function PortalTierWidget() {
  const t = useT()
  const { data, loading, error } = useDashboardData()

  if (loading) {
    return <div className="text-xs text-muted-foreground">{t('prm.portal.dashboard.loading', 'Loading…')}</div>
  }
  if (error || !data) {
    return (
      <div className="text-xs text-muted-foreground">
        {error ?? t('prm.portal.dashboard.loadError', 'Failed to load dashboard.')}
      </div>
    )
  }

  const tier = data.tier
  if (!tier) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('prm.portal.dashboard.tier.unavailable', 'Tier data is not available for your account.')}
      </div>
    )
  }

  const currentRank = tier.current.rank
  // Sort defensively in case the server returns out of order.
  const ranks = [...tier.all].sort((a, b) => a.rank - b.rank)

  // KPI rail values — sourced from the same dashboard aggregate so rails match
  // the other widgets exactly. WIC + WIP are monthly KPIs; MIN is annual.
  const wicMonthly = data.wic.awaiting ? 0 : data.wic.monthlyTotal
  const wipMonthly = data.wip.monthly
  const minYear = data.min?.currentYearCount ?? 0
  const nextWipTarget = tier.next?.minWip ?? tier.current.minWip
  const nextWicTarget = tier.next?.minMonthlyWic ?? tier.current.minMonthlyWic
  const nextMinTarget = tier.next?.minYearlyMin ?? tier.current.minYearlyMin

  const pctOf = (v: number, target: number) =>
    target <= 0 ? 100 : Math.min(100, (v / target) * 100)

  return (
    <div>
      {/* 4-tier horizontal stepper */}
      <ol className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {ranks.map((req, i) => {
          const filled = req.rank < currentRank
          const isCurrent = req.rank === currentRank
          const isNext = tier.next != null && req.rank === tier.next.rank
          const showSegment = i < ranks.length - 1
          return (
            <li key={req.tier} className="group relative flex flex-1 items-center gap-2 last:flex-none">
              <span
                className={cn(
                  'grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold',
                  isCurrent
                    ? 'bg-foreground text-background'
                    : isNext
                      ? 'border-2 border-foreground'
                      : filled
                        ? 'bg-foreground/30'
                        : 'border bg-muted/40',
                )}
              >
                {req.rank + 1}
              </span>
              <span
                className={cn(
                  'truncate',
                  isCurrent ? 'font-medium text-foreground' : '',
                )}
              >
                {humaniseTier(req.tier)}
              </span>
              {showSegment ? (
                <span
                  className={cn(
                    'h-[3px] flex-1 rounded-full',
                    req.rank < currentRank ? 'bg-foreground/60' : 'bg-muted',
                  )}
                />
              ) : null}
              {/* Hover tooltip — shows targets for this tier */}
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1.5 text-[11px] leading-snug text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                {isCurrent
                  ? t('prm.portal.dashboard.tier.tooltipCurrent', 'Current tier')
                  : isNext
                    ? t('prm.portal.dashboard.tier.tooltipNext', 'Next tier')
                    : null}
                {isCurrent || isNext ? <br /> : null}
                {t('prm.portal.dashboard.tier.tooltipTargets', '{wip} WIP / mo · {wic} WIC / mo · {min} MIN / yr', {
                  wip: req.minWip,
                  wic: req.minMonthlyWic,
                  min: req.minYearlyMin,
                })}
              </span>
            </li>
          )
        })}
      </ol>

      {/* Current-tier callout */}
      <div className="mt-5 rounded-md bg-muted/40 p-3">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('prm.portal.dashboard.tier.current', 'Current tier')}
            </p>
            <p className="mt-0.5 text-lg font-semibold tracking-tight">
              {humaniseTier(tier.current.tier)}
            </p>
          </div>
          {tier.next ? (
            <p className="text-[11px] text-muted-foreground">
              {t('prm.portal.dashboard.tier.towards', 'Towards {next} · {pct}% complete', {
                next: humaniseTier(tier.next.tier),
                pct: Math.round(tier.pctToNext * 100),
              })}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('prm.portal.dashboard.tier.atTop', 'At top tier — well done.')}
            </p>
          )}
        </div>
      </div>

      {/* 3 KPI rails */}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.wic', 'WIC / month')}
          current={wicMonthly}
          target={nextWicTarget}
          pct={pctOf(wicMonthly, nextWicTarget)}
          caption={t('prm.portal.dashboard.tier.rail.wicCaption', 'Scored contributions to OM repos.')}
        />
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.wip', 'WIP / month')}
          current={wipMonthly}
          target={nextWipTarget}
          pct={pctOf(wipMonthly, nextWipTarget)}
          caption={t('prm.portal.dashboard.tier.rail.wipCaption', 'Prospects in progress.')}
        />
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.min', 'MIN / year')}
          current={minYear}
          target={nextMinTarget}
          pct={pctOf(minYear, nextMinTarget)}
          caption={t('prm.portal.dashboard.tier.rail.minCaption', 'Licenses attributed (always annual).')}
        />
      </div>
    </div>
  )
}

function KpiRail({
  label,
  current,
  target,
  pct,
  caption,
}: {
  label: string
  current: number
  target: number
  pct: number
  caption: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-medium">{label}</p>
        <p className="text-[11px]">
          <span className="font-semibold">{current}</span>
          <span className="text-muted-foreground"> / {target}</span>
        </p>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground/70" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{caption}</p>
    </div>
  )
}

function humaniseTier(tier: string): string {
  switch (tier) {
    case 'om_agency':
      return 'OM Agency'
    case 'ai_native':
      return 'AI-native'
    case 'ai_native_expert':
      return 'AI-native Expert'
    case 'ai_native_core':
      return 'AI-native Core'
    default:
      return tier
  }
}
