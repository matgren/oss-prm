'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * P7 — Partner Portal Case Studies list (Spec #7 §3.1).
 *
 * Per OQ-010: custom React, no DataTable. Server returns own-Agency rows
 * scoped by tenant + customer-user → AgencyMember.agency_id. Toggle
 * `includeDeleted` in-place to see soft-deleted rows for restore.
 */

type CaseStudyDto = {
  id: string
  title: string
  clientName: string
  clientIndustry: string | null
  mayPublishOnOmWebsite: boolean
  publishedUrl: string | null
  isCurrentlyPublished: boolean
  deletedAt: string | null
  updatedAt: string
}

type ListResponse = {
  ok: true
  items: CaseStudyDto[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export default function PortalCaseStudiesPage() {
  const t = useT()
  const params = useParams<{ orgSlug: string }>()
  const orgSlug = params?.orgSlug ?? ''
  const [items, setItems] = React.useState<CaseStudyDto[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [includeDeleted, setIncludeDeleted] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('page', '1')
      params.set('pageSize', '100')
      params.set('includeDeleted', String(includeDeleted))
      const res = await apiCall<ListResponse>(`/api/prm/portal/case-study?${params.toString()}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.portal.caseStudies.error.loadFailed', 'Could not load case studies.'))
      }
      setItems(res.result.items)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.portal.caseStudies.error.loadFailed', 'Could not load case studies.'),
      )
    } finally {
      setLoading(false)
    }
  }, [includeDeleted, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const softDelete = async (cs: CaseStudyDto) => {
    if (!window.confirm(t('prm.portal.caseStudies.delete.confirm', 'Soft-delete this case study?'))) return
    try {
      const res = await apiCall(`/api/prm/portal/case-study/${cs.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      if (res.status === 409) {
        flash(
          t(
            'prm.portal.caseStudies.delete.guardError',
            'Published case studies cannot be deleted. Ask OM Marketing to unflag first.',
          ),
          'error',
        )
        return
      }
      if (!res.ok) throw new Error('delete failed')
      flash(t('prm.portal.caseStudies.delete.flash', 'Case study deleted.'), 'success')
      void load()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Delete failed.', 'error')
    }
  }

  const restore = async (cs: CaseStudyDto) => {
    try {
      const res = await apiCall(`/api/prm/portal/case-study/${cs.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error('restore failed')
      flash(t('prm.portal.caseStudies.restore.flash', 'Case study restored.'), 'success')
      void load()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Restore failed.', 'error')
    }
  }

  function statusLabel(cs: CaseStudyDto): string {
    if (cs.deletedAt) return t('prm.portal.caseStudies.status.deleted', 'Deleted')
    if (cs.isCurrentlyPublished) return t('prm.portal.caseStudies.status.published', 'Published')
    if (cs.mayPublishOnOmWebsite) return t('prm.portal.caseStudies.status.flagged', 'Approved (no URL)')
    return t('prm.portal.caseStudies.status.draft', 'Draft')
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{t('prm.portal.caseStudies.title', 'Case Studies')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('prm.portal.caseStudies.subtitle', 'Showcase the work your agency has delivered.')}
          </p>
        </div>
        <Link href={`/${orgSlug}/portal/case-studies/new`}>
          <Button>{t('prm.portal.caseStudies.btn.new', 'New case study')}</Button>
        </Link>
      </header>
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          <span>{t('prm.portal.caseStudies.toggle.includeDeleted', 'Include deleted')}</span>
        </label>
      </div>
      {error ? <ErrorMessage label={error} /> : null}
      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : null}
      {!loading && items.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-6 text-sm">
          <h3 className="font-medium">{t('prm.portal.caseStudies.empty.title', 'No case studies yet')}</h3>
          <p className="text-muted-foreground">
            {t(
              'prm.portal.caseStudies.empty.body',
              'Document a recent engagement so it can be attached to RFP responses and (with Marketing\'s approval) appear on openmercato.com.',
            )}
          </p>
        </div>
      ) : null}
      <ul className="space-y-2">
        {items.map((cs) => (
          <li key={cs.id} className="rounded-md border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <Link
                  href={`/${orgSlug}/portal/case-studies/${cs.id}`}
                  className="text-base font-medium underline-offset-4 hover:underline"
                >
                  {cs.title}
                </Link>
                <div className="text-xs text-muted-foreground">{cs.clientName}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded border px-2 py-0.5 text-muted-foreground">{statusLabel(cs)}</span>
                <span className="text-muted-foreground">
                  {new Date(cs.updatedAt).toLocaleDateString()}
                </span>
                {cs.deletedAt ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void restore(cs)}>
                    {t('prm.portal.caseStudies.action.restore', 'Restore')}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => void softDelete(cs)}>
                    {t('prm.portal.caseStudies.action.delete', 'Delete')}
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
