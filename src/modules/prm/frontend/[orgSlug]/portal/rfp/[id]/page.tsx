'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * P10 — Portal RFP detail (Spec #5 §3.2 / US5.3 + US5.4 + US5.5).
 *
 * Visibility-gated server-side; this page only renders if the GET succeeded.
 * Scaffold (C3a) ships read-only brief + status badges + locked CTAs (decline,
 * respond) as stubs. Subsequent commits layer:
 *   - C3b: markdown editors + draft auto-save
 *   - C3d: submit / unsubmit
 *   - C4:  decline / undecline panel
 */

type RfpDetail = {
  id: string
  title: string
  receivedFrom: string
  receivedAt: string
  description: string
  techRequirements: string
  domainRequirements: string
  industry: string | null
  budgetBucket: string | null
  timelineBucket: string | null
  requiredCapabilities: string[]
  additionalCriterionName: string | null
  deadlineToRespond: string | null
  status: string
}

type Broadcast = {
  id: string
  broadcastedAt: string
  firstOpenedAt: string | null
  declinedAt: string | null
  declineReason: string | null
}

type Response = {
  id: string
  status: 'draft' | 'submitted'
  techExperience: string | null
  domainExperience: string | null
  differentiators: string | null
  attachedCaseStudyIds: string[]
  firstSubmittedAt: string | null
  lastUpdatedAt: string
}

type DetailResponse =
  | { ok: true; rfp: RfpDetail; broadcast: Broadcast; response: Response | null }
  | { ok: false; error: string | { code: string; message: string } }

const RESPONSIVE_STATUSES = new Set(['published'])
const VIEWABLE_STATUSES = new Set(['published', 'scoring', 'selection_made'])

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString()
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

export default function PortalRfpDetailPage() {
  const t = useT()
  const params = useParams<{ orgSlug: string; id: string }>()
  const id = params?.id
  const [data, setData] = React.useState<{
    rfp: RfpDetail
    broadcast: Broadcast
    response: Response | null
  } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notFound, setNotFound] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const res = await apiCall<DetailResponse>(`/api/prm/portal/rfp/${id}`)
      if (res.status === 404) {
        setNotFound(true)
        return
      }
      if (!res.ok || !res.result || !('rfp' in res.result) || !res.result.ok) {
        throw new Error(t('prm.portal.rfp.detail.loadError', 'Failed to load RFP.'))
      }
      setData({
        rfp: res.result.rfp,
        broadcast: res.result.broadcast,
        response: res.result.response,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prm.portal.rfp.detail.loadError', 'Failed to load RFP.'))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return <LoadingMessage label={t('prm.portal.rfp.detail.loading', 'Loading RFP…')} />
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <BackLink t={t} />
        <ErrorMessage label={t('prm.portal.rfp.detail.notFound', 'This RFP is no longer visible to you.')} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <BackLink t={t} />
        <ErrorMessage label={error ?? t('prm.portal.rfp.detail.loadError', 'Failed to load RFP.')} />
      </div>
    )
  }

  const { rfp, broadcast } = data
  const statusKey = `prm.portal.rfp.detail.status.${rfp.status}`
  const isResponseable = RESPONSIVE_STATUSES.has(rfp.status)
  const isViewable = VIEWABLE_STATUSES.has(rfp.status)
  const declined = broadcast.declinedAt !== null
  const deadlinePassed = rfp.deadlineToRespond
    ? new Date(rfp.deadlineToRespond).getTime() < Date.now()
    : false

  const lockReason = (() => {
    if (declined) return null
    if (rfp.status === 'scoring') {
      return t('prm.portal.rfp.detail.locked.scoring', 'Scoring is in progress — responses are locked until the round closes.')
    }
    if (rfp.status === 'selection_made') {
      return t('prm.portal.rfp.detail.locked.selectionMade', 'OM PartnerOps has selected an agency. Responses are locked.')
    }
    if (rfp.status === 'closed') {
      return t('prm.portal.rfp.detail.locked.closed', 'This RFP is closed.')
    }
    if (deadlinePassed) {
      return t('prm.portal.rfp.detail.deadlinePassed', 'The deadline has passed — submit/unsubmit are no longer available.')
    }
    return null
  })()

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackLink t={t} />

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{rfp.title}</h1>
          <span
            className="rounded-full border px-2 py-0.5 text-xs"
            data-testid="rfp-status-badge"
          >
            {t(statusKey, rfp.status)}
          </span>
          {declined ? (
            <span
              className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="rfp-declined-badge"
            >
              {t('prm.portal.rfp.badge.declined', 'Declined')}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('prm.portal.rfp.detail.field.receivedFrom', 'Received from')}: {rfp.receivedFrom}
          {' · '}
          {t('prm.portal.rfp.detail.field.receivedAt', 'Received at')}: {formatDate(rfp.receivedAt)}
        </p>
      </header>

      {declined ? (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          data-testid="rfp-declined-notice"
        >
          <p>
            {broadcast.declinedAt
              ? t('prm.portal.rfp.detail.declinedNoticeOn', 'You declined this RFP on {date}.', {
                  date: formatDate(broadcast.declinedAt),
                })
              : t('prm.portal.rfp.detail.declinedNotice', 'You declined this RFP.')}
          </p>
          {broadcast.declineReason ? (
            <p className="mt-1 text-xs">
              {t('prm.portal.rfp.detail.declinedNoticeWithReason', 'Reason: {reason}', {
                reason: broadcast.declineReason,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {lockReason && !declined ? (
        <div
          className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
          data-testid="rfp-lock-notice"
        >
          {lockReason}
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{t('prm.portal.rfp.detail.section.brief', 'Brief')}</h2>
        <div className="whitespace-pre-wrap rounded-md border bg-background p-4 text-sm" data-testid="rfp-description">
          {rfp.description}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t('prm.portal.rfp.detail.section.tech', 'Technical requirements')}</h3>
          <div
            className="whitespace-pre-wrap rounded-md border bg-background p-3 text-sm"
            data-testid="rfp-tech-requirements"
          >
            {rfp.techRequirements}
          </div>
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t('prm.portal.rfp.detail.section.domain', 'Domain requirements')}</h3>
          <div
            className="whitespace-pre-wrap rounded-md border bg-background p-3 text-sm"
            data-testid="rfp-domain-requirements"
          >
            {rfp.domainRequirements}
          </div>
        </div>
      </section>

      <section className="rounded-md border bg-muted/20 p-4 text-sm">
        <h3 className="mb-2 text-sm font-medium">{t('prm.portal.rfp.detail.section.meta', 'Details')}</h3>
        <dl className="grid gap-2 md:grid-cols-2">
          <MetaRow label={t('prm.portal.rfp.detail.field.industry', 'Industry')} value={rfp.industry} />
          <MetaRow label={t('prm.portal.rfp.detail.field.budget', 'Budget')} value={rfp.budgetBucket} />
          <MetaRow label={t('prm.portal.rfp.detail.field.timeline', 'Timeline')} value={rfp.timelineBucket} />
          <MetaRow
            label={t('prm.portal.rfp.detail.field.deadline', 'Deadline to respond')}
            value={rfp.deadlineToRespond ? formatDateTime(rfp.deadlineToRespond) : null}
          />
          <MetaRow
            label={t('prm.portal.rfp.detail.field.capabilities', 'Required capabilities')}
            value={rfp.requiredCapabilities.length ? rfp.requiredCapabilities.join(', ') : null}
          />
          <MetaRow
            label={t('prm.portal.rfp.detail.field.additional', 'Additional criterion')}
            value={rfp.additionalCriterionName}
          />
        </dl>
      </section>

      {!declined && isViewable ? (
        <section className="space-y-3 rounded-md border p-4">
          <h2 className="text-lg font-medium">{t('prm.portal.rfp.response.title', 'Your response')}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'prm.portal.rfp.response.subtitle',
              'Drafts auto-save every few seconds. Submit when ready.',
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled data-testid="rfp-respond-cta">
              {isResponseable
                ? t('prm.portal.rfp.detail.cta.respond', 'Open response form')
                : t('prm.portal.rfp.detail.cta.respondLocked', 'Respond (locked)')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled
              data-testid="rfp-decline-cta"
              title={
                isResponseable
                  ? undefined
                  : t('prm.portal.rfp.detail.cta.declineDisabled', 'Decline (locked)')
              }
            >
              {t('prm.portal.rfp.detail.cta.decline', 'Decline this RFP')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'prm.portal.rfp.response.caseStudy.deferred',
              'Case study attachments will be available when the Case Studies module ships.',
            )}
          </p>
        </section>
      ) : null}
    </div>
  )
}

function BackLink({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <Link href="../rfp" className="text-sm text-muted-foreground hover:text-foreground">
      ← {t('prm.portal.rfp.detail.back', 'Back to inbox')}
    </Link>
  )
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  )
}
