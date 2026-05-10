'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { PortalCardDivider } from '@open-mercato/ui/portal/components/PortalCard'
import { cn } from '@open-mercato/shared/lib/utils'
import { useDashboardData } from '../_shared/useDashboardData'

type Scope = 'monthly' | 'yearly'

function ScopeToggle({
  value,
  onChange,
  t,
}: {
  value: Scope
  onChange: (next: Scope) => void
  t: (key: string, fallback?: string) => string
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-auto rounded-none px-2 py-1 text-xs hover:bg-transparent',
          value === 'monthly'
            ? 'bg-foreground text-background'
            : 'bg-background text-muted-foreground',
        )}
        onClick={() => onChange('monthly')}
      >
        {t('prm.portal.dashboard.toggle.monthly', 'This month')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-auto rounded-none px-2 py-1 text-xs hover:bg-transparent',
          value === 'yearly'
            ? 'bg-foreground text-background'
            : 'bg-background text-muted-foreground',
        )}
        onClick={() => onChange('yearly')}
      >
        {t('prm.portal.dashboard.toggle.yearly', 'This year')}
      </Button>
    </div>
  )
}

export default function PortalWipWidget() {
  const t = useT()
  const { data, loading, error } = useDashboardData()
  const [scope, setScope] = React.useState<Scope>('monthly')

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

  const value = scope === 'monthly' ? data.wip.monthly : data.wip.yearly
  const byStatus = data.wip.byStatus

  // Canonical prospect lifecycle (SPEC-2026-04-23-wip-scoreboard §1.4.2):
  //   new → qualified → contacted → won | dormant. `lost` is excluded by the
  //   WIP filter (invariant #14) so it never appears here.
  const STATUS_ORDER = ['new', 'qualified', 'contacted', 'won', 'dormant'] as const

  // Tier-maintenance context: show current-tier monthly WIP threshold so the
  // agency sees whether they're maintaining their tier. Yearly view drops the
  // threshold since WIP thresholds are monthly only.
  const currentTierMinWip = data.tier?.current.minWip ?? 0
  const currentTierLabel = data.tier?.current.tier ?? null
  const showThreshold = scope === 'monthly' && currentTierMinWip > 0 && currentTierLabel
  const pctOfThreshold = showThreshold
    ? Math.min(100, (value / currentTierMinWip) * 100)
    : 0

  const total = Math.max(1, value)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t(
            'prm.portal.dashboard.wip.subtitle',
            "Agency-owned prospects you've registered, excluding lost.",
          )}
        </span>
        <ScopeToggle value={scope} onChange={setScope} t={t} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight">{value}</span>
        {showThreshold ? (
          <span className="text-xs text-muted-foreground">
            {t('prm.portal.dashboard.wip.target', '/ {target} for {tier} tier', {
              target: currentTierMinWip,
              tier: humaniseTier(currentTierLabel!),
            })}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {scope === 'monthly'
              ? t('prm.portal.dashboard.wip.thisMonth', 'this month')
              : t('prm.portal.dashboard.wip.thisYear', 'this year')}
          </span>
        )}
      </div>
      {showThreshold ? (
        <div className="mt-2 h-2 w-32 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-foreground/70" style={{ width: `${pctOfThreshold}%` }} />
        </div>
      ) : null}
      <PortalCardDivider />
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {t('prm.portal.dashboard.wip.byStatus', 'By status')}
      </p>
      <div className="mt-2 space-y-1 text-xs">
        {value === 0 ? (
          <span className="text-muted-foreground">
            {t(
              'prm.portal.dashboard.wip.empty',
              'No prospects yet — register one to populate this widget.',
            )}
          </span>
        ) : (
          STATUS_ORDER.map((status) => {
            const count = byStatus[status] ?? 0
            const width = (count / total) * 100
            return (
              <div
                key={status}
                className="grid grid-cols-[90px,1fr,3ch] items-center gap-2 text-muted-foreground"
              >
                <span className="truncate capitalize">{status}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full bg-foreground/60"
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="text-right font-medium text-foreground">{count}</span>
              </div>
            )
          })
        )}
      </div>
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
