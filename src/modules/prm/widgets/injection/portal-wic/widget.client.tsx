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

export default function PortalWicWidget() {
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

  const wic = data.wic

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t(
            'prm.portal.dashboard.wic.subtitle',
            'Scored code contributions to Open Mercato (L1–L4, with bounty multipliers).',
          )}
        </span>
        {!wic.awaiting ? <ScopeToggle value={scope} onChange={setScope} t={t} /> : null}
      </div>

      {wic.awaiting ? (
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
          {t(
            'prm.portal.dashboard.wic.awaiting',
            'No scored contributions yet. Once your team’s PRs to OM repos are merged and scored, they’ll appear here monthly.',
          )}
        </div>
      ) : (
        <>
          <div className="text-4xl font-semibold tracking-tight">
            {scope === 'monthly' ? wic.monthlyTotal : wic.yearlyTotal}
          </div>
          <PortalCardDivider />
          <div className="mt-2 space-y-1 text-xs">
            {wic.perMember.length === 0 ? (
              <span className="text-muted-foreground">
                {t('prm.portal.dashboard.wic.noMembers', 'No members tracked yet.')}
              </span>
            ) : (
              wic.perMember.map((m) => (
                <div
                  key={m.agencyMemberId}
                  className="flex items-center justify-between text-muted-foreground"
                >
                  <span className="truncate">
                    {m.firstName} {m.lastName}
                  </span>
                  <span className="font-medium text-foreground">
                    {scope === 'monthly' ? m.monthly : m.yearly}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
