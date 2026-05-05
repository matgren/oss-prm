'use client'
import * as React from 'react'
import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

type AgencySummary = {
  id: string
  name: string
  slug: string
  tier: string
  status: string
  headquartersCountry: string
  contractSigned: boolean
  ndaSigned: boolean
  onboarded: boolean
  createdAt: string
}

type ListResponse = {
  ok: true
  items: AgencySummary[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const TIER_OPTIONS = [
  { value: '', label: 'All tiers' },
  { value: 'om_agency', label: 'OM Agency' },
  { value: 'ai_native', label: 'AI Native' },
  { value: 'ai_native_expert', label: 'AI Native Expert' },
  { value: 'ai_native_core', label: 'AI Native Core' },
] as const

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'historical', label: 'Historical' },
] as const

export default function AgenciesListPage() {
  const t = useT()
  const [items, setItems] = React.useState<AgencySummary[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [tier, setTier] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [q, setQ] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (tier) params.set('tier', tier)
      if (status) params.set('status', status)
      if (q.trim()) params.set('q', q.trim())
      const res = await apiCall<ListResponse>(`/api/prm/agency?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error('Failed to load agencies')
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agencies')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, q, status, tier])

  React.useEffect(() => {
    void load()
  }, [load])

  const columns = React.useMemo<ColumnDef<AgencySummary>[]>(
    () => [
      {
        id: 'name',
        header: t('prm.agencies.col.name', 'Name'),
        accessorKey: 'name',
        cell: ({ row }) => (
          <Link className="font-medium text-foreground underline-offset-2 hover:underline" href={`/backend/prm/${row.original.id}`}>
            {row.original.name}
          </Link>
        ),
      },
      { id: 'slug', header: t('prm.agencies.col.slug', 'Slug'), accessorKey: 'slug' },
      { id: 'tier', header: t('prm.agencies.col.tier', 'Tier'), accessorKey: 'tier' },
      { id: 'status', header: t('prm.agencies.col.status', 'Status'), accessorKey: 'status' },
      { id: 'headquartersCountry', header: t('prm.agencies.col.country', 'Country'), accessorKey: 'headquartersCountry' },
      {
        id: 'onboarding',
        header: t('prm.agencies.col.onboarding', 'Onboarding'),
        cell: ({ row }) => {
          const a = row.original
          return (
            <span className="text-xs text-muted-foreground">
              {a.contractSigned ? 'C' : '·'} / {a.ndaSigned ? 'N' : '·'} / {a.onboarded ? 'O' : '·'}
            </span>
          )
        },
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.agencies.title', 'Agencies')}
        description={t('prm.agencies.description', 'Partner agencies enrolled on the platform.')}
        actions={
          <Button asChild type="button">
            <Link href="/backend/prm/new">{t('prm.agencies.create', 'Create agency')}</Link>
          </Button>
        }
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.agencies.filter.tier', 'Tier')}</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={tier}
              onChange={(e) => {
                setTier(e.target.value)
                setPage(1)
              }}
            >
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.agencies.filter.status', 'Status')}</span>
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
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('prm.agencies.filter.q', 'Search')}</span>
            <input
              type="search"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              placeholder="Search by name"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void load()
                }
              }}
            />
          </label>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('prm.agencies.filter.apply', 'Apply')}
          </Button>
        </div>

        <DataTable<AgencySummary>
          entityId="prm.agency"
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

// Page metadata lives in `page.meta.ts` (Next.js disallows `export const metadata`
// from `'use client'` components). Keep the metadata declaration server-side only.
