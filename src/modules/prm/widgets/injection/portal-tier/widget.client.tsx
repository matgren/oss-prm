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
  // the other widgets exactly. Rails measure CURRENT-tier maintenance: are we
  // still hitting the thresholds for the tier we hold? Progress toward the
  // next tier is conveyed via the stepper pips + per-pip tooltips, not here.
  const wicMonthly = data.wic.awaiting ? 0 : data.wic.monthlyTotal
  const wipMonthly = data.wip.monthly
  const minYear = data.min?.currentYearCount ?? 0
  const currentWipTarget = tier.current.minWip
  const currentWicTarget = tier.current.minMonthlyWic
  const currentMinTarget = tier.current.minYearlyMin

  const pctOf = (v: number, target: number) =>
    target <= 0 ? 100 : Math.min(100, (v / target) * 100)

  return (
    <div className="min-w-0">
      {/* 4-tier horizontal stepper. Labels render BELOW the pips so long names
          ("AI-native Expert", "AI-native Core") don't overflow the card; the
          per-pip tooltip renders above the row, so we deliberately do NOT clip
          overflow on the <ol>. Horizontal overflow is already prevented by
          min-w-0 on each <li> + truncate on the label span. */}
      <ol className="flex w-full items-start gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        {ranks.map((req, i) => {
          const filled = req.rank < currentRank
          const isCurrent = req.rank === currentRank
          const isNext = tier.next != null && req.rank === tier.next.rank
          const showSegment = i < ranks.length - 1
          return (
            <li
              key={req.tier}
              className="group relative flex min-w-0 flex-1 flex-col items-center gap-1 text-center"
            >
              <div className="flex w-full items-center gap-1">
                <span
                  className={cn(
                    'grid h-6 w-6 flex-none place-items-center rounded-full text-[11px] font-semibold',
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
                {showSegment ? (
                  <span
                    className={cn(
                      'h-[3px] min-w-0 flex-1 rounded-full',
                      req.rank < currentRank ? 'bg-foreground/60' : 'bg-muted',
                    )}
                  />
                ) : null}
              </div>
              <span
                className={cn(
                  'block w-full truncate text-[10px]',
                  isCurrent ? 'font-medium text-foreground' : '',
                )}
                title={humaniseTier(req.tier)}
              >
                {humaniseTier(req.tier)}
              </span>
              {/* Hover tooltip — leads with the tier name so non-current,
                  non-next pips still self-identify; explains the WIC/WIP/MIN
                  targets that must be met to *maintain* this tier. */}
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[16rem] -translate-x-1/2 whitespace-normal rounded-md bg-foreground px-2.5 py-2 text-left text-[11px] leading-snug normal-case tracking-normal text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <span className="block font-semibold">
                  {humaniseTier(req.tier)}
                </span>
                {isCurrent ? (
                  <span className="mt-0.5 block text-background/70">
                    {t('prm.portal.dashboard.tier.tooltipCurrent', 'Your current tier')}
                  </span>
                ) : isNext ? (
                  <span className="mt-0.5 block text-background/70">
                    {t('prm.portal.dashboard.tier.tooltipNext', 'Next tier')}
                  </span>
                ) : null}
                <span className="mt-1 block">
                  {t(
                    'prm.portal.dashboard.tier.tooltipTargets',
                    'Targets: {wip} WIP / mo · {wic} WIC / mo · {min} MIN / partner yr',
                    {
                      wip: req.minWip,
                      wic: req.minMonthlyWic,
                      min: req.minYearlyMin,
                    },
                  )}
                </span>
              </span>
            </li>
          )
        })}
      </ol>

      {/* Current-tier callout — name only; next-tier progress is conveyed by
          the stepper above + per-pip tooltips, not duplicated here. */}
      <div className="mt-5 rounded-md bg-muted/40 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('prm.portal.dashboard.tier.current', 'Current tier')}
        </p>
        <p className="mt-0.5 text-lg font-semibold tracking-tight">
          {humaniseTier(tier.current.tier)}
        </p>
      </div>

      {/* 3 KPI rails — maintenance view: agency vs. current tier's thresholds. */}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.wic', 'WIC / month')}
          current={wicMonthly}
          target={currentWicTarget}
          pct={pctOf(wicMonthly, currentWicTarget)}
          caption={t('prm.portal.dashboard.tier.rail.wicCaption', 'Scored contributions to OM repos.')}
        />
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.wip', 'WIP / month')}
          current={wipMonthly}
          target={currentWipTarget}
          pct={pctOf(wipMonthly, currentWipTarget)}
          caption={t('prm.portal.dashboard.tier.rail.wipCaption', 'Prospects in progress.')}
        />
        <KpiRail
          label={t('prm.portal.dashboard.tier.rail.min', 'MIN / partnership yr')}
          current={minYear}
          target={currentMinTarget}
          pct={pctOf(minYear, currentMinTarget)}
          caption={t(
            'prm.portal.dashboard.tier.rail.minCaption',
            'Licenses attributed in the partnership year.',
          )}
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
