'use client'
import * as React from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * P9 — Partner Portal RFP inbox (Spec #5 §3.2 / US5.3).
 *
 * Per OQ-010: custom React, no DataTable. Visibility-gated server-side via
 * `RfpBroadcast` rows + portal-visible RFP statuses (silent 404, invariant #15).
 *
 * Tab semantics:
 *   - `unread`     — broadcasts with no first_open and no response yet (and not declined).
 *   - `responded`  — at least one own-Agency RfpResponse row exists.
 *   - `declined`   — broadcast.declined_at set.
 *   - `all`        — every visible broadcast for the Agency.
 */

type InboxItem = {
  broadcastId: string
  rfpId: string
  rfp: {
    id: string
    title: string
    receivedFrom: string
    receivedAt: string
    status: string
    industry: string | null
    budgetBucket: string | null
    timelineBucket: string | null
    deadlineToRespond: string | null
  }
  broadcastedAt: string
  firstOpenedAt: string | null
  declinedAt: string | null
  declineReason: string | null
  hasResponse: boolean
  responseStatus: 'draft' | 'submitted' | null
}

type ListResponse = {
  ok: true
  items: InboxItem[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  tab: string
}

type TabKey = 'unread' | 'responded' | 'declined' | 'all'

const TABS: ReadonlyArray<{ key: TabKey; labelKey: string; label: string }> = [
  { key: 'unread', labelKey: 'prm.portal.rfp.tab.unread', label: 'Unread' },
  { key: 'responded', labelKey: 'prm.portal.rfp.tab.responded', label: 'Responded' },
  { key: 'declined', labelKey: 'prm.portal.rfp.tab.declined', label: 'Declined' },
  { key: 'all', labelKey: 'prm.portal.rfp.tab.all', label: 'All' },
]

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString()
}

export default function PortalRfpInboxPage() {
  const t = useT()
  const [tab, setTab] = React.useState<TabKey>('all')
  const [items, setItems] = React.useState<InboxItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize] = React.useState(20)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        tab,
      })
      const res = await apiCall<ListResponse>(`/api/prm/portal/rfp?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.portal.rfp.loadError', 'Failed to load RFPs.'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prm.portal.rfp.loadError', 'Failed to load RFPs.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, tab, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const emptyMessage = React.useMemo(() => {
    switch (tab) {
      case 'unread':
        return t('prm.portal.rfp.empty.unread', 'No unread RFPs. New ones will appear here when OM PartnerOps publishes them.')
      case 'responded':
        return t('prm.portal.rfp.empty.responded', 'You have not responded to any RFPs yet.')
      case 'declined':
        return t('prm.portal.rfp.empty.declined', 'You have not declined any RFPs yet.')
      case 'all':
      default:
        return t('prm.portal.rfp.empty.all', 'No RFPs in your inbox yet.')
    }
  }, [tab, t])

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">{t('prm.portal.rfp.title', 'RFPs')}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'prm.portal.rfp.subtitle',
            'Requests for proposal addressed to your agency. Open one to read the brief and respond.',
          )}
        </p>
      </header>

      <nav
        className="flex flex-wrap gap-2 border-b text-sm"
        role="tablist"
        aria-label={t('prm.portal.rfp.tabsLabel', 'Inbox filter')}
      >
        {TABS.map((entry) => {
          const active = entry.key === tab
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`rfp-tab-${entry.key}`}
              onClick={() => {
                setPage(1)
                setTab(entry.key)
              }}
              className={[
                'px-3 py-2 -mb-px border-b-2 transition-colors',
                active
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t(entry.labelKey, entry.label)}
            </button>
          )
        })}
      </nav>

      {error ? <ErrorMessage label={error} /> : null}

      <ul className="space-y-2" data-testid="rfp-inbox-list">
        {loading && items.length === 0 ? (
          <li className="rounded-md border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            {t('prm.portal.rfp.loading', 'Loading…')}
          </li>
        ) : null}

        {!loading && items.length === 0 ? (
          <li className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </li>
        ) : null}

        {items.map((item) => {
          const unread = item.firstOpenedAt === null && !item.hasResponse && item.declinedAt === null
          const declined = item.declinedAt !== null
          const responded = item.hasResponse
          return (
            <li key={item.broadcastId}>
              <Link
                href={`./rfp/${item.rfpId}`}
                className="block rounded-md border bg-background p-4 transition-colors hover:bg-muted/30"
                data-testid={`rfp-row-${item.rfpId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          unread
                            ? 'text-base font-semibold'
                            : 'text-base font-medium text-muted-foreground'
                        }
                      >
                        {item.rfp.title}
                      </span>
                      {unread ? (
                        <span
                          className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary"
                          data-testid="rfp-badge-unread"
                        >
                          {t('prm.portal.rfp.badge.unread', 'New')}
                        </span>
                      ) : null}
                      {declined ? (
                        <span
                          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                          data-testid="rfp-badge-declined"
                        >
                          {t('prm.portal.rfp.badge.declined', 'Declined')}
                        </span>
                      ) : null}
                      {responded ? (
                        <span
                          className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                          data-testid="rfp-badge-responded"
                        >
                          {item.responseStatus === 'submitted'
                            ? t('prm.portal.rfp.badge.submitted', 'Submitted')
                            : t('prm.portal.rfp.badge.draft', 'Draft saved')}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t('prm.portal.rfp.receivedFrom', 'From {client}', { client: item.rfp.receivedFrom })}
                    </span>
                  </div>
                  <div className="flex flex-col items-end text-xs text-muted-foreground">
                    {item.rfp.deadlineToRespond ? (
                      <span data-testid="rfp-deadline">
                        {t('prm.portal.rfp.deadline', 'Deadline {date}', {
                          date: formatDate(item.rfp.deadlineToRespond) ?? '—',
                        })}
                      </span>
                    ) : null}
                    <span>
                      {t('prm.portal.rfp.broadcastedAt', 'Broadcast {date}', {
                        date: formatDate(item.broadcastedAt) ?? '—',
                      })}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('prm.portal.rfp.pagination', 'Showing {count} of {total}', {
              count: items.length,
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t('prm.portal.rfp.prev', 'Previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('prm.portal.rfp.next', 'Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
