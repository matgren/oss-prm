'use client'
import * as React from 'react'
import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type RfpRow = {
  id: string
  title: string
  receivedFrom: string
  receivedAt: string
  industry: string | null
  budgetBucket: string | null
  timelineBucket: string | null
  status: string
  eligibilityFilter: string
  selectedAgencyId: string | null
  isPathBLocked: boolean
  publishedAt: string | null
  closedAt: string | null
  deadlineToRespond: string | null
  createdAt: string
  updatedAt: string
}

type ListResponse = {
  ok: true
  items: RfpRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const STATUS_OPTIONS = [
  { value: '', labelKey: 'prm.rfp.filter.status.all', label: 'All statuses' },
  { value: 'draft', labelKey: 'prm.rfp.status.draft', label: 'Draft' },
  { value: 'published', labelKey: 'prm.rfp.status.published', label: 'Published' },
  { value: 'scoring', labelKey: 'prm.rfp.status.scoring', label: 'Scoring' },
  { value: 'selection_made', labelKey: 'prm.rfp.status.selection_made', label: 'Selection made' },
  { value: 'closed', labelKey: 'prm.rfp.status.closed', label: 'Closed' },
  { value: 'reopened', labelKey: 'prm.rfp.status.reopened', label: 'Reopened' },
] as const

/**
 * B6 — RFPs cross-tenant list (Spec #5 §3.1).
 *
 * OM PartnerOps view. Row click opens detail with publish / unpublish / close
 * / reopen actions. Filtered by status; searchable on title.
 */
export default function RfpsBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<RfpRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [status, setStatus] = React.useState('')
  const [q, setQ] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (status) params.set('status', status)
      if (q.trim()) params.set('q', q.trim())
      const res = await apiCall<ListResponse>(`/api/prm/rfp?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.rfp.error.loadList', 'Failed to load RFPs'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('prm.rfp.error.loadList', 'Failed to load RFPs'),
      )
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, q, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<RfpRow>[]>(
    () => [
      {
        id: 'title',
        header: t('prm.rfp.col.title', 'Title'),
        accessorKey: 'title',
        cell: ({ row }) => (
          <Link
            href={`/backend/prm/rfp/${row.original.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        id: 'receivedFrom',
        header: t('prm.rfp.col.receivedFrom', 'From'),
        accessorKey: 'receivedFrom',
        cell: ({ row }) => row.original.receivedFrom,
      },
      {
        id: 'status',
        header: t('prm.rfp.col.status', 'Status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="rounded-full border px-2 py-0.5 text-xs">{row.original.status}</span>
        ),
      },
      {
        id: 'eligibilityFilter',
        header: t('prm.rfp.col.eligibility', 'Eligibility'),
        accessorKey: 'eligibilityFilter',
        cell: ({ row }) => (
          <span className="rounded-full border px-2 py-0.5 text-xs">
            {row.original.eligibilityFilter}
          </span>
        ),
      },
      {
        id: 'deadlineToRespond',
        header: t('prm.rfp.col.deadline', 'Deadline'),
        cell: ({ row }) =>
          row.original.deadlineToRespond
            ? new Date(row.original.deadlineToRespond).toLocaleDateString()
            : '—',
      },
      {
        id: 'publishedAt',
        header: t('prm.rfp.col.publishedAt', 'Published'),
        cell: ({ row }) =>
          row.original.publishedAt ? new Date(row.original.publishedAt).toLocaleDateString() : '—',
      },
      {
        id: 'createdAt',
        header: t('prm.rfp.col.createdAt', 'Created'),
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.rfp.title', 'RFPs')}
        description={t(
          'prm.rfp.description',
          'Author, publish, and track RFPs broadcast to partner agencies.',
        )}
        actions={
          <Link href="/backend/prm/rfp/new">
            <Button>{t('prm.rfp.create', 'New RFP')}</Button>
          </Link>
        }
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.rfp.filter.status', 'Status')}
            </span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.rfp.filter.q', 'Search (title)')}
            </span>
            <Input
              type="search"
              className="h-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('prm.rfp.filter.apply', 'Apply')}
          </Button>
        </div>

        <DataTable<RfpRow>
          entityId="prm.rfp"
          columns={columns}
          data={items}
          isLoading={loading}
          error={error}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: (next) => setPage(next),
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
