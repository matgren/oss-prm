'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * Reusable Case Study form (P8 — Spec #7 §3.1).
 *
 * Plain Textarea + "Markdown supported" hint per the same R1 mitigation
 * Spec #5 ships (no markdown editor primitive in @open-mercato/ui v0.5.0).
 * Promote to a real editor when one lands.
 */

export type CaseStudyFormValues = {
  title: string
  clientName: string
  clientIndustry: string
  clientCountry: string
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string
  servicesDelivered: string
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
  technologiesUsed: '',
  servicesDelivered: '',
}

function splitCsv(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function joinCsv(input: string[] | undefined | null): string {
  return (input ?? []).join(', ')
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

  const update = (key: keyof CaseStudyFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

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
      technologiesUsed: splitCsv(values.technologiesUsed),
      servicesDelivered: splitCsv(values.servicesDelivered),
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
            {t('prm.portal.caseStudies.form.technologies', 'Technologies (comma-separated slugs)')}
          </span>
          <Input value={values.technologiesUsed} onChange={(e) => update('technologiesUsed', e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide">
            {t('prm.portal.caseStudies.form.services', 'Services (comma-separated slugs)')}
          </span>
          <Input value={values.servicesDelivered} onChange={(e) => update('servicesDelivered', e.target.value)} />
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
    technologiesUsed: joinCsv(dto.technologiesUsed),
    servicesDelivered: joinCsv(dto.servicesDelivered),
  }
}
