'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PortalCardDivider } from '@open-mercato/ui/portal/components/PortalCard'
import { useDashboardData } from '../_shared/useDashboardData'

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

  const pct = Math.round(tier.pctToNext * 100)

  return (
    <div>
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        {tier.next
          ? t('prm.portal.dashboard.tier.subtitle', 'Towards {next}', { next: tier.next.tier })
          : t('prm.portal.dashboard.tier.atTop', 'At top tier — well done.')}
      </div>
      <div>
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
                pct,
                next: tier.next.tier,
              })}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-foreground/70" style={{ width: `${pct}%` }} />
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
    </div>
  )
}
