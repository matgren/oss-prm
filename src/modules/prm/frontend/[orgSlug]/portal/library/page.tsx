'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * P11 — Partner Portal Marketing Library (Spec #7 §3.4 / US7.2).
 *
 * Per OQ-010: custom React, no DataTable. Server applies tier gate +
 * publish/unpublish state filter; the client only renders + facets.
 * Tier-gated below the viewer's tier never appears in the response.
 */

type LibraryItem = {
  id: string
  title: string
  description: string | null
  materialType: string
  topics: string[]
  audiences: string[]
  primaryAttachmentDownloadPath: string
  publishedAt: string
}

type LibraryFacets = {
  material_types: { value: string; count: number }[]
  topics: { value: string; count: number }[]
  audiences: { value: string; count: number }[]
}

type ListResponse = {
  ok: true
  items: LibraryItem[]
  facets: LibraryFacets
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const PAGE_SIZE = 24

export default function PortalLibraryPage() {
  const t = useT()
  const [items, setItems] = React.useState<LibraryItem[]>([])
  const [facets, setFacets] = React.useState<LibraryFacets>({
    material_types: [],
    topics: [],
    audiences: [],
  })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [materialType, setMaterialType] = React.useState('')
  const [topics, setTopics] = React.useState<string[]>([])
  const [audiences, setAudiences] = React.useState<string[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    if (materialType) params.set('materialType', materialType)
    for (const t of topics) params.append('topics', t)
    for (const a of audiences) params.append('audiences', a)
    try {
      const res = await apiCall<ListResponse>(`/api/prm/portal/library?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.portal.library.error.loadFailed', 'Could not load the library.'))
      }
      setItems(res.result.items)
      setFacets(res.result.facets)
      setTotal(res.result.total)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.portal.library.error.loadFailed', 'Could not load the library.'),
      )
    } finally {
      setLoading(false)
    }
  }, [page, materialType, topics, audiences, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const toggleTopic = (slug: string) => {
    setTopics((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))
    setPage(1)
  }

  const toggleAudience = (slug: string) => {
    setAudiences((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    )
    setPage(1)
  }

  const handleDownload = async (item: LibraryItem) => {
    try {
      const res = await apiCall<{ ok: true; download: { url: string } }>(
        item.primaryAttachmentDownloadPath,
      )
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.portal.library.unavailable', 'Download is no longer available.'))
      }
      const url = res.result.download.url
      if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.portal.library.unavailable', 'Download is no longer available.'),
      )
    }
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('prm.portal.library.title', 'Marketing Library')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('prm.portal.library.subtitle', 'Playbooks, sales decks, and templates curated for your tier.')}
        </p>
      </header>
      {error ? <ErrorMessage label={error} /> : null}

      <section className="grid gap-3 md:grid-cols-[18rem_1fr]">
        <aside className="space-y-4 rounded-md border p-3 text-sm">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('prm.portal.library.filter.materialType', 'Type')}
            </h2>
            <div className="mt-1 flex flex-col gap-1">
              <button
                type="button"
                className={`text-left underline-offset-2 hover:underline ${materialType === '' ? 'font-medium' : 'text-muted-foreground'}`}
                onClick={() => {
                  setMaterialType('')
                  setPage(1)
                }}
              >
                {t('prm.portal.library.filter.all', 'All')}
              </button>
              {facets.material_types.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={`text-left underline-offset-2 hover:underline ${materialType === f.value ? 'font-medium' : 'text-muted-foreground'}`}
                  onClick={() => {
                    setMaterialType(f.value)
                    setPage(1)
                  }}
                >
                  {f.value} ({f.count})
                </button>
              ))}
            </div>
          </div>
          {facets.topics.length ? (
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('prm.portal.library.filter.topic', 'Topic')}
              </h2>
              <div className="mt-1 flex flex-col gap-1">
                {facets.topics.map((f) => (
                  <label key={f.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={topics.includes(f.value)}
                      onChange={() => toggleTopic(f.value)}
                    />
                    <span>
                      {f.value} ({f.count})
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {facets.audiences.length ? (
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('prm.portal.library.filter.audience', 'Audience')}
              </h2>
              <div className="mt-1 flex flex-col gap-1">
                {facets.audiences.map((f) => (
                  <label key={f.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={audiences.includes(f.value)}
                      onChange={() => toggleAudience(f.value)}
                    />
                    <span>
                      {f.value} ({f.count})
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </aside>

        <div className="space-y-3">
          {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : null}
          {!loading && items.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-6 text-sm">
              <h3 className="font-medium">
                {t('prm.portal.library.empty.title', 'Nothing here yet')}
              </h3>
              <p className="text-muted-foreground">
                {t(
                  'prm.portal.library.empty.body',
                  'Marketing publishes new resources regularly. Check back soon.',
                )}
              </p>
            </div>
          ) : null}
          <ul className="grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border p-4">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {item.materialType}
                </div>
                <h3 className="text-base font-medium">{item.title}</h3>
                {item.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                ) : null}
                {item.topics.length ? (
                  <div className="mt-2 flex flex-wrap gap-1 text-xs text-muted-foreground">
                    {item.topics.map((slug) => (
                      <span key={slug} className="rounded border px-1.5 py-0.5">
                        {slug}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.publishedAt).toLocaleDateString()}
                  </span>
                  <Button type="button" size="sm" onClick={() => void handleDownload(item)}>
                    {t('prm.portal.library.action.download', 'Download')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {total > PAGE_SIZE ? (
            <div className="flex items-center justify-end gap-2 text-xs">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </Button>
              <span>
                Page {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= Math.ceil(total / PAGE_SIZE)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
