'use client'
import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { Input } from '@open-mercato/ui/primitives/input'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { cn } from '@open-mercato/shared/lib/utils'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ReasonDialog, type ReasonDialogCopy } from './reasonDialog'
import { ConfirmDialog, type ConfirmDialogCopy } from './confirmDialog'
import {
  buildSagaInstanceLookupUrl,
  pickFirstSagaInstanceId,
} from './sagaInstanceLink'
import { resolveDynamicId } from '../../../../lib/dynamicParams'

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
  licenseStartDate: string | null
  licenseEndDate: string | null
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
        <DealEditor deal={deal} onSaved={() => void load()} />
        <LifecycleMetadata deal={deal} />

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

const editSchema = z.object({
  clientCompanyName: z.string().min(1).max(200),
  clientIndustry: z.string().max(120).optional(),
  type: z.string().max(40).optional(),
  isRenewal: z.boolean().optional(),
  annualValueUsd: z.string().optional(),
  monthlyLicenseAmount: z.string().optional(),
  licenseStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'prm.licenseDeals.errors.invalidDate')
    .or(z.literal(''))
    .optional(),
  licenseEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'prm.licenseDeals.errors.invalidDate')
    .or(z.literal(''))
    .optional(),
  notes: z.string().max(10_000).optional(),
})

type EditValues = z.infer<typeof editSchema>

function DealEditor({ deal, onSaved }: { deal: LicenseDeal; onSaved: () => void }) {
  const t = useT()
  const initialValues: EditValues = {
    clientCompanyName: deal.clientCompanyName,
    clientIndustry: deal.clientIndustry ?? '',
    type: deal.type,
    isRenewal: deal.isRenewal,
    annualValueUsd: deal.annualValueUsd ?? '',
    monthlyLicenseAmount: deal.monthlyLicenseAmount ?? '',
    licenseStartDate: deal.licenseStartDate ?? '',
    licenseEndDate: deal.licenseEndDate ?? '',
    notes: deal.notes ?? '',
  }
  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.detail.overview', 'Overview')}
      </h3>
      <CrudForm<EditValues>
        // Re-mount when the deal version changes so initialValues update after save.
        key={`${deal.id}:${deal.version}`}
        schema={editSchema}
        initialValues={initialValues}
        fields={[
          {
            id: 'licenseIdentifier',
            label: t('prm.licenseDeals.fields.identifier', 'License identifier'),
            type: 'text',
            disabled: true,
            layout: 'half',
            description: t(
              'prm.licenseDeals.fields.identifier.autoHelp',
              'Auto-assigned by the system on create — not editable.',
            ),
            defaultValue: deal.licenseIdentifier,
          },
          {
            id: 'clientCompanyName',
            label: t('prm.licenseDeals.fields.client', 'Client company name'),
            type: 'text',
            required: true,
            layout: 'half',
          },
          {
            id: 'clientIndustry',
            label: t('prm.licenseDeals.fields.industry', 'Client industry'),
            type: 'text',
            layout: 'half',
          },
          {
            id: 'type',
            label: t('prm.licenseDeals.fields.type', 'Type'),
            type: 'select',
            layout: 'half',
            options: [{ value: 'enterprise', label: 'Enterprise' }],
          },
          {
            id: 'isRenewal',
            label: t('prm.licenseDeals.fields.isRenewal', 'Renewal'),
            type: 'checkbox',
          },
          {
            id: 'annualValueUsd',
            label: t('prm.licenseDeals.fields.annualValueUsd', 'Annual value (USD)'),
            type: 'text',
            layout: 'half',
            placeholder: '120000.00',
          },
          {
            id: 'monthlyLicenseAmount',
            label: t('prm.licenseDeals.fields.monthlyLicenseAmount', 'Monthly license amount (USD)'),
            type: 'text',
            layout: 'half',
            placeholder: '10000.00',
          },
          {
            id: 'licenseStartDate',
            label: t('prm.licenseDeals.fields.licenseStartDate', 'License start date'),
            type: 'text',
            layout: 'half',
            placeholder: 'YYYY-MM-DD',
            description: t(
              'prm.licenseDeals.fields.licenseStartDate.help',
              'When the licence becomes effective. Optional.',
            ),
          },
          {
            id: 'licenseEndDate',
            label: t('prm.licenseDeals.fields.licenseEndDate', 'License end date'),
            type: 'text',
            layout: 'half',
            placeholder: 'YYYY-MM-DD',
            description: t(
              'prm.licenseDeals.fields.licenseEndDate.help',
              'When the licence term ends. Leave empty for open-ended.',
            ),
          },
          {
            id: 'notes',
            label: t('prm.licenseDeals.fields.notes', 'Internal notes'),
            type: 'textarea',
          },
        ]}
        submitLabel={t('prm.licenseDeals.detail.save', 'Save changes')}
        onSubmit={async (values) => {
          const payload: Record<string, unknown> = {
            clientCompanyName: values.clientCompanyName,
            clientIndustry: values.clientIndustry ? values.clientIndustry : null,
            type: values.type ?? 'enterprise',
            isRenewal: values.isRenewal ?? false,
            annualValueUsd: values.annualValueUsd ? values.annualValueUsd : null,
            monthlyLicenseAmount: values.monthlyLicenseAmount
              ? values.monthlyLicenseAmount
              : null,
            licenseStartDate: values.licenseStartDate ? values.licenseStartDate : null,
            licenseEndDate: values.licenseEndDate ? values.licenseEndDate : null,
            notes: values.notes ? values.notes : null,
            ifMatchVersion: deal.version,
          }
          await apiCallOrThrow(`/api/prm/license-deal/${deal.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }, {
            errorMessage: t('prm.licenseDeals.detail.saveError', 'Failed to save changes.'),
          })
          flash(t('prm.licenseDeals.detail.saved', 'License deal saved.'), 'success')
          onSaved()
        }}
      />
    </section>
  )
}

function LifecycleMetadata({ deal }: { deal: LicenseDeal }) {
  const t = useT()
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
  return (
    <section className="mb-6 rounded-md border bg-muted/20 p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.detail.lifecycle', 'Lifecycle')}
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Row label={t('prm.licenseDeals.fields.status', 'Status')} value={deal.status} />
        <Row
          label={t('prm.licenseDeals.fields.path', 'Attribution path')}
          value={t(`prm.licenseDeals.path.${deal.attributionPath}`, deal.attributionPath)}
        />
        <Row
          label={t('prm.licenseDeals.fields.signedAt', 'Signed at')}
          value={fmt(deal.signedAt)}
        />
        <Row
          label={t('prm.licenseDeals.fields.closedAt', 'Closed at')}
          value={fmt(deal.closedAt)}
        />
        <Row
          label={t('prm.licenseDeals.fields.attributedAt', 'Attributed at')}
          value={fmt(deal.attributedAt)}
        />
        <Row
          label={t('prm.licenseDeals.fields.version', 'Version')}
          value={String(deal.version)}
        />
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
        <Alert variant="info" className="mt-3">
          <AlertTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('prm.licenseDeals.fields.attributionReasoning', 'Attribution reasoning')}
          </AlertTitle>
          <AlertDescription className="mt-1 whitespace-pre-wrap">
            {deal.attributionReasoning}
          </AlertDescription>
        </Alert>
      ) : null}
      <SagaInstanceLink deal={deal} />
    </section>
  )
}

/**
 * Lookup the `prm.license_deal.attribution_saga` workflow instance for this
 * deal and render a link to `/backend/workflows/instances/{id}` (the core
 * workflows module's retry/cancel page).
 *
 * Strictly additive — renders nothing when:
 *   - the lookup returns no result (older deals attributed before the saga
 *     existed, or the workflow runtime is disabled),
 *   - the API call fails (401, 404, network),
 *   - the deal is unattributed (parent already gates this on `isAttributed`).
 *
 * Saga correlation key shape: `{licenseDealId}:{attributionSource}` — see
 * `licenseDealCorrelationKey()` in `data/validators.ts`.
 */
function SagaInstanceLink({ deal }: { deal: LicenseDeal }) {
  const t = useT()
  const [instanceId, setInstanceId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function lookup() {
      try {
        const url = buildSagaInstanceLookupUrl({
          licenseDealId: deal.id,
          attributionSource: deal.attributionSource,
        })
        const res = await apiCall<{ data?: Array<{ id: string }> }>(url)
        if (cancelled) return
        if (res.ok) {
          const picked = pickFirstSagaInstanceId(res.result ?? null)
          if (picked) setInstanceId(picked)
        }
      } catch {
        // Soft-fail: link is silent additive surface; no error UI.
      }
    }
    void lookup()
    return () => {
      cancelled = true
    }
  }, [deal.id, deal.attributionSource])

  if (!instanceId) return null

  return (
    <div className="mt-3 text-sm" data-testid="b5-saga-instance-link">
      <Link
        href={`/backend/workflows/instances/${instanceId}`}
        className="text-primary underline-offset-4 hover:underline"
      >
        {t(
          'prm.licenseDeals.attribution.sagaLink.label',
          'View attribution saga (retry / cancel)',
        )}
      </Link>
    </div>
  )
}

type PathTab = 'A' | 'B'

type AgencyLite = {
  id: string
  name: string
  slug: string
  tier: string
  status: string
  headquartersCity: string | null
}

type RfpLite = {
  id: string
  title: string
  status: string
  selectedAgencyId: string | null
  receivedFrom: string | null
  closedAt: string | null
}

type ProspectLite = {
  id: string
  agencyId: string
  agencyName: string | null
  companyName: string
  contactName: string
  contactEmail: string
  status: string
  registeredAt: string
}

function AttributionPicker({ deal, onAttributed }: { deal: LicenseDeal; onAttributed: () => void }) {
  const t = useT()
  const [activeTab, setActiveTab] = React.useState<PathTab>('A')
  const [agencyMap, setAgencyMap] = React.useState<Map<string, AgencyLite>>(() => new Map())

  React.useEffect(() => {
    let cancelled = false
    async function loadAgencies() {
      const res = await apiCall<{ ok: true; items: AgencyLite[] }>(
        '/api/prm/agency?pageSize=100&status=active',
      )
      if (cancelled) return
      if (res.ok && res.result?.items) {
        setAgencyMap(new Map(res.result.items.map((a) => [a.id, a])))
      }
    }
    void loadAgencies()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="mb-6 rounded-md border bg-card p-4">
      <h3 className="mb-2 text-base font-semibold">
        {t('prm.licenseDeals.attribute.title', 'Attribute this license')}
      </h3>
      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.description',
          "Attribute the deal to the partner agency that brought this client — either via a prospect they registered or an RFP they won. Leave it unattributed if no partner is involved — that's tracked as a direct OM sale.",
        )}
      </p>
      <div
        className="mb-4 flex gap-1 border-b"
        role="tablist"
        aria-label={t('prm.licenseDeals.attribute.title', 'Attribute this license')}
      >
        {(['A', 'B'] as PathTab[]).map((tab) => (
          <Button
            key={tab}
            type="button"
            variant="ghost"
            size="sm"
            role="tab"
            aria-selected={activeTab === tab}
            className={cn(
              '-mb-px h-auto rounded-none border-b-2 px-3 py-1 text-sm font-medium hover:bg-transparent',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab(tab)}
          >
            {t(`prm.licenseDeals.path.${tab}`, defaultPathLabel(tab))}
          </Button>
        ))}
      </div>
      {activeTab === 'A' ? (
        <PartnerProspectPicker deal={deal} onAttributed={onAttributed} agencyMap={agencyMap} />
      ) : (
        <PathBPicker deal={deal} onAttributed={onAttributed} agencyMap={agencyMap} />
      )}
    </section>
  )
}

function defaultPathLabel(tab: PathTab): string {
  switch (tab) {
    case 'A':
      return "Partner's Prospect"
    case 'B':
      return 'From a won RFP'
  }
}

function PartnerProspectPicker({
  deal,
  onAttributed,
  agencyMap,
}: {
  deal: LicenseDeal
  onAttributed: () => void
  agencyMap: Map<string, AgencyLite>
}) {
  const t = useT()
  // Golden-Rule default (oldest non-lost prospect matching the license client by
  // normalized company name). Required by the attribute API for override
  // detection. Fetched once on mount.
  const [goldenDefaultId, setGoldenDefaultId] = React.useState<string | null>(null)
  const [defaultLoading, setDefaultLoading] = React.useState(true)

  const [prospects, setProspects] = React.useState<ProspectLite[]>([])
  const [loadingProspects, setLoadingProspects] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [picked, setPicked] = React.useState<string | null>(null)
  const [reasoning, setReasoning] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiCall<CandidatesResponse>(
      `/api/prm/license-deal/golden-rule-candidates?clientCompanyName=${encodeURIComponent(
        deal.clientCompanyName,
      )}`,
    )
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.result?.ok) {
          const def = res.result.candidates.find((c) => c.isDefaultPick)?.prospectId ?? null
          setGoldenDefaultId(def)
          if (def) setPicked((cur) => cur ?? def)
        }
      })
      .finally(() => {
        if (!cancelled) setDefaultLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [deal.clientCompanyName])

  // Search prospects, debounced. Empty search → prospects matching this license's
  // client by normalized company name. Non-empty → free-text across all WIPs.
  React.useEffect(() => {
    let cancelled = false
    setLoadingProspects(true)
    const handle = window.setTimeout(async () => {
      const params = new URLSearchParams({ pageSize: '50' })
      const trimmed = search.trim()
      if (trimmed.length > 0) {
        params.set('q', trimmed)
      } else if (deal.clientCompanyName) {
        params.set('normalizedCompanyName', deal.clientCompanyName)
      }
      const res = await apiCall<{ ok: true; items: ProspectLite[] }>(
        `/api/prm/prospects?${params.toString()}`,
      )
      if (cancelled) return
      if (res.ok && res.result?.items) setProspects(res.result.items)
      else setProspects([])
      setLoadingProspects(false)
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [search, deal.clientCompanyName])

  const isOverride =
    picked !== null && goldenDefaultId !== null && picked !== goldenDefaultId

  async function submit() {
    if (!picked) {
      setError(
        t('prm.licenseDeals.attribute.A.errors.prospectRequired', 'Pick a prospect first.'),
      )
      return
    }
    if (isOverride && reasoning.trim().length === 0) {
      setError(
        t(
          'prm.licenseDeals.attribute.errors.reasoningRequired',
          'Reasoning required when choosing a different match.',
        ),
      )
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // When no Golden-Rule default exists, submit the picked prospect as its
      // own "default" — the server requires a UUID and override-detection
      // cleanly resolves to false.
      const defaultForApi = goldenDefaultId ?? picked
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attribution_path: 'A',
          prospect_id: picked,
          golden_rule_default_prospect_id: defaultForApi,
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

  const pickedRow = picked ? prospects.find((p) => p.id === picked) : null
  const pickedAgencyName =
    pickedRow?.agencyName ?? (pickedRow ? agencyMap.get(pickedRow.agencyId)?.name ?? null : null)

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.A.intro',
          "Search across every prospect (WIP) any partner has registered. Pre-filled with prospects that match this license's client name — type to broaden the search.",
        )}
      </p>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t(
          'prm.licenseDeals.attribute.A.searchPlaceholder',
          'Search prospects by company, contact, or email…',
        )}
      />
      {defaultLoading || loadingProspects ? (
        <LoadingMessage label={t('prm.licenseDeals.attribute.A.loading', 'Loading prospects…')} />
      ) : prospects.length === 0 && search.trim().length > 0 ? (
        <Alert variant="info">
          <AlertDescription>
            {t('prm.licenseDeals.attribute.A.searchEmpty', 'No prospects match your search.')}
          </AlertDescription>
        </Alert>
      ) : prospects.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t(
              'prm.licenseDeals.attribute.A.empty',
              "No partner has registered a prospect matching this client. Try searching for the client under a different name, or use 'From a won RFP'.",
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="divide-y rounded-md border" role="radiogroup">
          {prospects.map((p) => {
            const agencyName = p.agencyName ?? agencyMap.get(p.agencyId)?.name ?? null
            const registered = new Date(p.registeredAt)
            const ageDays = Math.max(
              0,
              Math.floor((Date.now() - registered.getTime()) / 86_400_000),
            )
            const isSuggested = goldenDefaultId === p.id
            return (
              <li
                key={p.id}
                role="radio"
                aria-checked={picked === p.id}
                tabIndex={0}
                onClick={() => setPicked(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setPicked(p.id)
                  }
                }}
                className={cn(
                  'flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40',
                  picked === p.id && 'bg-muted/60',
                )}
              >
                <input
                  type="radio"
                  checked={picked === p.id}
                  readOnly
                  className="mt-1"
                  aria-label={p.companyName}
                  tabIndex={-1}
                />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.companyName}</span>
                    {isSuggested ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {t('prm.licenseDeals.attribute.A.suggestedBadge', 'Suggested match')}
                      </span>
                    ) : null}
                    {p.status === 'lost' ? (
                      <StatusBadge variant="error">
                        {t('prm.licenseDeals.attribute.A.lostBadge', 'LOST')}
                      </StatusBadge>
                    ) : (
                      <span className="rounded-full border px-2 py-0.5 text-xs">{p.status}</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('prm.licenseDeals.attribute.A.registeredBy', 'Registered by')}{' '}
                    <span className="font-medium text-foreground">
                      {agencyName ?? `agency ${p.agencyId.slice(0, 8)}…`}
                    </span>{' '}
                    {t('prm.licenseDeals.attribute.A.onDate', 'on')}{' '}
                    {registered.toLocaleDateString()}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {p.contactName} · {p.contactEmail}
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {t('prm.licenseDeals.attribute.A.ageDays', '{days} days old').replace(
                    '{days}',
                    String(ageDays),
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {isOverride ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t(
              'prm.licenseDeals.attribute.A.reasoningLabel',
              'Reasoning (required when choosing anything other than the suggested match)',
            )}
          </span>
          <Textarea
            className="min-h-[5rem]"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            placeholder={t(
              'prm.licenseDeals.attribute.A.reasoningPlaceholder',
              'Why is this partner being attributed instead of the suggested match?',
            )}
          />
        </label>
      ) : null}
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex items-center justify-end gap-3">
        {pickedAgencyName ? (
          <span className="mr-auto text-xs text-muted-foreground">
            {t('prm.licenseDeals.attribute.A.summary', 'Attributing to {agency}.').replace(
              '{agency}',
              pickedAgencyName,
            )}
          </span>
        ) : null}
        <Button onClick={submit} disabled={submitting || !picked}>
          {t('prm.licenseDeals.attribute.A.submit', 'Attribute to this partner')}
        </Button>
      </div>
    </div>
  )
}

function PathBPicker({
  deal,
  onAttributed,
  agencyMap,
}: {
  deal: LicenseDeal
  onAttributed: () => void
  agencyMap: Map<string, AgencyLite>
}) {
  const t = useT()
  const [search, setSearch] = React.useState('')
  const [rfps, setRfps] = React.useState<RfpLite[]>([])
  const [loading, setLoading] = React.useState(false)
  const [pickedRfpId, setPickedRfpId] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const params = new URLSearchParams({ pageSize: '50' })
        if (search.trim().length > 0) params.set('q', search.trim())
        const res = await apiCall<{ ok: true; items: RfpLite[] }>(
          `/api/prm/rfp?${params.toString()}`,
        )
        if (cancelled) return
        if (res.ok && res.result?.items) {
          // Only RFPs with a selected winner are valid for Path B.
          setRfps(res.result.items.filter((r) => r.selectedAgencyId != null))
        }
      } catch {
        // soft-fail; show empty state below.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const handle = window.setTimeout(() => void load(), 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [search])

  async function submit() {
    if (!pickedRfpId) {
      setError(t('prm.licenseDeals.attribute.B.errors.rfpRequired', 'Pick an RFP first.'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}/attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attribution_path: 'B', rfp_id: pickedRfpId }),
      })
      flash(t('prm.licenseDeals.attribute.flash.success', 'License deal attributed.'), 'success')
      onAttributed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attribute')
    } finally {
      setSubmitting(false)
    }
  }

  const pickedRfp = pickedRfpId ? rfps.find((r) => r.id === pickedRfpId) : null
  const pickedWinner = pickedRfp?.selectedAgencyId
    ? agencyMap.get(pickedRfp.selectedAgencyId)?.name
    : null

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t(
          'prm.licenseDeals.attribute.B.intro',
          'Only RFPs that already have a selected winner are shown. The deal gets attributed to that winning agency.',
        )}
      </p>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('prm.licenseDeals.attribute.B.searchPlaceholder', 'Search RFPs by title…')}
      />
      {loading ? (
        <LoadingMessage label={t('prm.licenseDeals.attribute.B.loading', 'Searching RFPs…')} />
      ) : rfps.length === 0 ? (
        <Alert variant="info">
          <AlertDescription>
            {t(
              'prm.licenseDeals.attribute.B.empty',
              'No RFPs with a selected winner match your search.',
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="divide-y rounded-md border" role="radiogroup">
          {rfps.map((r) => {
            const winnerName = r.selectedAgencyId
              ? agencyMap.get(r.selectedAgencyId)?.name ?? null
              : null
            return (
              <li
                key={r.id}
                role="radio"
                aria-checked={pickedRfpId === r.id}
                tabIndex={0}
                onClick={() => setPickedRfpId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setPickedRfpId(r.id)
                  }
                }}
                className={cn(
                  'flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40',
                  pickedRfpId === r.id && 'bg-muted/60',
                )}
              >
                <input
                  type="radio"
                  checked={pickedRfpId === r.id}
                  readOnly
                  className="mt-1"
                  aria-label={r.title}
                  tabIndex={-1}
                />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.title}</span>
                    <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                      {r.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('prm.licenseDeals.attribute.B.winner', 'Winner:')}{' '}
                    <span className="font-medium text-foreground">
                      {winnerName ?? r.selectedAgencyId?.slice(0, 8) ?? '—'}
                    </span>
                    {r.receivedFrom ? (
                      <>
                        {' · '}
                        {t('prm.licenseDeals.attribute.B.client', 'Client:')}{' '}
                        <span className="text-foreground">{r.receivedFrom}</span>
                      </>
                    ) : null}
                  </div>
                  {r.closedAt ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t('prm.licenseDeals.attribute.B.closedAt', 'Closed')}{' '}
                      {new Date(r.closedAt).toLocaleDateString()}
                    </div>
                  ) : null}
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {r.id.slice(0, 8)}…
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex items-center justify-end gap-3">
        {pickedWinner ? (
          <span className="mr-auto text-xs text-muted-foreground">
            {t(
              'prm.licenseDeals.attribute.B.summary',
              'Attributing to the RFP winner — {agency}.',
            ).replace('{agency}', pickedWinner)}
          </span>
        ) : null}
        <Button onClick={submit} disabled={submitting || !pickedRfpId}>
          {t('prm.licenseDeals.attribute.B.submit', 'Attribute to the RFP winner')}
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
  const [softDeleteOpen, setSoftDeleteOpen] = React.useState(false)

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
    setBusy(true)
    setError(null)
    try {
      await apiCallOrThrow(`/api/prm/license-deal/${deal.id}`, { method: 'DELETE' })
      flash(t('prm.licenseDeals.delete.flash.success', 'License deal deleted.'), 'success')
      setSoftDeleteOpen(false)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  const softDeleteCopy: ConfirmDialogCopy = {
    title: t('prm.licenseDeals.delete.dialog.title', 'Delete license deal?'),
    body: t(
      'prm.licenseDeals.delete.dialog.body',
      'Soft-delete this pending license deal? The record stays in the database for audit but disappears from active views. Only pending deals can be deleted.',
    ),
    cancel: t('prm.licenseDeals.delete.dialog.cancel', 'Cancel'),
    confirm: t('prm.licenseDeals.delete.dialog.confirm', 'Delete (soft)'),
    saving: t('prm.licenseDeals.delete.dialog.saving', 'Deleting…'),
  }

  return (
    <section className="mt-6 rounded-md border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {t('prm.licenseDeals.actions.title', 'Actions')}
      </h3>
      {error ? <ErrorMessage label={error} /> : null}
      <div className="flex flex-wrap gap-2">
        {deal.status === 'pending' && deal.attributionPath === 'none' ? (
          <Button onClick={() => transition('signed')} disabled={busy}>
            {t(
              'prm.licenseDeals.actions.markSignedDirect',
              'Mark signed (direct OM sale)',
            )}
          </Button>
        ) : null}
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
          <Button onClick={() => setSoftDeleteOpen(true)} disabled={busy} variant="destructive">
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
      <ConfirmDialog
        open={softDeleteOpen}
        copy={softDeleteCopy}
        busy={busy}
        onConfirm={() => void softDelete()}
        onCancel={() => setSoftDeleteOpen(false)}
        testId="soft-delete-dialog"
      />
    </section>
  )
}
