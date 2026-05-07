'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { cn } from '@open-mercato/shared/lib/utils'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ReasonDialog, type ReasonDialogCopy } from './reasonDialog'

type LicenseDeal = {
  id: string
  licenseIdentifier: string
  clientCompanyName: string
  clientIndustry: string | null
  type: string
  status: string
  isRenewal: boolean
  previousLicenseDealId: string | null
  closedAt: string | null
  signedAt: string | null
  annualValueUsd: string | null
  monthlyLicenseAmount: string | null
  attributionPath: string
  attributionSource: string
  prospectId: string | null
  rfpId: string | null
  attributedAgencyId: string | null
  attributionReasoning: string | null
  attributedAt: string | null
  notes: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type Candidate = {
  prospectId: string
  agencyId: string
  organizationId: string
  companyName: string
  contactName: string
  contactEmail: string
  status: string
  registeredAt: string
  registeredByAgencyMemberId: string
  isDefaultPick: boolean
}

type DetailResponse = { ok: true; licenseDeal: LicenseDeal }
type CandidatesResponse = { ok: true; candidates: Candidate[] }

/**
 * B5 license deal detail (Spec #3 §3.1).
 *
 * Hosts:
 *   - Aggregate read-out + non-attribution edits (deferred to v2 inline edit).
 *   - Golden Rule attribution picker (Path A) with LOST badge on lost candidates
 *     per invariant #14.
 *   - Path B (RFP) + Path C (Direct) tabs.
 *   - Status transition + reverse + unreverse-status actions.
 */
function resolveDynamicId(params: Record<string, unknown> | null): string | undefined {
  // OM framework routes module pages through a catch-all `/backend/[...slug]`.
  // For `/backend/prm/license-deals/<uuid>` params arrive as
  // `slug = ['prm', 'license-deals', 'uuid']`; only when Next.js routes the
  // page directly do we get `params.id`. Cover both shapes.
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

export default function LicenseDealDetailPage() {
  const t = useT()
  const router = useRouter()
  const params = useParams() as Record<string, unknown> | null
  const id = resolveDynamicId(params)

  const [deal, setDeal] = React.useState<LicenseDeal | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<DetailResponse>(`/api/prm/license-deal/${id}`)
      if (!res.ok || !res.result?.ok) throw new Error('Failed to load license deal')
      setDeal(res.result.licenseDeal)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load license deal')
    } finally {
      setLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) return <LoadingMessage label={t('prm.licenseDeals.detail.loading', 'Loading…')} />
  if (error || !deal) return <ErrorMessage label={error ?? 'Not found'} />

  const isFrozen = deal.status === 'active' || deal.status === 'churned'
  const isAttributed = deal.attributionPath !== 'none'

  return (
    <Page>
      <PageHeader
        title={`${deal.licenseIdentifier} · ${deal.clientCompanyName}`}
        description={t(
          'prm.licenseDeals.detail.subtitle',
          'Status: {status} · Path: {path} · Source: {source}',
        )
          .replace('{status}', deal.status)
          .replace('{path}', deal.attributionPath)
          .replace('{source}', deal.attributionSource)}
        actions={
          <Link href="/backend/prm/license-deals">
            <Button variant="outline">{t('prm.licenseDeals.detail.back', 'Back to list')}</Button>
          </Link>
        }
      />
      <PageBody>
        <DealOverview deal={deal} />

        {!isAttributed && deal.status === 'pending' ? (
          <AttributionPicker deal={deal} onAttributed={() => void load()} />
        ) : null}

        {isAttributed ? (
          <AttributedSummary deal={deal} />
        ) : null}

        <ActionsBar
          deal={deal}
          isFrozen={isFrozen}
          onChange={() => void load()}
          onDeleted={() => router.push('/backend/prm/license-deals')}
        />
      </PageBody>
    </Page>
  )
}

function DealOverview({ deal }: { deal: LicenseDeal }) {
  const t = useT()
  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.detail.overview', 'Overview')}
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label={t('prm.licenseDeals.fields.identifier', 'License identifier')} value={deal.licenseIdentifier} />
        <Row label={t('prm.licenseDeals.fields.client', 'Client')} value={deal.clientCompanyName} />
        <Row label={t('prm.licenseDeals.fields.industry', 'Industry')} value={deal.clientIndustry ?? '—'} />
        <Row label={t('prm.licenseDeals.fields.type', 'Type')} value={deal.type} />
        <Row label={t('prm.licenseDeals.fields.status', 'Status')} value={deal.status} />
        <Row label={t('prm.licenseDeals.fields.path', 'Attribution path')} value={deal.attributionPath} />
        <Row label={t('prm.licenseDeals.fields.annualValueUsd', 'Annual value (USD)')} value={deal.annualValueUsd ?? '—'} />
        <Row label={t('prm.licenseDeals.fields.monthlyLicenseAmount', 'Monthly amount (USD)')} value={deal.monthlyLicenseAmount ?? '—'} />
        <Row label={t('prm.licenseDeals.fields.signedAt', 'Signed at')} value={deal.signedAt ? new Date(deal.signedAt).toLocaleString() : '—'} />
        <Row label={t('prm.licenseDeals.fields.attributedAt', 'Attributed at')} value={deal.attributedAt ? new Date(deal.attributedAt).toLocaleString() : '—'} />
      </dl>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function AttributedSummary({ deal }: { deal: LicenseDeal }) {
  const t = useT()
  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.detail.attribution', 'Attribution')}
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label={t('prm.licenseDeals.fields.path', 'Path')} value={deal.attributionPath} />
        <Row label={t('prm.licenseDeals.fields.source', 'Source')} value={deal.attributionSource} />
        <Row label={t('prm.licenseDeals.fields.attributedAgencyId', 'Attributed agency id')} value={deal.attributedAgencyId ?? '—'} />
        {deal.prospectId ? <Row label="Prospect ID" value={deal.prospectId} /> : null}
        {deal.rfpId ? <Row label="RFP ID" value={deal.rfpId} /> : null}
      </dl>
      {deal.attributionReasoning ? (
        <div className="mt-3 rounded border-l-2 border-primary/60 bg-muted/50 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('prm.licenseDeals.fields.attributionReasoning', 'Attribution reasoning')}
          </div>
          <p className="mt-1 whitespace-pre-wrap">{deal.attributionReasoning}</p>
        </div>
      ) : null}
    </section>
  )
}

type PathTab = 'A' | 'B' | 'C'

function AttributionPicker({ deal, onAttributed }: { deal: LicenseDeal; onAttributed: () => void }) {
  const t = useT()
  const [activeTab, setActiveTab] = React.useState<PathTab>('A')
  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold">
        {t('prm.licenseDeals.attribute.title', 'Attribute this deal')}
      </h3>
      <p className="mb-4 text-xs text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.description',
          'Choose Path A (Prospect), Path B (RFP), or Path C (Direct). Path A defaults to the oldest non-lost matching Prospect (Golden Rule).',
        )}
      </p>
      <div className="mb-4 flex gap-1 border-b">
        {(['A', 'B', 'C'] as PathTab[]).map((tab) => (
          <Button
            key={tab}
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              '-mb-px h-auto rounded-none border-b-2 px-3 py-1 text-sm font-medium hover:bg-transparent',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab(tab)}
          >
            {t(`prm.licenseDeals.path.${tab}`, `Path ${tab}`)}
          </Button>
        ))}
      </div>
      {activeTab === 'A' ? (
        <PathAPicker deal={deal} onAttributed={onAttributed} />
      ) : activeTab === 'B' ? (
        <PathBPicker deal={deal} onAttributed={onAttributed} />
      ) : (
        <PathCPicker deal={deal} onAttributed={onAttributed} />
      )}
    </section>
  )
}

function PathAPicker({ deal, onAttributed }: { deal: LicenseDeal; onAttributed: () => void }) {
  const t = useT()
  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [picked, setPicked] = React.useState<string | null>(null)
  const [defaultId, setDefaultId] = React.useState<string | null>(null)
  const [reasoning, setReasoning] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ clientCompanyName: deal.clientCompanyName })
        const res = await apiCall<CandidatesResponse>(
          `/api/prm/license-deal/golden-rule-candidates?${params.toString()}`,
        )
        if (!res.ok || !res.result?.ok) throw new Error('Failed to load candidates')
        if (cancelled) return
        const found = res.result.candidates
        setCandidates(found)
        const def = found.find((c) => c.isDefaultPick)?.prospectId ?? null
        setDefaultId(def)
        setPicked(def)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load candidates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [deal.clientCompanyName])

  const isOverride = picked !== null && defaultId !== null && picked !== defaultId

  async function submit() {
    if (!picked || !defaultId) return
    if (isOverride && reasoning.trim().length === 0) {
      setError(t('prm.licenseDeals.attribute.errors.reasoningRequired', 'Reasoning required for non-default pick.'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attribution_path: 'A',
          prospect_id: picked,
          golden_rule_default_prospect_id: defaultId,
          ...(reasoning.trim().length > 0 ? { attribution_reasoning: reasoning.trim() } : {}),
          competing_prospect_ids_to_retire: [],
        }),
      })
      flash(t('prm.licenseDeals.attribute.flash.success', 'License deal attributed.'), 'success')
      onAttributed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attribute')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingMessage label={t('prm.licenseDeals.attribute.loading', 'Loading candidates…')} />
  if (candidates.length === 0) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {t(
          'prm.licenseDeals.attribute.A.empty',
          'No matching Prospects found by Golden Rule. Switch to Path B (RFP) or Path C (Direct).',
        )}
      </p>
    )
  }
  return (
    <div>
      <ul className="mb-3 divide-y rounded-md border">
        {candidates.map((c) => (
          <li
            key={c.prospectId}
            className={`flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40 ${
              picked === c.prospectId ? 'bg-muted/60' : ''
            }`}
            onClick={() => setPicked(c.prospectId)}
          >
            <input
              type="radio"
              checked={picked === c.prospectId}
              readOnly
              className="mt-1"
              aria-label={c.companyName}
            />
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.companyName}</span>
                {c.isDefaultPick ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {t('prm.licenseDeals.attribute.A.defaultBadge', 'Golden Rule default')}
                  </span>
                ) : null}
                {c.status === 'lost' ? (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                    {t('prm.licenseDeals.attribute.A.lostBadge', 'LOST')}
                  </span>
                ) : (
                  <span className="rounded-full border px-2 py-0.5 text-xs">{c.status}</span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {c.contactName} · {c.contactEmail}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t('prm.licenseDeals.attribute.A.registeredAt', 'Registered')}
                {': '}
                {new Date(c.registeredAt).toLocaleDateString()} · agency {c.agencyId.slice(0, 8)}…
              </div>
            </div>
          </li>
        ))}
      </ul>
      {isOverride ? (
        <label className="mb-3 flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t('prm.licenseDeals.attribute.A.reasoningLabel', 'Reasoning (required for non-default pick)')}
          </span>
          <Textarea
            className="min-h-[5rem]"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
          />
        </label>
      ) : null}
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting || !picked}>
          {t('prm.licenseDeals.attribute.A.submit', 'Attribute Path A')}
        </Button>
      </div>
    </div>
  )
}

function PathBPicker({ deal, onAttributed }: { deal: LicenseDeal; onAttributed: () => void }) {
  const t = useT()
  const [rfpId, setRfpId] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit() {
    if (!rfpId.trim()) {
      setError(t('prm.licenseDeals.attribute.B.errors.rfpRequired', 'RFP id required.'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attribution_path: 'B', rfp_id: rfpId.trim() }),
      })
      flash(t('prm.licenseDeals.attribute.flash.success', 'License deal attributed.'), 'success')
      onAttributed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attribute')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.B.description',
          'Path B is for RFP-driven deals. The RFP module ships in Spec #5 — when the RFP table is missing, the writer accepts the rfp_id as a placeholder and the saga will snapshot the winner once Spec #5 lands.',
        )}
      </p>
      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('prm.licenseDeals.attribute.B.rfpLabel', 'RFP id')}</span>
        <Input
          type="text"
          value={rfpId}
          onChange={(e) => setRfpId(e.target.value)}
        />
      </label>
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting}>
          {t('prm.licenseDeals.attribute.B.submit', 'Attribute Path B')}
        </Button>
      </div>
    </div>
  )
}

function PathCPicker({ deal, onAttributed }: { deal: LicenseDeal; onAttributed: () => void }) {
  const t = useT()
  const [agencyId, setAgencyId] = React.useState('')
  const [reasoning, setReasoning] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit() {
    if (!agencyId.trim()) {
      setError(t('prm.licenseDeals.attribute.C.errors.agencyRequired', 'Agency id required.'))
      return
    }
    if (reasoning.trim().length === 0) {
      setError(t('prm.licenseDeals.attribute.C.errors.reasoningRequired', 'Reasoning required for Path C.'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attribution_path: 'C',
          attributed_agency_id: agencyId.trim(),
          attribution_reasoning: reasoning.trim(),
        }),
      })
      flash(t('prm.licenseDeals.attribute.flash.success', 'License deal attributed.'), 'success')
      onAttributed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attribute')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.C.description',
          'Path C captures direct OM sales. Reasoning is required for audit.',
        )}
      </p>
      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('prm.licenseDeals.attribute.C.agencyLabel', 'Attributed agency id')}</span>
        <Input
          type="text"
          value={agencyId}
          onChange={(e) => setAgencyId(e.target.value)}
        />
      </label>
      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span className="font-medium">
          {t('prm.licenseDeals.attribute.C.reasoningLabel', 'Reasoning (required)')}
        </span>
        <Textarea
          className="min-h-[5rem]"
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
        />
      </label>
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting}>
          {t('prm.licenseDeals.attribute.C.submit', 'Attribute Path C')}
        </Button>
      </div>
    </div>
  )
}

function ActionsBar({
  deal,
  isFrozen,
  onChange,
  onDeleted,
}: {
  deal: LicenseDeal
  isFrozen: boolean
  onChange: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reverseOpen, setReverseOpen] = React.useState(false)
  const [unreverseTarget, setUnreverseTarget] = React.useState<'signed' | 'pending' | null>(null)

  const reverseCopy: ReasonDialogCopy = {
    title: t('prm.licenseDeals.reverse.dialog.title', 'Reverse attribution'),
    help: t(
      'prm.licenseDeals.reverse.dialog.help',
      'Provide an audit-grade reason of at least 10 characters. The reverse compensates Path A/B/C attribution and emits an audit event.',
    ),
    placeholder: t(
      'prm.licenseDeals.reverse.dialog.placeholder',
      'Why is this attribution being reversed?',
    ),
    reasonLabel: t('prm.licenseDeals.reverse.dialog.reasonLabel', 'Reason'),
    cancel: t('prm.licenseDeals.reverse.dialog.cancel', 'Cancel'),
    confirm: t('prm.licenseDeals.reverse.dialog.confirm', 'Reverse'),
    saving: t('prm.licenseDeals.reverse.dialog.saving', 'Reversing…'),
    validationMessage: t(
      'prm.licenseDeals.reverse.dialog.validation',
      'Reason must be at least 10 characters.',
    ),
  }

  const unreverseCopy: ReasonDialogCopy = {
    title:
      unreverseTarget === 'signed'
        ? t('prm.licenseDeals.unreverse.dialog.title.signed', 'Walk back to signed')
        : t('prm.licenseDeals.unreverse.dialog.title.pending', 'Release back to pending'),
    help: t(
      'prm.licenseDeals.unreverse.dialog.help',
      'Provide an audit-grade reason of at least 10 characters. Use this only when the status was advanced in error.',
    ),
    placeholder: t(
      'prm.licenseDeals.unreverse.dialog.placeholder',
      'Why is the status being walked back?',
    ),
    reasonLabel: t('prm.licenseDeals.unreverse.dialog.reasonLabel', 'Reason'),
    cancel: t('prm.licenseDeals.unreverse.dialog.cancel', 'Cancel'),
    confirm: t('prm.licenseDeals.unreverse.dialog.confirm', 'Unreverse status'),
    saving: t('prm.licenseDeals.unreverse.dialog.saving', 'Saving…'),
    validationMessage: t(
      'prm.licenseDeals.unreverse.dialog.validation',
      'Reason must be at least 10 characters.',
    ),
  }

  async function transition(toStatus: 'signed' | 'active' | 'churned') {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus, ifMatchVersion: deal.version }),
      })
      flash(t('prm.licenseDeals.transition.flash.success', 'Status updated.'), 'success')
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transition')
    } finally {
      setBusy(false)
    }
  }

  async function reverse(reason: string) {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      flash(t('prm.licenseDeals.reverse.flash.success', 'Attribution reversed.'), 'success')
      setReverseOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reverse')
    } finally {
      setBusy(false)
    }
  }

  async function unreverse(toStatus: 'signed' | 'pending', reason: string) {
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/unreverse-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus, reason }),
      })
      flash(t('prm.licenseDeals.unreverse.flash.success', 'Status unreversed.'), 'success')
      setUnreverseTarget(null)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unreverse')
    } finally {
      setBusy(false)
    }
  }

  async function softDelete() {
    if (!window.confirm(t('prm.licenseDeals.delete.confirm', 'Soft-delete this pending license deal?'))) return
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}`, { method: 'DELETE' })
      flash(t('prm.licenseDeals.delete.flash.success', 'License deal deleted.'), 'success')
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.actions.title', 'Actions')}
      </h3>
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex flex-wrap gap-2">
        {deal.status === 'signed' ? (
          <Button onClick={() => transition('active')} disabled={busy}>
            {t('prm.licenseDeals.actions.activate', 'Mark active')}
          </Button>
        ) : null}
        {(deal.status === 'signed' || deal.status === 'active') ? (
          <Button onClick={() => transition('churned')} disabled={busy} variant="destructive">
            {t('prm.licenseDeals.actions.churn', 'Mark churned')}
          </Button>
        ) : null}
        {deal.attributionPath !== 'none' && !isFrozen ? (
          <Button onClick={() => setReverseOpen(true)} disabled={busy} variant="outline">
            {t('prm.licenseDeals.actions.reverse', 'Reverse attribution')}
          </Button>
        ) : null}
        {deal.status === 'active' ? (
          <Button onClick={() => setUnreverseTarget('signed')} disabled={busy} variant="outline">
            {t('prm.licenseDeals.actions.unreverseToSigned', 'Unreverse → signed (US4.4b)')}
          </Button>
        ) : null}
        {deal.status === 'signed' ? (
          <Button onClick={() => setUnreverseTarget('pending')} disabled={busy} variant="outline">
            {t('prm.licenseDeals.actions.unreverseToPending', 'Unreverse → pending (release)')}
          </Button>
        ) : null}
        {deal.status === 'pending' ? (
          <Button onClick={softDelete} disabled={busy} variant="destructive">
            {t('prm.licenseDeals.actions.delete', 'Delete (soft)')}
          </Button>
        ) : null}
      </div>
      <ReasonDialog
        open={reverseOpen}
        copy={reverseCopy}
        busy={busy}
        onConfirm={(reason) => void reverse(reason)}
        onCancel={() => setReverseOpen(false)}
        testId="reverse-dialog"
      />
      <ReasonDialog
        open={unreverseTarget !== null}
        copy={unreverseCopy}
        busy={busy}
        onConfirm={(reason) => {
          if (unreverseTarget) void unreverse(unreverseTarget, reason)
        }}
        onCancel={() => setUnreverseTarget(null)}
        testId="unreverse-dialog"
      >
        <p className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {unreverseTarget === 'signed'
            ? t(
                'prm.licenseDeals.unreverse.dialog.targetHint.signed',
                'Target status: signed. Use to walk an active deal back to signed (US4.4b).',
              )
            : t(
                'prm.licenseDeals.unreverse.dialog.targetHint.pending',
                'Target status: pending. Use to release a signed deal back to pending so it can be reversed.',
              )}
        </p>
      </ReasonDialog>
    </section>
  )
}
