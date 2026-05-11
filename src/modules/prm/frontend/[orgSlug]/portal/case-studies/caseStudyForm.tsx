'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { TagsInput, type TagsInputOption } from '@open-mercato/ui/backend/inputs/TagsInput'
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { COUNTRIES, resolveCountryLabel } from '../../../../lib/countries'

/**
 * Reusable Case Study form (P8 — Spec #7 §3.1).
 *
 * Plain Textarea + "Markdown supported" hint per the same R1 mitigation
 * Spec #5 ships (no markdown editor primitive in @open-mercato/ui v0.5.0).
 * Promote to a real editor when one lands.
 *
 * Tag fields (technologies, services) use the platform `TagsInput` with
 * suggestions loaded from the per-agency portal endpoint
 * (`/api/prm/portal/agency/<id>/tag-suggestions?field=...`). Open vocabulary
 * per SPEC-2026-05-11 — type-and-enter chips; suggestions are the union of
 * the caller agency's profile tags + own case-study tags. Caller agency id
 * is resolved once via `/api/prm/portal/me`.
 */

export type CaseStudyFormValues = {
  title: string
  clientName: string
  clientIndustry: string
  clientCountry: string
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
}

export type CaseStudyFormProps = {
  mode: 'create' | 'edit'
  caseStudyId?: string
  initial?: Partial<CaseStudyFormValues>
  onSuccess?: (id: string) => void
}

const EMPTY: CaseStudyFormValues = {
  title: '',
  clientName: '',
  clientIndustry: '',
  clientCountry: '',
  challengeMarkdown: '',
  approachMarkdown: '',
  outcomeMarkdown: '',
  technologiesUsed: [],
  servicesDelivered: [],
}

type TagSuggestionsResponse = {
  ok: true
  items: TagsInputOption[]
}

type PortalMeResponse = {
  ok: true
  agency: { id: string } | null
  member: unknown
}

/**
 * Resolve the caller's agency id once per form mount. `null` when the customer
 * user is not yet linked to an AgencyMember — the form still renders, suggestion
 * fetch silently degrades (per the existing TagsInput failure pattern), and the
 * customer types tags freely without autocomplete.
 */
async function fetchCallerAgencyId(): Promise<string | null> {
  const res = await apiCall<PortalMeResponse>('/api/prm/portal/me')
  if (!res.ok || !res.result || !('agency' in res.result)) return null
  return (res.result as PortalMeResponse).agency?.id ?? null
}

async function fetchAgencyTagSuggestions(
  agencyId: string,
  field: 'technologies' | 'services',
): Promise<TagsInputOption[]> {
  const res = await apiCall<TagSuggestionsResponse>(
    `/api/prm/portal/agency/${encodeURIComponent(agencyId)}/tag-suggestions?field=${encodeURIComponent(field)}`,
  )
  if (!res.ok || !res.result || !Array.isArray((res.result as TagSuggestionsResponse).items)) {
    return []
  }
  return (res.result as TagSuggestionsResponse).items
}

export function CaseStudyForm({
  mode,
  caseStudyId,
  initial,
  onSuccess,
}: CaseStudyFormProps) {
  const t = useT()
  const [values, setValues] = React.useState<CaseStudyFormValues>({ ...EMPTY, ...initial })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const update = <K extends keyof CaseStudyFormValues>(
    key: K,
    value: CaseStudyFormValues[K],
  ) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  // Load per-agency tag suggestions once on mount and pass as static
  // `suggestions` to TagsInput so it filters client-side. Avoids the
  // per-keystroke debounced refetch loop. Open-vocab per SPEC-2026-05-11.
  const [techOptions, setTechOptions] = React.useState<TagsInputOption[]>([])
  const [servicesOptions, setServicesOptions] = React.useState<TagsInputOption[]>([])
  // Closed-vocab industries dictionary — single-select Combobox source.
  // SPEC-2026-05-11 §2.2 preserves `industries` as closed-vocab; the typeahead
  // here is UX-only, not a vocab change.
  const [industryOptions, setIndustryOptions] = React.useState<ComboboxOption[]>([])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const agencyId = await fetchCallerAgencyId()
        if (cancelled) return
        if (!agencyId) return // not yet linked — empty suggestions; open vocab allows free typing
        const [tech, services] = await Promise.all([
          fetchAgencyTagSuggestions(agencyId, 'technologies'),
          fetchAgencyTagSuggestions(agencyId, 'services'),
        ])
        if (cancelled) return
        setTechOptions(tech)
        setServicesOptions(services)
      } catch {
        // Silently degrade — TagsInput still works with empty suggestions
        // because open vocab (allowCustomValues default = true) permits free
        // type-and-enter even with no autocomplete chips.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Industries dictionary — closed-vocab, pre-loaded once on mount.
  React.useEffect(() => {
    let cancelled = false
    void apiCall<{ ok: true; items: Array<{ value: string; label: string }> }>(
      '/api/prm/portal/dictionaries/industries/entries',
    )
      .then((res) => {
        if (cancelled) return
        const items = res.result?.items ?? []
        setIndustryOptions(items.map((i) => ({ value: i.value, label: i.label })))
      })
      .catch(() => {
        // Silent degrade — empty industry picker. Closed-vocab means
        // user can't type a free value; they'll see "no matches" until
        // the dictionary is seeded (run `tsx scripts/reseed-prm-dictionaries.ts`).
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload = {
      title: values.title.trim(),
      clientName: values.clientName.trim(),
      clientIndustry: values.clientIndustry.trim() || null,
      clientCountry: values.clientCountry.trim() || null,
      challengeMarkdown: values.challengeMarkdown,
      approachMarkdown: values.approachMarkdown,
      outcomeMarkdown: values.outcomeMarkdown,
      technologiesUsed: values.technologiesUsed,
      servicesDelivered: values.servicesDelivered,
    }
    try {
      const url =
        mode === 'create'
          ? '/api/prm/portal/case-study'
          : `/api/prm/portal/case-study/${caseStudyId}`
      const res = await apiCall<{ ok: true; caseStudy: { id: string } }>(url, {
        method: mode === 'create' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok || !res.result || !('caseStudy' in res.result)) {
        const errObj = res.result && typeof (res.result as any).error === 'object'
          ? ((res.result as any).error as { message?: string } | null)
          : null
        const message =
          errObj?.message ??
          t('prm.portal.caseStudies.form.flash.error', 'Could not save case study.')
        throw new Error(message)
      }
      flash(
        t(
          mode === 'create'
            ? 'prm.portal.caseStudies.form.flash.created'
            : 'prm.portal.caseStudies.form.flash.updated',
          'Saved.',
        ),
        'success',
      )
      onSuccess?.(res.result.caseStudy.id)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.portal.caseStudies.form.flash.error', 'Could not save case study.'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.titleField', 'Title')}
          </span>
          <Input value={values.title} onChange={(e) => update('title', e.target.value)} required />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.clientName', 'Client name')}
          </span>
          <Input value={values.clientName} onChange={(e) => update('clientName', e.target.value)} required />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.clientIndustry', 'Client industry')}
          </span>
          <ComboboxInput
            value={values.clientIndustry}
            onChange={(next) => update('clientIndustry', next)}
            suggestions={industryOptions}
            allowCustomValues={false}
            placeholder={t(
              'prm.portal.caseStudies.form.clientIndustry.placeholder',
              'Type to search…',
            )}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.clientCountry', 'Client country')}
          </span>
          <ComboboxInput
            value={values.clientCountry.toUpperCase()}
            onChange={(next) => update('clientCountry', next.toUpperCase())}
            suggestions={COUNTRIES as unknown as ComboboxOption[]}
            resolveLabel={resolveCountryLabel}
            allowCustomValues={false}
            placeholder={t(
              'prm.portal.caseStudies.form.clientCountry.placeholder',
              'Type country name or ISO code…',
            )}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide">
          {t('prm.portal.caseStudies.form.challenge', 'Challenge')}
        </span>
        <Textarea
          rows={6}
          value={values.challengeMarkdown}
          onChange={(e) => update('challengeMarkdown', e.target.value)}
          required
        />
        <span className="text-xs text-muted-foreground">
          {t('prm.portal.caseStudies.form.markdownHint', 'Markdown supported.')}
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide">
          {t('prm.portal.caseStudies.form.approach', 'Approach')}
        </span>
        <Textarea
          rows={6}
          value={values.approachMarkdown}
          onChange={(e) => update('approachMarkdown', e.target.value)}
          required
        />
        <span className="text-xs text-muted-foreground">
          {t('prm.portal.caseStudies.form.markdownHint', 'Markdown supported.')}
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide">
          {t('prm.portal.caseStudies.form.outcome', 'Outcome')}
        </span>
        <Textarea
          rows={6}
          value={values.outcomeMarkdown}
          onChange={(e) => update('outcomeMarkdown', e.target.value)}
          required
        />
        <span className="text-xs text-muted-foreground">
          {t('prm.portal.caseStudies.form.markdownHint', 'Markdown supported.')}
        </span>
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.technologies', 'Technologies')}
          </span>
          <TagsInput
            value={values.technologiesUsed}
            onChange={(next) => update('technologiesUsed', next)}
            suggestions={techOptions}
            placeholder={t('prm.portal.caseStudies.form.technologies.placeholder', 'Type to add a technology…')}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.services', 'Services')}
          </span>
          <TagsInput
            value={values.servicesDelivered}
            onChange={(next) => update('servicesDelivered', next)}
            suggestions={servicesOptions}
            placeholder={t('prm.portal.caseStudies.form.services.placeholder', 'Type to add a service…')}
          />
        </label>
      </div>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving
            ? t('prm.portal.caseStudies.form.saving', 'Saving…')
            : t('prm.portal.caseStudies.form.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}

export function caseStudyDtoToFormValues(dto: {
  title: string
  clientName: string
  clientIndustry: string | null
  clientCountry: string | null
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
}): CaseStudyFormValues {
  return {
    title: dto.title,
    clientName: dto.clientName,
    clientIndustry: dto.clientIndustry ?? '',
    clientCountry: dto.clientCountry ?? '',
    challengeMarkdown: dto.challengeMarkdown,
    approachMarkdown: dto.approachMarkdown,
    outcomeMarkdown: dto.outcomeMarkdown,
    technologiesUsed: Array.isArray(dto.technologiesUsed) ? [...dto.technologiesUsed] : [],
    servicesDelivered: Array.isArray(dto.servicesDelivered) ? [...dto.servicesDelivered] : [],
  }
}
