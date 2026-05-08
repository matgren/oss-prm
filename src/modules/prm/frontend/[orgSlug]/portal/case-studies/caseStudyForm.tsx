'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { TagsInput, type TagsInputOption } from '@open-mercato/ui/backend/inputs/TagsInput'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * Reusable Case Study form (P8 — Spec #7 §3.1).
 *
 * Plain Textarea + "Markdown supported" hint per the same R1 mitigation
 * Spec #5 ships (no markdown editor primitive in @open-mercato/ui v0.5.0).
 * Promote to a real editor when one lands.
 *
 * Tag fields (technologies, services) use the platform `TagsInput` with
 * suggestions loaded from PRM's portal-scoped dictionary endpoint
 * (`/api/prm/portal/dictionaries/<key>/entries`). Closed list:
 * `allowCustomValues={false}` — taxonomy is governed by OMPartnerOps
 * via the backend dictionaries UI to keep marketing-library / RFP
 * matching consistent.
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

type DictionaryEntriesResponse = {
  ok: true
  items: TagsInputOption[]
}

async function fetchDictionaryEntries(key: 'technologies' | 'services'): Promise<TagsInputOption[]> {
  const res = await apiCall<DictionaryEntriesResponse>(
    `/api/prm/portal/dictionaries/${encodeURIComponent(key)}/entries`,
  )
  if (!res.ok || !res.result || !Array.isArray((res.result as DictionaryEntriesResponse).items)) {
    return []
  }
  return (res.result as DictionaryEntriesResponse).items
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

  // Load dictionaries once on mount and pass as static `suggestions` to
  // TagsInput so it filters client-side. Avoids the per-keystroke debounced
  // refetch loop that flashes "Loading…" and re-renders the dropdown.
  const [techOptions, setTechOptions] = React.useState<TagsInputOption[]>([])
  const [servicesOptions, setServicesOptions] = React.useState<TagsInputOption[]>([])

  React.useEffect(() => {
    let cancelled = false
    void Promise.all([fetchDictionaryEntries('technologies'), fetchDictionaryEntries('services')])
      .then(([tech, services]) => {
        if (cancelled) return
        setTechOptions(tech)
        setServicesOptions(services)
      })
      .catch(() => {
        // Silently degrade — TagsInput still works with empty suggestions
        // when allowCustomValues=false (just no picker).
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
            {t('prm.portal.caseStudies.form.clientIndustry', 'Industry slug')}
          </span>
          <Input value={values.clientIndustry} onChange={(e) => update('clientIndustry', e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.clientCountry', 'Country code')}
          </span>
          <Input value={values.clientCountry} onChange={(e) => update('clientCountry', e.target.value)} />
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
            allowCustomValues={false}
            placeholder={t('prm.portal.caseStudies.form.technologies.placeholder', 'Pick technologies…')}
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
            allowCustomValues={false}
            placeholder={t('prm.portal.caseStudies.form.services.placeholder', 'Pick services…')}
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
