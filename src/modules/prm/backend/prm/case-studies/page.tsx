'use client'
import * as React from 'react'
import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

type CaseStudyRow = {
  id: string
  agencyId: string
  title: string
  clientName: string
  mayPublishOnOmWebsite: boolean
  publishedUrl: string | null
  isCurrentlyPublished: boolean
  deletedAt: string | null
  updatedAt: string
}

type ListResponse = {
  ok: true
  items: CaseStudyRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const PUBLISH_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'true', label: 'May publish' },
  { value: 'false', label: 'Cannot publish' },
] as const

const STATE_OPTIONS = [
  { value: '', label: 'Any state' },
  { value: 'true', label: 'Currently published' },
  { value: 'false', label: 'Not yet published' },
] as const

const DELETED_OPTIONS = [
  { value: 'true', label: 'Include deleted' },
  { value: 'false', label: 'Exclude deleted' },
] as const

/**
 * B8 — Case Studies cross-Agency review queue (Spec #7 §3.2 / US2.4).
 *
 * OM Marketing toggles `may_publish_on_om_website` + `published_url` here
 * to flip a Case Study live on the public OM website (invariant #8).
 * Defaults to `include_deleted = true` so reconciliation is visible.
 */
export default function CaseStudiesBackendPage() {
  const t = useT()
  const [items, setItems] = React.useState<CaseStudyRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(50)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [mayPublish, setMayPublish] = React.useState('')
  const [isPublished, setIsPublished] = React.useState('')
  const [includeDeleted, setIncludeDeleted] = React.useState('true')
  const [q, setQ] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (mayPublish) params.set('mayPublish', mayPublish)
      if (isPublished) params.set('isPublished', isPublished)
      if (includeDeleted) params.set('includeDeleted', includeDeleted)
      if (q.trim()) params.set('q', q.trim())
      const res = await apiCall<ListResponse>(`/api/prm/case-study?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.backend.caseStudies.error.loadFailed', 'Could not load case studies.'))
      }
      setItems(res.result.items)
      setTotal(res.result.total)
      setTotalPages(res.result.totalPages)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.backend.caseStudies.error.loadFailed', 'Could not load case studies.'),
      )
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, mayPublish, isPublished, includeDeleted, q, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const togglePublishFlag = React.useCallback(
    async (row: CaseStudyRow) => {
      const nextFlag = !row.mayPublishOnOmWebsite
      let nextUrl = row.publishedUrl
      if (nextFlag && !nextUrl) {
        // Optionally collect a URL on first flip-on. Empty stays legal
        // (flag = true + url = null) per refine.
        const promptResult = window.prompt(
          t('prm.backend.caseStudies.urlPrompt', 'Public URL (leave blank to clear)'),
          '',
        )
        nextUrl = promptResult ? promptResult.trim() : null
        if (nextUrl === '') nextUrl = null
      }
      if (!nextFlag) {
        // Clearing the flag also clears the URL (refine: url cannot be set with flag=false).
        nextUrl = null
      }
      try {
        await apiCallOrThrow(`/api/prm/case-study/${row.id}/publication-flag`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mayPublishOnOmWebsite: nextFlag, publishedUrl: nextUrl }),
        })
        flash(t('prm.backend.caseStudies.flash.flagSaved', 'Publication flag updated.'), 'success')
        void load()
      } catch (err) {
        flash(
          err instanceof Error
            ? err.message
            : t('prm.backend.caseStudies.flash.flagError', 'Could not update publication flag.'),
          'error',
        )
      }
    },
    [load, t],
  )

  const columns = React.useMemo<ColumnDef<CaseStudyRow>[]>(
    () => [
      {
        id: 'title',
        header: t('prm.backend.caseStudies.col.title', 'Title'),
        accessorKey: 'title',
        cell: ({ row }) => (
          <Link
            href={`/backend/prm/case-studies/${row.original.id}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        id: 'clientName',
        header: t('prm.backend.caseStudies.col.client', 'Client'),
        accessorKey: 'clientName',
      },
      {
        id: 'agencyId',
        header: t('prm.backend.caseStudies.col.agency', 'Agency'),
        accessorKey: 'agencyId',
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.agencyId}</span>,
      },
      {
        id: 'mayPublishOnOmWebsite',
        header: t('prm.backend.caseStudies.col.flag', 'May publish'),
        cell: ({ row }) => (
          <Button variant="outline" size="sm" onClick={() => void togglePublishFlag(row.original)}>
            {row.original.mayPublishOnOmWebsite ? 'On' : 'Off'}
          </Button>
        ),
      },
      {
        id: 'publishedUrl',
        header: t('prm.backend.caseStudies.col.url', 'Public URL'),
        cell: ({ row }) =>
          row.original.publishedUrl ? (
            <a
              href={row.original.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {row.original.publishedUrl}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('prm.backend.caseStudies.col.status', 'Status'),
        cell: ({ row }) => {
          if (row.original.deletedAt) return 'Deleted'
          if (row.original.isCurrentlyPublished) return 'Published'
          if (row.original.mayPublishOnOmWebsite) return 'Approved (no URL)'
          return 'Draft'
        },
      },
      {
        id: 'updatedAt',
        header: t('prm.backend.caseStudies.col.updated', 'Updated'),
        accessorKey: 'updatedAt',
        cell: ({ row }) => new Date(row.original.updatedAt).toLocaleString(),
      },
    ],
    [togglePublishFlag, t],
  )

  return (
    <Page>
      <PageHeader
        title={t('prm.backend.caseStudies.title', 'Case Studies')}
        description={t(
          'prm.backend.caseStudies.subtitle',
          'Cross-Agency review queue. Toggle the publish flag once a Case Study is ready for openmercato.com.',
        )}
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
            value={mayPublish}
            onChange={(e) => setMayPublish(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {PUBLISH_OPTIONS.map((o) => (
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
            {STATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {DELETED_OPTIONS.map((o) => (
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
