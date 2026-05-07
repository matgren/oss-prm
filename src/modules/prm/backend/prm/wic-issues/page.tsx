'use client'
import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { CheckCircle2 } from 'lucide-react'

type AuditRow = {
  id: string
  importBatchId: string
  rowIndex: number
  rejectionReason: string
  rejectionDetail: string | null
  resolvedAgencyId: string | null
  rawPayload: Record<string, unknown>
  scriptVersion: string
  month: string
  createdAt: string
  resolvedAt: string | null
  resolutionAction: string | null
}

type ListResponse = {
  ok: true
  items: AuditRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const REJECTION_OPTIONS = [
  { value: '', label: 'All reasons', labelKey: 'prm.wicIssues.filter.reason.all' },
  { value: 'unknown_github_profile', label: 'Unknown github_profile', labelKey: 'prm.wicIssues.reason.unknown_github_profile' },
  { value: 'ambiguous_github_profile', label: 'Ambiguous github_profile', labelKey: 'prm.wicIssues.reason.ambiguous_github_profile' },
  { value: 'malformed_month', label: 'Malformed month', labelKey: 'prm.wicIssues.reason.malformed_month' },
  { value: 'unknown_level', label: 'Unknown WIC level', labelKey: 'prm.wicIssues.reason.unknown_level' },
  { value: 'invalid_payload', label: 'Invalid payload', labelKey: 'prm.wicIssues.reason.invalid_payload' },
] as const

const RESOLVED_OPTIONS = [
  { value: 'false', label: 'Open issues', labelKey: 'prm.wicIssues.filter.resolved.false' },
  { value: 'true', label: 'Resolved', labelKey: 'prm.wicIssues.filter.resolved.true' },
  { value: 'all', label: 'All', labelKey: 'prm.wicIssues.filter.resolved.all' },
] as const

/**
 * B10 — WIC Import Issues (Spec #4 §3.4 + §6.2).
 *
 * OM PartnerOps triage queue. Default view: open (`resolved_at IS NULL`) issues.
 * Three resolution actions per row: accepted_after_fix / rolled_back / ignored.
 */
export default function WicIssuesBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<AuditRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [resolved, setResolved] = React.useState<'false' | 'true' | 'all'>('false')
  const [reason, setReason] = React.useState('')
  const [resolvingId, setResolvingId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        resolved,
      })
      if (reason) params.set('rejection_reason', reason)
      const res = await apiCall<ListResponse>(`/api/prm/wic/audit-log?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.wicIssues.error.loadFailed', 'Failed to load WIC audit log'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.wicIssues.error.loadFailed', 'Failed to load WIC audit log'),
      )
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, resolved, reason, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const resolveRow = React.useCallback(
    async (id: string, action: 'accepted_after_fix' | 'rolled_back' | 'ignored') => {
      setResolvingId(id)
      try {
        const res = await apiCall(`/api/prm/wic/audit-log/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ action }),
          headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) {
          throw new Error(t('prm.wicIssues.error.resolveFailed', 'Failed to resolve'))
        }
        flash(t('prm.wicIssues.resolved', 'Issue resolved'), 'success')
        await load()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('prm.wicIssues.error.resolveFailed', 'Failed to resolve'),
          'error',
        )
      } finally {
        setResolvingId(null)
      }
    },
    [load, t],
  )

  const columns = React.useMemo<ColumnDef<AuditRow>[]>(
    () => [
      {
        id: 'rejectionReason',
        header: t('prm.wicIssues.col.reason', 'Reason'),
        cell: ({ row }) => (
          <div className="flex flex-col text-sm">
            <span className="font-medium">
              {t(`prm.wicIssues.reason.${row.original.rejectionReason}`, row.original.rejectionReason)}
            </span>
            {row.original.rejectionDetail ? (
              <span className="text-xs text-muted-foreground">{row.original.rejectionDetail}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'githubProfile',
        header: t('prm.wicIssues.col.github', 'github_profile'),
        cell: ({ row }) => {
          const v = row.original.rawPayload?.github_profile
          return <span className="font-mono text-xs">{typeof v === 'string' ? v : '—'}</span>
        },
      },
      {
        id: 'month',
        header: t('prm.wicIssues.col.month', 'Month'),
        accessorKey: 'month',
      },
      {
        id: 'batch',
        header: t('prm.wicIssues.col.batch', 'Batch'),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.importBatchId.slice(0, 8)}…</span>
        ),
      },
      {
        id: 'createdAt',
        header: t('prm.wicIssues.col.created', 'Created'),
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
      },
      {
        id: 'status',
        header: t('prm.wicIssues.col.status', 'Status'),
        cell: ({ row }) =>
          row.original.resolvedAt ? (
            <StatusBadge variant="neutral">
              {t(
                `prm.wicIssues.action.${row.original.resolutionAction}`,
                row.original.resolutionAction ?? 'resolved',
              )}
            </StatusBadge>
          ) : (
            <StatusBadge variant="warning" dot>
              {t('prm.wicIssues.status.open', 'Open')}
            </StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: t('prm.wicIssues.col.actions', 'Actions'),
        cell: ({ row }) => {
          if (row.original.resolvedAt) return <span className="text-xs text-muted-foreground">—</span>
          const isLoading = resolvingId === row.original.id
          return (
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => void resolveRow(row.original.id, 'accepted_after_fix')}
              >
                {t('prm.wicIssues.btn.acceptedAfterFix', 'Accept after fix')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => void resolveRow(row.original.id, 'rolled_back')}
              >
                {t('prm.wicIssues.btn.rolledBack', 'Roll back')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => void resolveRow(row.original.id, 'ignored')}
              >
                {t('prm.wicIssues.btn.ignored', 'Ignore')}
              </Button>
            </div>
          )
        },
      },
    ],
    [resolveRow, resolvingId, t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.wicIssues.title', 'WIC Import Issues')}
        description={t(
          'prm.wicIssues.description',
          'Triage queue for WIC import audit-log rejections. Default view shows open issues.',
        )}
      />
      <PageBody>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              {t('prm.wicIssues.filter.resolved.label', 'Status')}
            </label>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={resolved}
              onChange={(e) => {
                setResolved(e.target.value as 'false' | 'true' | 'all')
                setPage(1)
              }}
            >
              {RESOLVED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              {t('prm.wicIssues.filter.reason.label', 'Reason')}
            </label>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value)
                setPage(1)
              }}
            >
              {REJECTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t('prm.wicIssues.error.title', 'Could not load WIC audit log')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DataTable<AuditRow>
          entityId="prm.wic_import_audit_log"
          columns={columns}
          data={items}
          isLoading={loading}
          emptyState={
            <EmptyState
              icon={<CheckCircle2 className="h-6 w-6 text-status-success-icon" aria-hidden />}
              title={t('prm.wicIssues.empty.title', 'No open WIC import issues')}
              description={t(
                'prm.wicIssues.empty.description',
                'The classifier has not flagged anything since the last sweep. New rejections will appear here automatically.',
              )}
            />
          }
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: setPage,
            onPageSizeChange: (size) => {
              setPageSize(size)
              setPage(1)
            },
            pageSizeOptions: [25, 50, 100],
          }}
        />
      </PageBody>
    </Page>
  )
}
