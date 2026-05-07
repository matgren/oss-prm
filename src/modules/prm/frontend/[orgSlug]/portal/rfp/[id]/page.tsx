'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

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
        <ResponseSection
          rfpId={rfp.id}
          initialResponse={data.response}
          isResponseable={isResponseable}
          onChange={(next) => setData((prev) => (prev ? { ...prev, response: next } : prev))}
        />
      ) : null}

      {isViewable ? (
        <DeclineSection
          rfpId={rfp.id}
          isResponseable={isResponseable}
          declinedAt={broadcast.declinedAt}
          declineReason={broadcast.declineReason}
          onChange={(nextBroadcast) =>
            setData((prev) => (prev ? { ...prev, broadcast: { ...prev.broadcast, ...nextBroadcast } } : prev))
          }
        />
      ) : null}
    </div>
  )
}

const AUTO_SAVE_DEBOUNCE_MS = 500

type DraftRouteResponse =
  | { ok: true; id: string; status: 'draft' | 'submitted'; lastUpdatedAt: string; emitted: boolean }
  | { ok: false; error: string | { code: string; message: string } }

type ResponseSectionProps = {
  rfpId: string
  initialResponse: Response | null
  isResponseable: boolean
  onChange: (next: Response | null) => void
}

function ResponseSection({ rfpId, initialResponse, isResponseable, onChange }: ResponseSectionProps) {
  const t = useT()
  const [response, setResponse] = React.useState<Response | null>(initialResponse)
  const [tech, setTech] = React.useState(initialResponse?.techExperience ?? '')
  const [domain, setDomain] = React.useState(initialResponse?.domainExperience ?? '')
  const [diff, setDiff] = React.useState(initialResponse?.differentiators ?? '')
  const [savingState, setSavingState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  )
  const [savedAt, setSavedAt] = React.useState<string | null>(initialResponse?.lastUpdatedAt ?? null)
  const [errorLabel, setErrorLabel] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [unsubmitting, setUnsubmitting] = React.useState(false)

  const submitted = response?.status === 'submitted'
  const editable = isResponseable && !submitted
  const requiredFilled = tech.trim().length > 0 && domain.trim().length > 0
  const lastSentRef = React.useRef<string>(
    serializeDraft(
      initialResponse?.techExperience ?? '',
      initialResponse?.domainExperience ?? '',
      initialResponse?.differentiators ?? '',
    ),
  )

  React.useEffect(() => {
    if (!editable) return
    const next = serializeDraft(tech, domain, diff)
    if (next === lastSentRef.current) return
    setSavingState('saving')
    const handle = window.setTimeout(() => {
      void persistDraft(rfpId, { tech, domain, diff })
        .then((res) => {
          if (!res.ok || !('id' in res)) {
            const message =
              typeof res.error === 'string'
                ? res.error
                : res.error?.message ?? t('prm.portal.rfp.response.draftError', 'Auto-save failed.')
            setErrorLabel(message)
            setSavingState('error')
            return
          }
          lastSentRef.current = next
          setSavedAt(res.lastUpdatedAt)
          setSavingState('saved')
          setErrorLabel(null)
          const updated: Response = {
            id: res.id,
            status: res.status,
            techExperience: tech,
            domainExperience: domain,
            differentiators: diff,
            attachedCaseStudyIds: response?.attachedCaseStudyIds ?? [],
            firstSubmittedAt: response?.firstSubmittedAt ?? null,
            lastUpdatedAt: res.lastUpdatedAt,
          }
          setResponse(updated)
          onChange(updated)
        })
        .catch(() => {
          setErrorLabel(
            t('prm.portal.rfp.response.draftError', 'Auto-save failed.'),
          )
          setSavingState('error')
        })
    }, AUTO_SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [tech, domain, diff, rfpId, editable, t, response, onChange])

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const result = await readApiResultOrThrow<{
        ok: true
        id: string
        status: 'submitted'
        firstSubmittedAt: string | null
        lastUpdatedAt: string
        isInitialSubmission: boolean
      }>(`/api/prm/portal/rfp/${rfpId}/response/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const updated: Response = {
        id: result.id,
        status: result.status,
        techExperience: tech,
        domainExperience: domain,
        differentiators: diff,
        attachedCaseStudyIds: response?.attachedCaseStudyIds ?? [],
        firstSubmittedAt: result.firstSubmittedAt,
        lastUpdatedAt: result.lastUpdatedAt,
      }
      setResponse(updated)
      onChange(updated)
      flash(t('prm.portal.rfp.response.flash.submitted', 'Response submitted.'), 'success')
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('prm.portal.rfp.response.flash.submitError', 'Submit failed.'),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleUnsubmit = async () => {
    setUnsubmitting(true)
    try {
      const result = await readApiResultOrThrow<{
        ok: true
        id: string
        status: 'draft'
        lastUpdatedAt: string
        reverted: boolean
      }>(`/api/prm/portal/rfp/${rfpId}/response/unsubmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const updated: Response = {
        id: result.id,
        status: result.status,
        techExperience: tech,
        domainExperience: domain,
        differentiators: diff,
        attachedCaseStudyIds: response?.attachedCaseStudyIds ?? [],
        firstSubmittedAt: response?.firstSubmittedAt ?? null,
        lastUpdatedAt: result.lastUpdatedAt,
      }
      setResponse(updated)
      onChange(updated)
      flash(t('prm.portal.rfp.response.flash.unsubmitted', 'Response moved back to draft.'), 'success')
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('prm.portal.rfp.response.flash.unsubmitError', 'Withdraw failed.'),
        'error',
      )
    } finally {
      setUnsubmitting(false)
    }
  }

  const savedAtLabel = savedAt
    ? t('prm.portal.rfp.response.savedAt', 'Last saved {time}', {
        time: new Date(savedAt).toLocaleTimeString(),
      })
    : null

  return (
    <section className="space-y-3 rounded-md border p-4" data-testid="rfp-response-section">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">{t('prm.portal.rfp.response.title', 'Your response')}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'prm.portal.rfp.response.subtitle',
              'Drafts auto-save every few seconds. Submit when ready.',
            )}
          </p>
        </div>
        <div className="text-xs text-muted-foreground" data-testid="rfp-save-state">
          {savingState === 'saving'
            ? t('prm.portal.rfp.response.saving', 'Saving…')
            : savingState === 'error'
              ? (errorLabel ?? t('prm.portal.rfp.response.draftError', 'Auto-save failed.'))
              : savedAtLabel}
        </div>
      </header>

      {!editable && submitted ? (
        <div
          className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
          data-testid="rfp-response-locked"
        >
          {t('prm.portal.rfp.response.locked.submitted', 'Submitted on {date}. Withdraw before the deadline if you need to edit.', {
            date: response?.firstSubmittedAt
              ? new Date(response.firstSubmittedAt).toLocaleString()
              : '—',
          })}
        </div>
      ) : null}

      <DraftField
        labelKey="prm.portal.rfp.response.field.tech"
        labelFallback="Technical experience"
        helpKey="prm.portal.rfp.response.field.tech.help"
        helpFallback="Named-client evidence > generic claims. Markdown supported."
        value={tech}
        onChange={setTech}
        disabled={!editable}
        testId="rfp-field-tech"
      />
      <DraftField
        labelKey="prm.portal.rfp.response.field.domain"
        labelFallback="Domain experience"
        helpKey="prm.portal.rfp.response.field.domain.help"
        helpFallback="Markdown supported."
        value={domain}
        onChange={setDomain}
        disabled={!editable}
        testId="rfp-field-domain"
      />
      <DraftField
        labelKey="prm.portal.rfp.response.field.differentiators"
        labelFallback="Differentiators (optional)"
        helpKey="prm.portal.rfp.response.field.differentiators.help"
        helpFallback="Optional. Markdown supported."
        value={diff}
        onChange={setDiff}
        disabled={!editable}
        testId="rfp-field-differentiators"
      />

      <p className="text-xs text-muted-foreground">
        {t(
          'prm.portal.rfp.response.caseStudy.deferred',
          'Case study attachments will be available when the Case Studies module ships.',
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {submitted ? (
          <Button
            type="button"
            variant="outline"
            disabled={unsubmitting || !isResponseable}
            onClick={handleUnsubmit}
            data-testid="rfp-unsubmit-cta"
          >
            {unsubmitting
              ? t('prm.portal.rfp.response.unsubmitting', 'Withdrawing…')
              : t('prm.portal.rfp.response.unsubmit', 'Withdraw submission')}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!editable || submitting || !requiredFilled}
            onClick={handleSubmit}
            data-testid="rfp-submit-cta"
          >
            {submitting
              ? t('prm.portal.rfp.response.submitting', 'Submitting…')
              : t('prm.portal.rfp.response.submit', 'Submit response')}
          </Button>
        )}
        {!submitted ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'prm.portal.rfp.response.requiredHint',
              'Technical and domain experience are required to submit.',
            )}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function DraftField({
  labelKey,
  labelFallback,
  helpKey,
  helpFallback,
  value,
  onChange,
  disabled,
  testId,
}: {
  labelKey: string
  labelFallback: string
  helpKey: string
  helpFallback: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  testId: string
}) {
  const t = useT()
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{t(labelKey, labelFallback)}</span>
      <Textarea
        className="min-h-32 font-mono"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      <span className="text-xs text-muted-foreground">{t(helpKey, helpFallback)}</span>
    </label>
  )
}

function serializeDraft(tech: string, domain: string, diff: string): string {
  return JSON.stringify({ tech, domain, diff })
}

async function persistDraft(
  rfpId: string,
  values: { tech: string; domain: string; diff: string },
): Promise<DraftRouteResponse> {
  const res = await apiCall<DraftRouteResponse>(`/api/prm/portal/rfp/${rfpId}/response/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tech_experience: values.tech,
      domain_experience: values.domain,
      differentiators: values.diff,
    }),
  })
  if (!res.ok || !res.result) {
    return { ok: false, error: 'Failed to save draft.' }
  }
  return res.result
}

type DeclineSectionProps = {
  rfpId: string
  isResponseable: boolean
  declinedAt: string | null
  declineReason: string | null
  onChange: (next: { declinedAt: string | null; declineReason: string | null }) => void
}

function DeclineSection({
  rfpId,
  isResponseable,
  declinedAt,
  declineReason,
  onChange,
}: DeclineSectionProps) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const declined = declinedAt !== null

  const handleDecline = async () => {
    setSubmitting(true)
    try {
      const result = await readApiResultOrThrow<{
        ok: true
        id: string
        declinedAt: string | null
        declineReason: string | null
        declined: boolean
      }>(`/api/prm/portal/rfp/${rfpId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decline_reason: reason.trim() ? reason.trim() : null }),
      })
      onChange({ declinedAt: result.declinedAt, declineReason: result.declineReason })
      flash(t('prm.portal.rfp.detail.decline.flash.declined', 'RFP declined.'), 'success')
      setOpen(false)
      setReason('')
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('prm.portal.rfp.detail.decline.flash.error', 'Decline failed.'),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleUndecline = async () => {
    setSubmitting(true)
    try {
      const result = await readApiResultOrThrow<{
        ok: true
        id: string
        declinedAt: string | null
        declineReason: string | null
        reverted: boolean
      }>(`/api/prm/portal/rfp/${rfpId}/undecline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      onChange({ declinedAt: result.declinedAt, declineReason: result.declineReason })
      flash(t('prm.portal.rfp.detail.decline.flash.undeclined', 'Decline reversed.'), 'success')
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('prm.portal.rfp.detail.decline.flash.undeclineError', 'Could not reverse decline.'),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (declined) {
    return (
      <section className="rounded-md border p-4 text-sm" data-testid="rfp-decline-section">
        <Button
          type="button"
          variant="outline"
          disabled={submitting || !isResponseable}
          onClick={handleUndecline}
          data-testid="rfp-undecline-cta"
        >
          {t('prm.portal.rfp.detail.cta.undecline', 'Undo decline')}
        </Button>
      </section>
    )
  }

  if (!open) {
    return (
      <section className="rounded-md border p-4 text-sm" data-testid="rfp-decline-section">
        <Button
          type="button"
          variant="outline"
          disabled={!isResponseable}
          onClick={() => setOpen(true)}
          data-testid="rfp-decline-cta"
          title={
            isResponseable
              ? undefined
              : t('prm.portal.rfp.detail.cta.declineDisabled', 'Decline (locked)')
          }
        >
          {t('prm.portal.rfp.detail.cta.decline', 'Decline this RFP')}
        </Button>
      </section>
    )
  }

  return (
    <section
      className="space-y-3 rounded-md border p-4 text-sm"
      data-testid="rfp-decline-section"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !submitting) {
          setOpen(false)
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !submitting) {
          void handleDecline()
        }
      }}
    >
      <div>
        <h3 className="font-medium">{t('prm.portal.rfp.detail.decline.title', 'Decline RFP')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('prm.portal.rfp.detail.decline.subtitle', 'Optional: a short note for OM PartnerOps.')}
        </p>
      </div>
      <Textarea
        className="min-h-24"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t(
          'prm.portal.rfp.detail.decline.placeholder',
          'e.g. capacity, conflict of interest, out of scope',
        )}
        data-testid="rfp-decline-reason"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => {
            setOpen(false)
            setReason('')
          }}
          data-testid="rfp-decline-cancel"
        >
          {t('prm.portal.rfp.detail.cta.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          disabled={submitting}
          onClick={handleDecline}
          data-testid="rfp-decline-submit"
        >
          {submitting
            ? t('prm.portal.rfp.detail.cta.declineSubmit', 'Confirm decline') + '…'
            : t('prm.portal.rfp.detail.cta.declineSubmit', 'Confirm decline')}
        </Button>
      </div>
    </section>
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
