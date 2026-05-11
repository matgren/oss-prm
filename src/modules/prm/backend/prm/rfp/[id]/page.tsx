'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { resolveDynamicId } from '../../../../lib/dynamicParams'

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
 * B7 — RFP read-only detail page.
 *
 * Draft editing lives on the sibling `/edit` page (canonical OM CRUD pattern:
 * separate detail and edit, list-with-flash redirect on save). This page
 * shows the Overview + lifecycle ActionsBar (publish / unpublish / close /
 * reopen / delete) and links to `/edit` while the RFP is still a draft.
 */
export default function RfpDetailPage() {
  const t = useT()
  const router = useRouter()
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
          <div className="flex flex-wrap gap-2">
            {rfp.status === 'draft' ? (
              <Link href={`/backend/prm/rfp/${rfp.id}/edit`}>
                <Button>{t('prm.rfp.detail.edit', 'Edit draft')}</Button>
              </Link>
            ) : null}
            <Link href="/backend/prm/rfp">
              <Button variant="outline">{t('prm.rfp.detail.back', 'Back to list')}</Button>
            </Link>
          </div>
        }
      />
      <PageBody>
        <RfpOverview rfp={rfp} broadcastTotal={broadcastTotal} />
        <ActionsBar
          rfp={rfp}
          broadcastTotal={broadcastTotal}
          onChange={() => void load()}
          onDeleted={() => router.push('/backend/prm/rfp')}
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
  onDeleted,
}: {
  rfp: Rfp
  broadcastTotal: number | null
  onChange: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [publishOpen, setPublishOpen] = React.useState(false)
  const [unpublishOpen, setUnpublishOpen] = React.useState(false)
  const [closeOpen, setCloseOpen] = React.useState(false)
  const [reopenOpen, setReopenOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
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

  async function deleteDraft() {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/rfp/${rfp.id}`, {
        method: 'DELETE',
      })
      flash(t('prm.rfp.delete.flash.success', 'RFP draft deleted.'), 'success')
      setDeleteOpen(false)
      onDeleted()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.rfp.delete.flash.error', 'Failed to delete RFP draft.'),
      )
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
          <>
            <Button onClick={() => setPublishOpen(true)} disabled={busy}>
              {t('prm.rfp.actions.publish', 'Publish + broadcast')}
            </Button>
            <Button
              onClick={() => setDeleteOpen(true)}
              disabled={busy}
              variant="destructive"
            >
              {t('prm.rfp.actions.delete', 'Delete draft')}
            </Button>
          </>
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
        open={deleteOpen}
        title={t('prm.rfp.delete.dialog.title', 'Delete RFP draft?')}
        body={t(
          'prm.rfp.delete.dialog.body',
          'This soft-deletes the draft (deleted_at is set; the row is preserved for audit). Only draft RFPs can be deleted — published, scoring, or closed RFPs are referenced by broadcasts and responses and cannot be removed here.',
        )}
        confirmLabel={
          busy
            ? t('prm.rfp.delete.dialog.saving', 'Deleting…')
            : t('prm.rfp.delete.dialog.confirm', 'Delete draft')
        }
        cancelLabel={t('prm.rfp.delete.dialog.cancel', 'Cancel')}
        busy={busy}
        variant="destructive"
        onConfirm={() => void deleteDraft()}
        onCancel={() => setDeleteOpen(false)}
      />

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
