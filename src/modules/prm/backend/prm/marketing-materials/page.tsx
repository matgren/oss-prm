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
import { flash } from '@open-mercato/ui/backend/FlashMessages'

type MaterialRow = {
  id: string
  title: string
  materialType: string
  visibility: string
  minTier: string | null
  publishedAt: string | null
  unpublishedAt: string | null
  isCurrentlyPublished: boolean
  createdAt: string
}

type ListResponse = {
  ok: true
  items: MaterialRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'playbook', label: 'Playbook' },
  { value: 'sales_deck', label: 'Sales deck' },
  { value: 'video', label: 'Video' },
  { value: 'guide', label: 'Guide' },
  { value: 'case_study_template', label: 'Case study template' },
  { value: 'other', label: 'Other' },
] as const

const VISIBILITY_OPTIONS = [
  { value: '', label: 'All visibilities' },
  { value: 'all_partners', label: 'All partners' },
  { value: 'tier_gated', label: 'Tier-gated' },
] as const

const PUBLISH_OPTIONS = [
  { value: '', label: 'Any state' },
  { value: 'true', label: 'Published' },
  { value: 'false', label: 'Draft / unpublished' },
] as const

/**
 * B9 — Marketing Materials list (Spec #7 §3.3 / US7.1).
 *
 * OM Marketing view. Inline publish / unpublish action; row click opens
 * the edit form. Assumes `prm.marketing_material.read` for read access;
 * publish/unpublish is gated separately by `prm.marketing_material.publish`.
 */
export default function MarketingMaterialsBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<MaterialRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [type, setType] = React.useState('')
  const [visibility, setVisibility] = React.useState('')
  const [isPublished, setIsPublished] = React.useState('')
  const [q, setQ] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (type) params.set('materialType', type)
      if (visibility) params.set('visibility', visibility)
      if (isPublished) params.set('isPublished', isPublished)
      if (q.trim()) params.set('q', q.trim())
      const res = await apiCall<ListResponse>(`/api/prm/marketing-material?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.backend.marketingMaterials.error.loadFailed', 'Could not load marketing materials.'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.backend.marketingMaterials.error.loadFailed', 'Could not load marketing materials.'),
      )
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, type, visibility, isPublished, q, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const togglePublish = React.useCallback(
    async (row: MaterialRow) => {
      const action = row.isCurrentlyPublished ? 'unpublish' : 'publish'
      const flashKey = action === 'publish' ? 'flash.published' : 'flash.unpublished'
      try {
        const res = await apiCall<{ ok: true }>(
          `/api/prm/marketing-material/${row.id}/${action}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        )
        if (!res.ok || !res.result?.ok) {
          throw new Error(t(`prm.backend.marketingMaterials.flash.publishError`, 'Could not change publish state.'))
        }
        flash(t(`prm.backend.marketingMaterials.${flashKey}` as any, action), 'success')
        void load()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('prm.backend.marketingMaterials.flash.publishError', 'Could not change publish state.'),
          'error',
        )
      }
    },
    [load, t],
  )

  const columns = React.useMemo<ColumnDef<MaterialRow>[]>(
    () => [
      {
        id: 'title',
        header: t('prm.backend.marketingMaterials.col.title', 'Title'),
        accessorKey: 'title',
        cell: ({ row }) => (
          <Link
            href={`/backend/prm/marketing-materials/${row.original.id}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        id: 'materialType',
        header: t('prm.backend.marketingMaterials.col.type', 'Type'),
        accessorKey: 'materialType',
      },
      {
        id: 'visibility',
        header: t('prm.backend.marketingMaterials.col.visibility', 'Visibility'),
        accessorKey: 'visibility',
      },
      {
        id: 'minTier',
        header: t('prm.backend.marketingMaterials.col.tier', 'Min tier'),
        accessorKey: 'minTier',
        cell: ({ row }) => row.original.minTier ?? '—',
      },
      {
        id: 'status',
        header: t('prm.backend.marketingMaterials.col.status', 'Status'),
        cell: ({ row }) => (row.original.isCurrentlyPublished ? 'Published' : 'Draft'),
      },
      {
        id: 'publishedAt',
        header: t('prm.backend.marketingMaterials.col.published', 'Published'),
        accessorKey: 'publishedAt',
        cell: ({ row }) =>
          row.original.publishedAt ? new Date(row.original.publishedAt).toLocaleString() : '—',
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              void togglePublish(row.original)
            }}
          >
            {row.original.isCurrentlyPublished
              ? t('prm.backend.marketingMaterials.action.unpublish', 'Unpublish')
              : t('prm.backend.marketingMaterials.action.publish', 'Publish')}
          </Button>
        ),
      },
    ],
    [togglePublish, t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.backend.marketingMaterials.title', 'Marketing Materials')}
        description={t(
          'prm.backend.marketingMaterials.subtitle',
          'Manage downloadable assets shared with the partner network.',
        )}
        actions={
          <Link href="/backend/prm/marketing-materials/new">
            <Button>{t('prm.backend.marketingMaterials.btn.new', 'New material')}</Button>
          </Link>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <Input
            placeholder={t('common.search', 'Search title…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 max-w-xs"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={isPublished}
            onChange={(e) => setIsPublished(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {PUBLISH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {error ? <div className="rounded-md border bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <DataTable
          columns={columns}
          data={items}
          isLoading={loading}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: setPage,
          }}
        />
      </PageBody>
    </Page>
  )
}
