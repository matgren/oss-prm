'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PortalCardDivider } from '@open-mercato/ui/portal/components/PortalCard'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type MinDeal = {
  licenseIdentifier: string
  clientIndustry: string | null
  closedAt: string | null
  signedAt: string | null
  annualValueUsd: { low: number; high: number } | null
  status: string
}

type MinResponse = {
  ok: true
  year: number
  calendarYear?: number
  partnershipYear?: number | null
  period?: {
    partnershipYear: {
      start: string
      end: string
      number: number
      priorYearMinCount: number | null
    } | null
    warnings?: string[]
  }
  ownCount: number
  ownAnnualValueUsd: number
  ownDeals: MinDeal[]
}

export default function PortalMinWidget() {
  const t = useT()
  const [data, setData] = React.useState<MinResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    let mounted = true
    void (async () => {
      const res = await apiCall<MinResponse>('/api/prm/portal/min')
      if (!mounted) return
      if (res.ok && res.result?.ok) {
        setData(res.result)
      } else {
        setFailed(true)
      }
      setLoading(false)
    })()
    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return <div className="text-xs text-muted-foreground">{t('prm.portal.dashboard.loading', 'Loading…')}</div>
  }
  // Match the legacy page's "silently skip when 403" guarantee — render nothing on failure.
  if (failed || !data) return null

  // SPEC-2026-05-10 — partnership-year envelope.
  const partnership = data.period?.partnershipYear ?? null
  const anchorMissing = !!data.period?.warnings?.includes('partnership_start_date_missing')

  // Rollover hint: within 30 days before partnership year ends.
  const now = Date.now()
  const msIn30Days = 30 * 24 * 60 * 60 * 1000
  const rolloverIn30Days =
    partnership && new Date(partnership.end).getTime() - now <= msIn30Days &&
    new Date(partnership.end).getTime() - now > 0

  // Prior-year caption: within 30 days after the current year started.
  const inFirst30DaysOfYear =
    partnership &&
    partnership.priorYearMinCount != null &&
    now - new Date(partnership.start).getTime() <= msIn30Days

  if (data.ownCount === 0) {
    return (
      <div className="space-y-2">
        {anchorMissing ? (
          <div className="rounded-md border border-dashed bg-amber-50/50 px-3 py-2 text-[11px] text-muted-foreground">
            {t(
              'prm.portal.dashboard.partnership.anchorMissing',
              'OM staff: set this agency’s partnership start date to enable accurate yearly KPIs.',
            )}
          </div>
        ) : null}
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
          {t(
            'prm.min.empty',
            'No attributed licenses yet — keep registering Prospects. We’ll update your MIN here once one of them purchases an OM license.',
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {anchorMissing ? (
        <div className="rounded-md border border-dashed bg-amber-50/50 px-3 py-2 text-[11px] text-muted-foreground">
          {t(
            'prm.portal.dashboard.partnership.anchorMissing',
            'OM staff: set this agency’s partnership start date to enable accurate yearly KPIs.',
          )}
        </div>
      ) : null}
      {rolloverIn30Days ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {t(
            'prm.portal.dashboard.partnership.rolloverSoon',
            'New partnership year starts {date} — your MIN counter will reset.',
            { date: new Date(partnership!.end).toLocaleDateString() },
          )}
        </div>
      ) : null}
      {inFirst30DaysOfYear ? (
        <div className="text-[11px] text-muted-foreground">
          {t(
            'prm.portal.dashboard.partnership.priorYearClosed',
            'Year {prev} closed with {count} {count, plural, one {license} other {licenses}}.',
            { prev: partnership!.number - 1, count: partnership!.priorYearMinCount! },
          )}
        </div>
      ) : null}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('prm.min.summary.count', 'Attributed deals')}
          </div>
          <div className="text-3xl font-semibold tracking-tight">{data.ownCount}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('prm.min.summary.total', 'Total annual value (USD)')}
          </div>
          <div className="text-3xl font-semibold tracking-tight">
            ${data.ownAnnualValueUsd.toLocaleString()}
          </div>
        </div>
      </div>
      <PortalCardDivider />
      <ul className="space-y-1 text-xs">
        {data.ownDeals.slice(0, 8).map((d) => (
          <li key={d.licenseIdentifier} className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{d.licenseIdentifier}</span>
            <span className="truncate text-muted-foreground">{d.clientIndustry ?? '—'}</span>
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
  )
}
