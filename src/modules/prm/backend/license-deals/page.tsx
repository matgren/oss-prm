'use client'
import * as React from 'react'
import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type LicenseDealRow = {
  id: string
  licenseIdentifier: string
  clientCompanyName: string
  clientIndustry: string | null
  status: string
  attributionPath: string
  attributionSource: string
  attributedAgencyId: string | null
  isRenewal: boolean
  signedAt: string | null
  closedAt: string | null
  attributedAt: string | null
  createdAt: string
}

type ListResponse = {
  ok: true
  items: LicenseDealRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const STATUS_OPTIONS = [
  { value: '', labelKey: 'prm.licenseDeals.filter.status.all', label: 'All statuses' },
  { value: 'pending', labelKey: 'prm.licenseDeals.status.pending', label: 'Pending' },
  { value: 'signed', labelKey: 'prm.licenseDeals.status.signed', label: 'Signed' },
  { value: 'active', labelKey: 'prm.licenseDeals.status.active', label: 'Active' },
  { value: 'churned', labelKey: 'prm.licenseDeals.status.churned', label: 'Churned' },
] as const

const PATH_OPTIONS = [
  { value: '', labelKey: 'prm.licenseDeals.filter.path.all', label: 'All paths' },
  { value: 'A', labelKey: 'prm.licenseDeals.path.A', label: 'Path A — Prospect' },
  { value: 'B', labelKey: 'prm.licenseDeals.path.B', label: 'Path B — RFP' },
  { value: 'C', labelKey: 'prm.licenseDeals.path.C', label: 'Path C — Direct' },
  { value: 'none', labelKey: 'prm.licenseDeals.path.none', label: 'Unattributed' },
] as const

/**
 * B5 — LicenseDeals cross-tenant list (Spec #3 §3.1).
 *
 * OM PartnerOps view. Row click opens detail with the attribution picker.
 */
export default function LicenseDealsBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<LicenseDealRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [status, setStatus] = React.useState('')
  const [pathFilter, setPathFilter] = React.useState('')
  const [q, setQ] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (status) params.set('status', status)
      if (pathFilter) params.set('attributionPath', pathFilter)
      if (q.trim()) params.set('q', q.trim())
      const res = await apiCall<ListResponse>(`/api/prm/license-deal?${params.toString()}`)
      if (!res.ok || !res.result?.ok) throw new Error('Failed to load license deals')
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load license deals')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, pathFilter, q])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<LicenseDealRow>[]>(
    () => [
      {
        id: 'licenseIdentifier',
        header: t('prm.licenseDeals.col.identifier', 'Identifier'),
        accessorKey: 'licenseIdentifier',
        cell: ({ row }) => (
          <Link
            href={`/backend/prm/license-deals/${row.original.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.original.licenseIdentifier}
          </Link>
        ),
      },
      {
        id: 'clientCompanyName',
        header: t('prm.licenseDeals.col.client', 'Client'),
        cell: ({ row }) => (
          <div className="flex flex-col text-sm">
            <span>{row.original.clientCompanyName}</span>
            {row.original.clientIndustry ? (
              <span className="text-xs text-muted-foreground">{row.original.clientIndustry}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: t('prm.licenseDeals.col.status', 'Status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="rounded-full border px-2 py-0.5 text-xs">{row.original.status}</span>
        ),
      },
      {
        id: 'attributionPath',
        header: t('prm.licenseDeals.col.path', 'Path'),
        accessorKey: 'attributionPath',
        cell: ({ row }) => (
          <span className="rounded-full border px-2 py-0.5 text-xs">
            {row.original.attributionPath === 'none' ? '—' : `Path ${row.original.attributionPath}`}
          </span>
        ),
      },
      {
        id: 'isRenewal',
        header: t('prm.licenseDeals.col.renewal', 'Renewal'),
        cell: ({ row }) => (row.original.isRenewal ? 'Yes' : 'No'),
      },
      {
        id: 'signedAt',
        header: t('prm.licenseDeals.col.signedAt', 'Signed'),
        cell: ({ row }) =>
          row.original.signedAt ? new Date(row.original.signedAt).toLocaleDateString() : '—',
      },
      {
        id: 'createdAt',
        header: t('prm.licenseDeals.col.createdAt', 'Created'),
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.licenseDeals.title', 'License Deals')}
        description={t(
          'prm.licenseDeals.description',
          'Attribution decisions and license deal lifecycle. OM PartnerOps only.',
        )}
        actions={
          <Link href="/backend/prm/license-deals/new">
            <Button>{t('prm.licenseDeals.create', 'New license deal')}</Button>
          </Link>
        }
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.licenseDeals.filter.status', 'Status')}
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.licenseDeals.filter.path', 'Attribution path')}
            </span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={pathFilter}
              onChange={(e) => {
                setPathFilter(e.target.value)
                setPage(1)
              }}
            >
              {PATH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.licenseDeals.filter.q', 'Search (identifier or client)')}
            </span>
            <input
              type="search"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
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
            {t('prm.licenseDeals.filter.apply', 'Apply')}
          </Button>
        </div>

        <DataTable<LicenseDealRow>
          entityId="prm.license_deal"
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
