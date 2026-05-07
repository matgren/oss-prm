'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import {
  CaseStudyForm,
  caseStudyDtoToFormValues,
} from '../caseStudyForm'

type CaseStudyDto = {
  id: string
  title: string
  clientName: string
  clientIndustry: string | null
  clientCountry: string | null
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
  mayPublishOnOmWebsite: boolean
  publishedUrl: string | null
  isCurrentlyPublished: boolean
  deletedAt: string | null
  updatedAt: string
}

export default function PortalCaseStudyDetailPage() {
  const t = useT()
  const params = useParams<{ orgSlug: string; id: string }>()
  const id = params?.id
  const orgSlug = params?.orgSlug ?? ''
  const [data, setData] = React.useState<CaseStudyDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ ok: true; caseStudy: CaseStudyDto }>(
        `/api/prm/portal/case-study/${id}`,
      )
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.portal.caseStudies.error.loadFailed', 'Could not load case study.'))
      }
      setData(res.result.caseStudy)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.portal.caseStudies.error.loadFailed', 'Could not load case study.'),
      )
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>
  if (error) return <ErrorMessage label={error} />
  if (!data) return null

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{data.title}</h1>
          <p className="text-sm text-muted-foreground">
            {data.clientName}
            {data.isCurrentlyPublished
              ? ` · ${t('prm.portal.caseStudies.status.published', 'Published')}`
              : data.mayPublishOnOmWebsite
                ? ` · ${t('prm.portal.caseStudies.status.flagged', 'Approved (no URL)')}`
                : ''}
          </p>
        </div>
        <Link
          href={`/${orgSlug}/portal/case-studies`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Back to list
        </Link>
      </header>
      <CaseStudyForm
        mode="edit"
        caseStudyId={data.id}
        initial={caseStudyDtoToFormValues(data)}
        onSuccess={() => void load()}
      />
    </div>
  )
}
