'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { resolveDynamicId } from '../../../../lib/dynamicParams'

type CaseStudyDto = {
  id: string
  agencyId: string
  title: string
  clientName: string
  clientIndustry: string | null
  clientCountry: string | null
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
  heroImageAttachmentId: string | null
  galleryAttachmentIds: string[]
  mayPublishOnOmWebsite: boolean
  publishedUrl: string | null
  isCurrentlyPublished: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/**
 * B8 — Case Study detail (read + publication-flag toggle).
 *
 * The portal authoring flow lives at `/portal/case-studies/[id]`. Backend
 * detail is intentionally read-only-ish: only the publication flag +
 * URL are mutable here.
 */
export default function CaseStudyBackendDetailPage() {
  const t = useT()
  const params = useParams() as Record<string, unknown> | null
  const id = resolveDynamicId(params)
  const [data, setData] = React.useState<CaseStudyDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [savingFlag, setSavingFlag] = React.useState(false)
  const [pendingUrl, setPendingUrl] = React.useState('')

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ ok: true; caseStudy: CaseStudyDto }>(`/api/prm/case-study/${id}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.backend.caseStudies.error.loadFailed', 'Could not load.'))
      }
      setData(res.result.caseStudy)
      setPendingUrl(res.result.caseStudy.publishedUrl ?? '')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.backend.caseStudies.error.loadFailed', 'Could not load.'),
      )
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const saveFlag = React.useCallback(
    async (mayPublish: boolean, urlInput: string | null) => {
      if (!data) return
      setSavingFlag(true)
      try {
        const trimmedUrl = urlInput && urlInput.trim().length > 0 ? urlInput.trim() : null
        await apiCallOrThrow(`/api/prm/case-study/${data.id}/publication-flag`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mayPublishOnOmWebsite: mayPublish,
            publishedUrl: mayPublish ? trimmedUrl : null,
          }),
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
      } finally {
        setSavingFlag(false)
      }
    },
    [data, load, t],
  )

  if (loading) return <LoadingMessage label={t('common.loading', 'Loading…')} />
  if (error) return <ErrorMessage label={error} />
  if (!data) return null

  const statusLabel = data.deletedAt
    ? t('prm.portal.caseStudies.status.deleted', 'Deleted')
    : data.isCurrentlyPublished
      ? t('prm.portal.caseStudies.status.published', 'Published')
      : data.mayPublishOnOmWebsite
        ? t('prm.portal.caseStudies.status.flagged', 'Approved (no URL)')
        : t('prm.portal.caseStudies.status.draft', 'Draft')

  return (
    <Page>
      <PageHeader
        title={data.title}
        description={`${t('prm.backend.caseStudies.col.client', 'Client')}: ${data.clientName} · ${statusLabel}`}
      />
      <PageBody>
        <section className="space-y-3 rounded-md border p-4">
          <h2 className="text-base font-medium">
            {t('prm.backend.caseStudies.col.flag', 'May publish')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={data.mayPublishOnOmWebsite ? 'default' : 'outline'}
              disabled={savingFlag}
              onClick={() => void saveFlag(true, pendingUrl || null)}
            >
              On
            </Button>
            <Button
              type="button"
              variant={!data.mayPublishOnOmWebsite ? 'default' : 'outline'}
              disabled={savingFlag}
              onClick={() => void saveFlag(false, null)}
            >
              Off
            </Button>
            <Input
              type="url"
              placeholder="https://openmercato.com/cs/..."
              value={pendingUrl}
              onChange={(e) => setPendingUrl(e.target.value)}
              className="h-9 max-w-md"
            />
            <Button
              type="button"
              variant="outline"
              disabled={savingFlag || !data.mayPublishOnOmWebsite}
              onClick={() => void saveFlag(true, pendingUrl || null)}
            >
              Save URL
            </Button>
          </div>
        </section>
        <section className="space-y-3 rounded-md border p-4">
          <h2 className="text-base font-medium">{t('prm.portal.caseStudies.form.challenge', 'Challenge')}</h2>
          <pre className="whitespace-pre-wrap font-mono text-xs">{data.challengeMarkdown}</pre>
        </section>
        <section className="space-y-3 rounded-md border p-4">
          <h2 className="text-base font-medium">{t('prm.portal.caseStudies.form.approach', 'Approach')}</h2>
          <pre className="whitespace-pre-wrap font-mono text-xs">{data.approachMarkdown}</pre>
        </section>
        <section className="space-y-3 rounded-md border p-4">
          <h2 className="text-base font-medium">{t('prm.portal.caseStudies.form.outcome', 'Outcome')}</h2>
          <pre className="whitespace-pre-wrap font-mono text-xs">{data.outcomeMarkdown}</pre>
        </section>
        <div>
          <Link href="/backend/prm/case-studies" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← Back to list
          </Link>
        </div>
      </PageBody>
    </Page>
  )
}
