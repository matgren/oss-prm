'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

type Rfp = {
  id: string
  organizationId: string
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
  eligibilityFilter: string
  minTier: string | null
  explicitAgencyIds: string[] | null
  status: string
  selectedAgencyId: string | null
  isPathBLocked: boolean
  notes: string | null
  publishedAt: string | null
  closedAt: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
}

type DetailResponse = { ok: true; rfp: Rfp }
type BroadcastsResponse = {
  ok: true
  items: unknown[]
  total: number
}

/**
 * B7 — RFP detail (Spec #5 §3.1 + §10 Commit 1).
 *
 * Edit-while-draft, plus publish / unpublish / close / reopen lifecycle
 * actions. Uses native dialog primitives that honour Cmd/Ctrl+Enter +
 * Escape per AGENTS.md UI conventions.
 */
function resolveDynamicId(params: Record<string, unknown> | null): string | undefined {
  // OM framework routes module pages through a catch-all `/backend/[...slug]`.
  const slug = (params as { slug?: unknown } | null)?.slug
  if (Array.isArray(slug) && slug.length > 0) {
    const last = slug[slug.length - 1]
    if (typeof last === 'string') return last
  }
  const id = (params as { id?: unknown } | null)?.id
  if (Array.isArray(id) && id.length > 0 && typeof id[0] === 'string') return id[0]
  if (typeof id === 'string') return id
  return undefined
}

export default function RfpDetailPage() {
  const t = useT()
  const params = useParams() as Record<string, unknown> | null
  const id = resolveDynamicId(params)

  const [rfp, setRfp] = React.useState<Rfp | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [broadcastTotal, setBroadcastTotal] = React.useState<number | null>(null)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<DetailResponse>(`/api/prm/rfp/${id}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.rfp.error.loadDetail', 'Failed to load RFP'))
      }
      setRfp(res.result.rfp)
      // Best-effort fetch of broadcast count when published-or-later. Soft-fail.
      if (res.result.rfp.status !== 'draft') {
        try {
          const bres = await apiCall<BroadcastsResponse>(
            `/api/prm/rfp/${id}/broadcasts?page=1&pageSize=1`,
          )
          if (bres.ok && bres.result?.ok) setBroadcastTotal(bres.result.total)
        } catch {
          // silent — count is informational only
        }
      } else {
        setBroadcastTotal(null)
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('prm.rfp.error.loadDetail', 'Failed to load RFP'),
      )
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) return <LoadingMessage label={t('prm.rfp.detail.loading', 'Loading…')} />
  if (error || !rfp) return <ErrorMessage label={error ?? 'Not found'} />

  return (
    <Page>
      <PageHeader
        title={rfp.title}
        description={t(
          'prm.rfp.detail.subtitle',
          'Status: {status} · Eligibility: {eligibility} · From: {from}',
        )
          .replace('{status}', rfp.status)
          .replace('{eligibility}', rfp.eligibilityFilter)
          .replace('{from}', rfp.receivedFrom)}
        actions={
          <Link href="/backend/prm/rfp">
            <Button variant="outline">{t('prm.rfp.detail.back', 'Back to list')}</Button>
          </Link>
        }
      />
      <PageBody>
        <RfpOverview rfp={rfp} broadcastTotal={broadcastTotal} />
        {rfp.status === 'draft' ? (
          <DraftEditor rfp={rfp} onSaved={() => void load()} />
        ) : null}
        <ActionsBar
          rfp={rfp}
          broadcastTotal={broadcastTotal}
          onChange={() => void load()}
        />
      </PageBody>
    </Page>
  )
}

function RfpOverview({ rfp, broadcastTotal }: { rfp: Rfp; broadcastTotal: number | null }) {
  const t = useT()
  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.rfp.detail.overview', 'Overview')}
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label={t('prm.rfp.fields.title', 'Title')} value={rfp.title} />
        <Row label={t('prm.rfp.fields.receivedFrom', 'Received from')} value={rfp.receivedFrom} />
        <Row
          label={t('prm.rfp.fields.receivedAt', 'Received at')}
          value={new Date(rfp.receivedAt).toLocaleDateString()}
        />
        <Row label={t('prm.rfp.fields.industry', 'Industry')} value={rfp.industry ?? '—'} />
        <Row label={t('prm.rfp.fields.budgetBucket', 'Budget bucket')} value={rfp.budgetBucket ?? '—'} />
        <Row label={t('prm.rfp.fields.timelineBucket', 'Timeline bucket')} value={rfp.timelineBucket ?? '—'} />
        <Row label={t('prm.rfp.fields.status', 'Status')} value={rfp.status} />
        <Row
          label={t('prm.rfp.fields.eligibilityFilter', 'Eligibility filter')}
          value={rfp.eligibilityFilter}
        />
        {rfp.eligibilityFilter === 'by_min_tier' ? (
          <Row label={t('prm.rfp.fields.minTier', 'Min tier')} value={rfp.minTier ?? '—'} />
        ) : null}
        {rfp.eligibilityFilter === 'explicit' ? (
          <Row
            label={t('prm.rfp.fields.explicitAgencyIds', 'Explicit agency IDs')}
            value={(rfp.explicitAgencyIds ?? []).join(', ') || '—'}
          />
        ) : null}
        <Row
          label={t('prm.rfp.fields.requiredCapabilities', 'Required capabilities')}
          value={rfp.requiredCapabilities.join(', ') || '—'}
        />
        <Row
          label={t('prm.rfp.fields.deadlineToRespond', 'Deadline to respond')}
          value={rfp.deadlineToRespond ? new Date(rfp.deadlineToRespond).toLocaleString() : '—'}
        />
        <Row
          label={t('prm.rfp.fields.publishedAt', 'Published at')}
          value={rfp.publishedAt ? new Date(rfp.publishedAt).toLocaleString() : '—'}
        />
        <Row
          label={t('prm.rfp.fields.closedAt', 'Closed at')}
          value={rfp.closedAt ? new Date(rfp.closedAt).toLocaleString() : '—'}
        />
        <Row
          label={t('prm.rfp.fields.broadcasts', 'Broadcasts')}
          value={broadcastTotal !== null ? String(broadcastTotal) : '—'}
        />
        <Row
          label={t('prm.rfp.fields.selectedAgencyId', 'Selected agency')}
          value={rfp.selectedAgencyId ?? '—'}
        />
      </dl>
      {rfp.description ? (
        <Section
          label={t('prm.rfp.fields.description', 'Description (markdown)')}
          value={rfp.description}
        />
      ) : null}
      {rfp.techRequirements ? (
        <Section
          label={t('prm.rfp.fields.techRequirements', 'Tech requirements (markdown)')}
          value={rfp.techRequirements}
        />
      ) : null}
      {rfp.domainRequirements ? (
        <Section
          label={t('prm.rfp.fields.domainRequirements', 'Domain requirements (markdown)')}
          value={rfp.domainRequirements}
        />
      ) : null}
      {rfp.notes ? (
        <Section label={t('prm.rfp.fields.notes', 'Internal notes')} value={rfp.notes} />
      ) : null}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function Section({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
        {value}
      </pre>
    </div>
  )
}

/**
 * Inline draft editor — only mounted when status === 'draft'. PATCHes the
 * subset of fields that change here. Eligibility companion-field rules
 * mirror the server validator.
 */
function DraftEditor({ rfp, onSaved }: { rfp: Rfp; onSaved: () => void }) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState(rfp.title)
  const [receivedFrom, setReceivedFrom] = React.useState(rfp.receivedFrom)
  const [receivedAt, setReceivedAt] = React.useState(rfp.receivedAt.slice(0, 10))
  const [description, setDescription] = React.useState(rfp.description)
  const [techRequirements, setTechRequirements] = React.useState(rfp.techRequirements)
  const [domainRequirements, setDomainRequirements] = React.useState(rfp.domainRequirements)
  const [industry, setIndustry] = React.useState(rfp.industry ?? '')
  const [budgetBucket, setBudgetBucket] = React.useState(rfp.budgetBucket ?? '')
  const [timelineBucket, setTimelineBucket] = React.useState(rfp.timelineBucket ?? '')
  const [requiredCapabilities, setRequiredCapabilities] = React.useState(
    rfp.requiredCapabilities.join(', '),
  )
  const [additionalCriterionName, setAdditionalCriterionName] = React.useState(
    rfp.additionalCriterionName ?? '',
  )
  const [deadlineToRespond, setDeadlineToRespond] = React.useState(
    rfp.deadlineToRespond ? rfp.deadlineToRespond.slice(0, 16) : '',
  )
  const [eligibilityFilter, setEligibilityFilter] = React.useState(rfp.eligibilityFilter)
  const [minTier, setMinTier] = React.useState(rfp.minTier ?? '')
  const [explicitAgencyIds, setExplicitAgencyIds] = React.useState(
    (rfp.explicitAgencyIds ?? []).join(', '),
  )
  const [notes, setNotes] = React.useState(rfp.notes ?? '')

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // Companion-field guards (mirror server validator).
      if (eligibilityFilter === 'by_min_tier' && !minTier) {
        throw new Error(
          t(
            'prm.rfp.edit.errors.minTierRequired',
            'Min tier is required when eligibility = by_min_tier.',
          ),
        )
      }
      const explicitIds = explicitAgencyIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (eligibilityFilter === 'explicit' && explicitIds.length === 0) {
        throw new Error(
          t(
            'prm.rfp.edit.errors.explicitRequired',
            'At least one agency UUID required when eligibility = explicit.',
          ),
        )
      }
      const capabilities = requiredCapabilities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const payload: Record<string, unknown> = {
        title,
        received_from: receivedFrom,
        received_at: receivedAt,
        description,
        tech_requirements: techRequirements,
        domain_requirements: domainRequirements,
        required_capabilities: capabilities,
        eligibility_filter: eligibilityFilter,
        industry: industry || null,
        budget_bucket: budgetBucket || null,
        timeline_bucket: timelineBucket || null,
        additional_criterion_name: additionalCriterionName || null,
        deadline_to_respond: deadlineToRespond || null,
        min_tier: eligibilityFilter === 'by_min_tier' ? minTier || null : null,
        explicit_agency_ids: eligibilityFilter === 'explicit' ? explicitIds : null,
        notes: notes || null,
      }
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      flash(t('prm.rfp.edit.flash.saved', 'Draft saved.'), 'success')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save draft')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.rfp.edit.title', 'Edit draft')}
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabelInput
          label={t('prm.rfp.fields.title', 'Title')}
          value={title}
          onChange={setTitle}
          required
        />
        <LabelInput
          label={t('prm.rfp.fields.receivedFrom', 'Received from')}
          value={receivedFrom}
          onChange={setReceivedFrom}
          required
        />
        <LabelInput
          label={t('prm.rfp.fields.receivedAt', 'Received at')}
          type="date"
          value={receivedAt}
          onChange={setReceivedAt}
          required
        />
        <LabelInput
          label={t('prm.rfp.fields.industry', 'Industry')}
          value={industry}
          onChange={setIndustry}
        />
        <LabelSelect
          label={t('prm.rfp.fields.budgetBucket', 'Budget bucket')}
          value={budgetBucket}
          onChange={setBudgetBucket}
          options={[
            { value: '', label: '—' },
            { value: '<50k', label: '< $50k' },
            { value: '50k-250k', label: '$50k–$250k' },
            { value: '250k-1m', label: '$250k–$1M' },
            { value: '1m+', label: '$1M+' },
            { value: 'unknown', label: 'Unknown' },
          ]}
        />
        <LabelSelect
          label={t('prm.rfp.fields.timelineBucket', 'Timeline bucket')}
          value={timelineBucket}
          onChange={setTimelineBucket}
          options={[
            { value: '', label: '—' },
            { value: '0-3m', label: '0–3 months' },
            { value: '3-6m', label: '3–6 months' },
            { value: '6-12m', label: '6–12 months' },
            { value: '12m+', label: '12+ months' },
            { value: 'unknown', label: 'Unknown' },
          ]}
        />
        <LabelInput
          label={t('prm.rfp.fields.deadlineToRespond', 'Deadline to respond')}
          type="datetime-local"
          value={deadlineToRespond}
          onChange={setDeadlineToRespond}
        />
        <LabelInput
          label={t('prm.rfp.fields.additionalCriterionName', 'Additional scoring criterion')}
          value={additionalCriterionName}
          onChange={setAdditionalCriterionName}
        />
        <LabelSelect
          label={t('prm.rfp.fields.eligibilityFilter', 'Eligibility filter')}
          value={eligibilityFilter}
          onChange={setEligibilityFilter}
          options={[
            { value: 'all_active', label: 'All active agencies' },
            { value: 'by_min_tier', label: 'By minimum tier' },
            { value: 'explicit', label: 'Explicit agency list' },
          ]}
          required
        />
        {eligibilityFilter === 'by_min_tier' ? (
          <LabelSelect
            label={t('prm.rfp.fields.minTier', 'Min tier')}
            value={minTier}
            onChange={setMinTier}
            options={[
              { value: '', label: '—' },
              { value: 'om_agency', label: 'OM Agency' },
              { value: 'ai_native', label: 'AI-Native' },
              { value: 'ai_native_expert', label: 'AI-Native Expert' },
              { value: 'ai_native_core', label: 'AI-Native Core' },
            ]}
          />
        ) : null}
      </div>
      {eligibilityFilter === 'explicit' ? (
        <LabelTextarea
          label={t('prm.rfp.fields.explicitAgencyIds', 'Explicit agency IDs')}
          help={t('prm.rfp.fields.explicitAgencyIds.help', 'Comma-separated UUIDs.')}
          value={explicitAgencyIds}
          onChange={setExplicitAgencyIds}
        />
      ) : null}
      <LabelInput
        label={t('prm.rfp.fields.requiredCapabilities', 'Required capabilities')}
        value={requiredCapabilities}
        onChange={setRequiredCapabilities}
        help={t(
          'prm.rfp.fields.requiredCapabilities.help',
          'Comma-separated capability slugs (e.g. nextjs,postgres).',
        )}
      />
      <LabelTextarea
        label={t('prm.rfp.fields.description', 'Description (markdown)')}
        value={description}
        onChange={setDescription}
      />
      <LabelTextarea
        label={t('prm.rfp.fields.techRequirements', 'Tech requirements (markdown)')}
        value={techRequirements}
        onChange={setTechRequirements}
      />
      <LabelTextarea
        label={t('prm.rfp.fields.domainRequirements', 'Domain requirements (markdown)')}
        value={domainRequirements}
        onChange={setDomainRequirements}
      />
      <LabelTextarea
        label={t('prm.rfp.fields.notes', 'Internal notes')}
        value={notes}
        onChange={setNotes}
      />
      {error ? <ErrorMessage label={error} /> : null}
      <div className="mt-4 flex justify-end">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? t('prm.rfp.edit.saving', 'Saving…') : t('prm.rfp.edit.submit', 'Save draft')}
        </Button>
      </div>
    </section>
  )
}

function LabelInput({
  label,
  value,
  onChange,
  type = 'text',
  required,
  help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  help?: string
}) {
  return (
    <label className="mt-3 flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </label>
  )
}

function LabelTextarea({
  label,
  value,
  onChange,
  help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  help?: string
}) {
  return (
    <label className="mt-3 flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Textarea
        className="min-h-24"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </label>
  )
}

function LabelSelect({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/* --------------------------------------------------------------------- *
 * Action buttons + dialogs                                              *
 * --------------------------------------------------------------------- */

type DialogKeyIntent = 'submit' | 'cancel' | 'none'
function classifyDialogKey(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
}): DialogKeyIntent {
  if (event.key === 'Escape') return 'cancel'
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') return 'submit'
  return 'none'
}

function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  variant = 'default',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => ref.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => {
        const intent = classifyDialogKey(e)
        if (intent === 'cancel') {
          e.preventDefault()
          onCancel()
        } else if (intent === 'submit' && !busy) {
          e.preventDefault()
          onConfirm()
        }
      }}
    >
      <div className="w-full max-w-md rounded-md border bg-card p-4 shadow-lg">
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{body}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={ref}
            type="button"
            variant={variant}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ReasonDialog({
  open,
  title,
  help,
  reasonLabel,
  confirmLabel,
  cancelLabel,
  validationMessage,
  minLength,
  busy,
  extraSlot,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  help: string
  reasonLabel: string
  confirmLabel: string
  cancelLabel: string
  validationMessage: string
  minLength: number
  busy: boolean
  extraSlot?: React.ReactNode
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = React.useState('')
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  React.useEffect(() => {
    if (open) {
      setReason('')
      const id = window.setTimeout(() => ref.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])
  if (!open) return null
  const valid = reason.trim().length >= minLength
  function handleSubmit() {
    if (!valid || busy) return
    onConfirm(reason.trim())
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => {
        const intent = classifyDialogKey(e)
        if (intent === 'cancel') {
          e.preventDefault()
          onCancel()
        } else if (intent === 'submit') {
          e.preventDefault()
          handleSubmit()
        }
      }}
    >
      <div className="w-full max-w-md rounded-md border bg-card p-4 shadow-lg">
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{help}</p>
        {extraSlot}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{reasonLabel}</span>
          <Textarea
            ref={ref}
            className="min-h-24"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {reason.length > 0 && !valid ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {validationMessage}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={!valid || busy}
            onClick={handleSubmit}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ActionsBar({
  rfp,
  broadcastTotal,
  onChange,
}: {
  rfp: Rfp
  broadcastTotal: number | null
  onChange: () => void
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [publishOpen, setPublishOpen] = React.useState(false)
  const [unpublishOpen, setUnpublishOpen] = React.useState(false)
  const [closeOpen, setCloseOpen] = React.useState(false)
  const [reopenOpen, setReopenOpen] = React.useState(false)
  const [reopenDeadline, setReopenDeadline] = React.useState('')

  async function publish() {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      flash(t('prm.rfp.publish.flash.success', 'RFP published.'), 'success')
      setPublishOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish')
    } finally {
      setBusy(false)
    }
  }

  async function unpublish(reason: string) {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      flash(t('prm.rfp.unpublish.flash.success', 'RFP unpublished.'), 'success')
      setUnpublishOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unpublish')
    } finally {
      setBusy(false)
    }
  }

  async function closeRfp(reason: string) {
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {}
      if (reason) payload.close_reason = reason
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      flash(t('prm.rfp.close.flash.success', 'RFP closed.'), 'success')
      setCloseOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close')
    } finally {
      setBusy(false)
    }
  }

  async function reopen(reason: string) {
    if (!reopenDeadline) {
      setError(
        t(
          'prm.rfp.reopen.errors.deadlineRequired',
          'A new deadline is required to reopen the RFP.',
        ),
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reopen_reason: reason,
          reopened_deadline_at: new Date(reopenDeadline).toISOString(),
        }),
      })
      flash(t('prm.rfp.reopen.flash.success', 'RFP reopened.'), 'success')
      setReopenOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reopen')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.rfp.actions.title', 'Actions')}
      </h3>
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex flex-wrap gap-2">
        {rfp.status === 'draft' ? (
          <Button onClick={() => setPublishOpen(true)} disabled={busy}>
            {t('prm.rfp.actions.publish', 'Publish + broadcast')}
          </Button>
        ) : null}
        {rfp.status === 'published' ? (
          <>
            <Button
              onClick={() => setUnpublishOpen(true)}
              disabled={busy}
              variant="outline"
            >
              {t('prm.rfp.actions.unpublish', 'Unpublish (no responses yet)')}
            </Button>
            <Button onClick={() => setCloseOpen(true)} disabled={busy} variant="destructive">
              {t('prm.rfp.actions.close', 'Close')}
            </Button>
          </>
        ) : null}
        {rfp.status === 'scoring' || rfp.status === 'selection_made' || rfp.status === 'reopened' ? (
          <Button onClick={() => setCloseOpen(true)} disabled={busy} variant="destructive">
            {t('prm.rfp.actions.close', 'Close')}
          </Button>
        ) : null}
        {rfp.status === 'closed' || rfp.status === 'selection_made' ? (
          <Button onClick={() => setReopenOpen(true)} disabled={busy} variant="outline">
            {t('prm.rfp.actions.reopen', 'Reopen (challenge round)')}
          </Button>
        ) : null}
        {rfp.status !== 'draft' ? (
          <Link href={`/backend/prm/rfp-audit/${rfp.id}`}>
            <Button type="button" variant="outline" disabled={busy}>
              {t('prm.rfp.actions.audit', 'View broadcast audit')}
            </Button>
          </Link>
        ) : null}
      </div>

      <ConfirmDialog
        open={publishOpen}
        title={t('prm.rfp.publish.dialog.title', 'Publish RFP?')}
        body={t(
          'prm.rfp.publish.dialog.body',
          'This evaluates the eligibility filter and broadcasts the RFP to all matching agencies. This action cannot be silently undone — agencies will be notified.',
        )}
        confirmLabel={
          busy
            ? t('prm.rfp.publish.dialog.saving', 'Publishing…')
            : t('prm.rfp.publish.dialog.confirm', 'Publish')
        }
        cancelLabel={t('prm.rfp.publish.dialog.cancel', 'Cancel')}
        busy={busy}
        onConfirm={() => void publish()}
        onCancel={() => setPublishOpen(false)}
      />

      <ReasonDialog
        open={unpublishOpen}
        title={t('prm.rfp.unpublish.dialog.title', 'Unpublish RFP')}
        help={t(
          'prm.rfp.unpublish.dialog.help',
          'Reverts the RFP to draft. Refused (409) if any agency has opened, declined, or responded — preserved for audit.',
        )}
        reasonLabel={t('prm.rfp.unpublish.dialog.reasonLabel', 'Reason')}
        confirmLabel={
          busy
            ? t('prm.rfp.unpublish.dialog.saving', 'Reverting…')
            : t('prm.rfp.unpublish.dialog.confirm', 'Unpublish')
        }
        cancelLabel={t('prm.rfp.unpublish.dialog.cancel', 'Cancel')}
        validationMessage={t(
          'prm.rfp.unpublish.dialog.validation',
          'Reason must be at least 1 character.',
        )}
        minLength={1}
        busy={busy}
        onConfirm={(reason) => void unpublish(reason)}
        onCancel={() => setUnpublishOpen(false)}
      />

      <ReasonDialog
        open={closeOpen}
        title={t('prm.rfp.close.dialog.title', 'Close RFP')}
        help={t(
          'prm.rfp.close.dialog.help',
          'Terminal lifecycle transition. close_reason is required when no winner has been selected (server-enforced).',
        )}
        reasonLabel={t('prm.rfp.close.dialog.reasonLabel', 'Close reason (required when no selection)')}
        confirmLabel={
          busy
            ? t('prm.rfp.close.dialog.saving', 'Closing…')
            : t('prm.rfp.close.dialog.confirm', 'Close RFP')
        }
        cancelLabel={t('prm.rfp.close.dialog.cancel', 'Cancel')}
        validationMessage={t(
          'prm.rfp.close.dialog.validation',
          'Close reason must be at least 5 characters when provided.',
        )}
        // 0 = optional; server enforces ≥ 5 chars only when no selection.
        minLength={0}
        busy={busy}
        onConfirm={(reason) => void closeRfp(reason)}
        onCancel={() => setCloseOpen(false)}
      />

      <ReasonDialog
        open={reopenOpen}
        title={t('prm.rfp.reopen.dialog.title', 'Reopen RFP')}
        help={t(
          'prm.rfp.reopen.dialog.help',
          'Sets a new agency-side deadline for revised responses. Refused (409 PATH_B_SIGNED_DEAL_LOCK) when a signed Path-B license deal is attributed to this RFP.',
        )}
        reasonLabel={t('prm.rfp.reopen.dialog.reasonLabel', 'Reopen reason (≥ 10 chars)')}
        confirmLabel={
          busy
            ? t('prm.rfp.reopen.dialog.saving', 'Reopening…')
            : t('prm.rfp.reopen.dialog.confirm', 'Reopen')
        }
        cancelLabel={t('prm.rfp.reopen.dialog.cancel', 'Cancel')}
        validationMessage={t(
          'prm.rfp.reopen.dialog.validation',
          'Reason must be at least 10 characters.',
        )}
        minLength={10}
        busy={busy}
        extraSlot={
          <label className="mb-3 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              {t('prm.rfp.reopen.dialog.deadlineLabel', 'New deadline (must be in the future)')}
            </span>
            <Input
              type="datetime-local"
              value={reopenDeadline}
              onChange={(e) => setReopenDeadline(e.target.value)}
            />
          </label>
        }
        onConfirm={(reason) => void reopen(reason)}
        onCancel={() => setReopenOpen(false)}
      />

      {broadcastTotal !== null ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('prm.rfp.actions.broadcastsHint', 'Broadcasts created: {count}').replace(
            '{count}',
            String(broadcastTotal),
          )}
        </p>
      ) : null}
    </section>
  )
}
