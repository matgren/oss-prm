'use client'
import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type ProspectRow = {
  id: string
  agencyId: string
  agencyName: string | null
  companyName: string
  contactName: string
  contactEmail: string
  source: string
  status: string
  registeredAt: string
  statusChangedAt: string
  lostReason: string | null
  registeredByAgencyMemberId: string
}

type ListResponse = {
  ok: true
  items: ProspectRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const STATUS_OPTIONS = [
  { value: '', labelKey: 'prm.prospects.filter.status.all', label: 'All statuses' },
  { value: 'new', labelKey: 'prm.prospects.status.new', label: 'New' },
  { value: 'qualified', labelKey: 'prm.prospects.status.qualified', label: 'Qualified' },
  { value: 'contacted', labelKey: 'prm.prospects.status.contacted', label: 'Contacted' },
  { value: 'won', labelKey: 'prm.prospects.status.won', label: 'Won' },
  { value: 'lost', labelKey: 'prm.prospects.status.lost', label: 'Lost' },
  { value: 'dormant', labelKey: 'prm.prospects.status.dormant', label: 'Dormant' },
] as const

/**
 * B4 — Cross-agency Prospect read-only list (Spec #2 §3.2).
 *
 * OM PartnerOps view, read-only. No row actions, no inline edits — all writes go
 * through the portal's P5/P6 surfaces.
 */
export default function ProspectsBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<ProspectRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [status, setStatus] = React.useState('')
  const [companyQuery, setCompanyQuery] = React.useState('')
  const [emailQuery, setEmailQuery] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (status) params.set('status', status)
      if (companyQuery.trim()) params.set('normalizedCompanyName', companyQuery.trim())
      if (emailQuery.trim()) params.set('lowercasedContactEmail', emailQuery.trim())
      const res = await apiCall<ListResponse>(`/api/prm/prospects?${params.toString()}`)
      if (!res.ok || !res.result?.ok) throw new Error('Failed to load prospects')
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prospects')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, companyQuery, emailQuery])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<ProspectRow>[]>(
    () => [
      {
        id: 'companyName',
        header: t('prm.prospects.col.company', 'Company'),
        accessorKey: 'companyName',
        cell: ({ row }) => <span className="font-medium">{row.original.companyName}</span>,
      },
      {
        id: 'contact',
        header: t('prm.prospects.col.contact', 'Contact'),
        cell: ({ row }) => (
          <div className="flex flex-col text-sm">
            <span>{row.original.contactName}</span>
            <span className="text-xs text-muted-foreground">{row.original.contactEmail}</span>
          </div>
        ),
      },
      {
        id: 'agency',
        header: t('prm.prospects.col.agency', 'Agency'),
        accessorKey: 'agencyName',
        cell: ({ row }) => row.original.agencyName ?? '—',
      },
      {
        id: 'status',
        header: t('prm.prospects.col.status', 'Status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="rounded-full border px-2 py-0.5 text-xs">
            {row.original.status}
          </span>
        ),
      },
      {
        id: 'source',
        header: t('prm.prospects.col.source', 'Source'),
        accessorKey: 'source',
      },
      {
        id: 'registeredAt',
        header: t('prm.prospects.col.registeredAt', 'Registered'),
        cell: ({ row }) => new Date(row.original.registeredAt).toLocaleDateString(),
      },
      {
        id: 'statusChangedAt',
        header: t('prm.prospects.col.statusChangedAt', 'Last activity'),
        cell: ({ row }) => new Date(row.original.statusChangedAt).toLocaleDateString(),
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.prospects.title', 'Prospects')}
        description={t(
          'prm.prospects.description',
          'Cross-agency, read-only — all Prospect writes happen in the partner portal.',
        )}
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.prospects.filter.status', 'Status')}
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
              {t('prm.prospects.filter.company', 'Company name (normalized)')}
            </span>
            <input
              type="search"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={companyQuery}
              onChange={(e) => setCompanyQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.prospects.filter.email', 'Contact email')}
            </span>
            <input
              type="search"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={emailQuery}
              onChange={(e) => setEmailQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('prm.prospects.filter.apply', 'Apply')}
          </Button>
        </div>

        <DataTable<ProspectRow>
          entityId="prm.prospect"
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
