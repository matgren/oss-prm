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
  const entries = Object.entries(data.wip.byStatus)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('prm.portal.dashboard.wip.subtitle', 'Active prospects (excluding lost).')}
        </span>
        <ScopeToggle value={scope} onChange={setScope} t={t} />
      </div>
      <div className="text-4xl font-semibold tracking-tight">{value}</div>
      <PortalCardDivider />
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {entries.length === 0 ? (
          <span>
            {t(
              'prm.portal.dashboard.wip.empty',
              'No prospects yet — register one to populate this widget.',
            )}
          </span>
        ) : (
          entries.map(([status, count]) => (
            <div key={status} className="flex items-center justify-between">
              <span>{status}</span>
              <span className="font-medium text-foreground">{count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
