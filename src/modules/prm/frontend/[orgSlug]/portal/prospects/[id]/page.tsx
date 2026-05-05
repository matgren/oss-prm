'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

type Prospect = {
  id: string
  agencyId: string
  organizationId: string
  companyName: string
  contactName: string
  contactEmail: string
  source: string
  status: string
  lostReason: string | null
  notes: string | null
  registeredAt: string
  statusChangedAt: string
  registeredByAgencyMemberId: string
  canEdit: boolean
  canTransitionTo: string[]
}

type GetResponse = { ok: true; prospect: Prospect } | { ok: false; error: { code: string; message: string } }

/**
 * P6 — Portal Prospect detail (Spec #2 — wip-scoreboard).
 *
 * Custom React (no CrudForm). State-machine-aware CTAs: only valid next-states are shown
 * as buttons, mirroring the aggregate's invariant #12 enforcement. Transitions ship the
 * `if_match_status_changed_at` optimistic-concurrency token captured at load time.
 */
export default function PortalProspectDetailPage() {
  const t = useT()
  const params = useParams<{ orgSlug: string; id: string }>()
  const id = params?.id
  const orgSlug = params?.orgSlug
  const [prospect, setProspect] = React.useState<Prospect | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [transitioning, setTransitioning] = React.useState<string | null>(null)
  const [form, setForm] = React.useState({
    companyName: '',
    contactName: '',
    contactEmail: '',
    notes: '',
  })
  const [lostReason, setLostReason] = React.useState('')
  const [showLostDialog, setShowLostDialog] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<GetResponse>(`/api/prm/portal/prospects/${id}`)
      if (!res.ok || !res.result?.ok) {
        const msg =
          res.result && !res.result.ok ? res.result.error.message : t('prm.portal.prospects.detail.loadError', 'Failed to load prospect.')
        setError(msg)
        return
      }
      const p = res.result.prospect
      setProspect(p)
      setForm({
        companyName: p.companyName,
        contactName: p.contactName,
        contactEmail: p.contactEmail,
        notes: p.notes ?? '',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const onSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!id) return
    setSaving(true)
    try {
      await apiCallOrThrow(`/api/prm/portal/prospects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'edit',
          companyName: form.companyName,
          contactName: form.contactName,
          contactEmail: form.contactEmail,
          notes: form.notes.trim() ? form.notes.trim() : null,
        }),
      })
      flash(t('prm.portal.prospects.detail.flash.saved', 'Saved.'), 'success')
      await load()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('prm.portal.prospects.detail.flash.saveError', 'Save failed.'),
        'error',
      )
    } finally {
      setSaving(false)
    }
  }

  const transition = React.useCallback(
    async (toStatus: string, lostReasonValue?: string) => {
      if (!id || !prospect) return
      setTransitioning(toStatus)
      try {
        const body: Record<string, unknown> = {
          kind: 'transition',
          toStatus,
          ifMatchStatusChangedAt: prospect.statusChangedAt,
        }
        if (toStatus === 'lost') {
          if (!lostReasonValue || lostReasonValue.trim().length < 10) {
            flash(
              t(
                'prm.portal.prospects.detail.lostReasonRequired',
                'Please provide a reason of at least 10 characters.',
              ),
              'error',
            )
            setTransitioning(null)
            return
          }
          body.lostReason = lostReasonValue.trim()
        }
        await apiCallOrThrow(`/api/prm/portal/prospects/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        flash(
          t('prm.portal.prospects.detail.flash.transitioned', 'Status updated to {status}.', { status: toStatus }),
          'success',
        )
        setShowLostDialog(false)
        setLostReason('')
        await load()
      } catch (err) {
        flash(
          err instanceof Error ? err.message : t('prm.portal.prospects.detail.flash.transitionError', 'Transition failed.'),
          'error',
        )
      } finally {
        setTransitioning(null)
      }
    },
    [id, prospect, t],
  )

  if (loading && !prospect) {
    return <LoadingMessage label={t('prm.portal.prospects.detail.loading', 'Loading…')} />
  }
  if (error) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Link className="text-sm text-primary underline-offset-2 hover:underline" href={`/${orgSlug}/portal/prospects`}>
          {t('prm.portal.prospects.detail.back', 'Back to prospects')}
        </Link>
        <ErrorMessage label={error} />
      </div>
    )
  }
  if (!prospect) return null

  const allowedTransitions = prospect.canTransitionTo
  const canEdit = prospect.canEdit

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <Link className="text-sm text-primary underline-offset-2 hover:underline" href={`/${orgSlug}/portal/prospects`}>
          {t('prm.portal.prospects.detail.back', 'Back to prospects')}
        </Link>
      </div>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{prospect.companyName}</h1>
          <p className="text-sm text-muted-foreground">
            {t('prm.portal.prospects.detail.subtitle', 'Status: {status} · Registered {date}', {
              status: prospect.status,
              date: new Date(prospect.registeredAt).toLocaleDateString(),
            })}
          </p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs">{prospect.status}</span>
      </header>

      {prospect.status === 'lost' && prospect.lostReason ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">{t('prm.portal.prospects.detail.lostReason', 'Lost reason')}</div>
          <div className="mt-1">{prospect.lostReason}</div>
        </div>
      ) : null}

      {allowedTransitions.length > 0 && canEdit ? (
        <section className="rounded-md border p-4">
          <h2 className="mb-3 text-sm font-semibold">
            {t('prm.portal.prospects.detail.transitions.title', 'Update status')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {allowedTransitions.map((next) => (
              <Button
                key={next}
                type="button"
                variant={next === 'lost' ? 'destructive' : 'outline'}
                size="sm"
                disabled={transitioning !== null}
                onClick={() => {
                  if (next === 'lost') {
                    setShowLostDialog(true)
                    return
                  }
                  void transition(next)
                }}
              >
                {transitioning === next
                  ? t('prm.portal.prospects.detail.transitioning', 'Saving…')
                  : t(`prm.portal.prospects.detail.transitionTo.${next}`, `Mark ${next}`)}
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      {showLostDialog ? (
        <section
          className="rounded-md border border-rose-300 bg-rose-50 p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowLostDialog(false)
              setLostReason('')
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              void transition('lost', lostReason)
            }
          }}
        >
          <h3 className="mb-2 text-sm font-semibold">
            {t('prm.portal.prospects.detail.lostDialog.title', 'Mark prospect as lost')}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            {t(
              'prm.portal.prospects.detail.lostDialog.help',
              'A reason of at least 10 characters is required for audit purposes.',
            )}
          </p>
          <Textarea
            className="min-h-20 w-full"
            value={lostReason}
            placeholder={t('prm.portal.prospects.detail.lostDialog.placeholder', 'Why are we losing this prospect?')}
            onChange={(e) => setLostReason(e.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setShowLostDialog(false)
                setLostReason('')
              }}
            >
              {t('prm.portal.prospects.detail.lostDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={transitioning === 'lost' || lostReason.trim().length < 10}
              onClick={() => void transition('lost', lostReason)}
            >
              {transitioning === 'lost'
                ? t('prm.portal.prospects.detail.lostDialog.saving', 'Saving…')
                : t('prm.portal.prospects.detail.lostDialog.confirm', 'Mark lost')}
            </Button>
          </div>
        </section>
      ) : null}

      <form
        className="grid grid-cols-1 gap-3 rounded-md border p-4 md:grid-cols-2"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            ;(e.currentTarget as HTMLFormElement).requestSubmit()
          }
          if (e.key === 'Escape') void load()
        }}
        onSubmit={onSave}
      >
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">{t('prm.portal.prospects.fields.company', 'Company name')}</span>
          <Input
            value={form.companyName}
            disabled={!canEdit}
            required
            onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('prm.portal.prospects.fields.contactName', 'Contact name')}</span>
          <Input
            value={form.contactName}
            disabled={!canEdit}
            required
            onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('prm.portal.prospects.fields.contactEmail', 'Contact email')}</span>
          <Input
            type="email"
            value={form.contactEmail}
            disabled={!canEdit}
            required
            onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">{t('prm.portal.prospects.fields.notes', 'Notes')}</span>
          <Textarea
            className="min-h-24"
            value={form.notes}
            disabled={!canEdit}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>
        {canEdit ? (
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => void load()}>
              {t('prm.portal.prospects.detail.cancel', 'Reset')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('prm.portal.prospects.detail.saving', 'Saving…') : t('prm.portal.prospects.detail.save', 'Save')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  )
}
