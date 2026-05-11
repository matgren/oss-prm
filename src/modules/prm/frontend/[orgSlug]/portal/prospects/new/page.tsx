'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

type Props = { params: { orgSlug: string } }

/**
 * P5b — Standalone prospect registration page.
 *
 * Source is a closed-vocab combobox (FROZEN per Spec #3 — `agency_owned` |
 * `event` | `other`); only `agency_owned` counts toward WIP per invariant #14,
 * so free-text would silently undercount.
 */
export default function NewProspectPage({ params }: Props) {
  const t = useT()
  const router = useRouter()
  const orgSlug = params.orgSlug
  const listHref = `/${orgSlug}/portal/prospects`

  const [values, setValues] = React.useState({
    companyName: '',
    contactName: '',
    contactEmail: '',
    source: 'agency_owned',
    notes: '',
  })
  const [submitting, setSubmitting] = React.useState(false)

  const sourceOptions = React.useMemo<ComboboxOption[]>(
    () => [
      { value: 'agency_owned', label: t('prm.portal.prospects.source.agency_owned', 'Agency-owned') },
      { value: 'event', label: t('prm.portal.prospects.source.event', 'Event') },
      { value: 'other', label: t('prm.portal.prospects.source.other', 'Other') },
    ],
    [t],
  )

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await apiCallOrThrow('/api/prm/portal/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: values.companyName.trim(),
          contactName: values.contactName.trim(),
          contactEmail: values.contactEmail.trim(),
          source: values.source,
          notes: values.notes.trim() ? values.notes.trim() : null,
        }),
      })
      flash(t('prm.portal.prospects.flash.registered', 'Prospect registered.'), 'success')
      router.push(listHref)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : t('prm.portal.prospects.flash.registerError', 'Could not register prospect.'),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <Link
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          href={listHref}
        >
          {t('prm.portal.prospects.new.back', '← Back to prospects')}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {t('prm.portal.prospects.new.title', 'Register prospect')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'prm.portal.prospects.new.subtitle',
            'New registrations appear in the WIP widget when source is Agency-owned.',
          )}
        </p>
      </header>

      <form
        className="grid grid-cols-1 gap-3 rounded-md border p-4 md:grid-cols-2"
        onKeyDown={(e) => {
          if (e.key === 'Escape') router.push(listHref)
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            ;(e.currentTarget as HTMLFormElement).requestSubmit()
          }
        }}
        onSubmit={onSubmit}
      >
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">
            {t('prm.portal.prospects.fields.company', 'Company name')}
          </span>
          <Input
            value={values.companyName}
            required
            autoFocus
            onChange={(e) => setValues((v) => ({ ...v, companyName: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {t('prm.portal.prospects.fields.contactName', 'Contact name')}
          </span>
          <Input
            value={values.contactName}
            required
            onChange={(e) => setValues((v) => ({ ...v, contactName: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {t('prm.portal.prospects.fields.contactEmail', 'Contact email')}
          </span>
          <Input
            type="email"
            value={values.contactEmail}
            required
            onChange={(e) => setValues((v) => ({ ...v, contactEmail: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">
            {t('prm.portal.prospects.fields.source', 'Source')}
          </span>
          <ComboboxInput
            value={values.source}
            onChange={(next) => setValues((v) => ({ ...v, source: next || 'agency_owned' }))}
            suggestions={sourceOptions}
            allowCustomValues={false}
            placeholder={t('prm.portal.prospects.fields.source.placeholder', 'Type to search…')}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">{t('prm.portal.prospects.fields.notes', 'Notes')}</span>
          <Textarea
            className="min-h-24"
            value={values.notes}
            onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
          />
        </label>
        <div className="md:col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push(listHref)}>
            {t('prm.portal.prospects.cancel', 'Cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? t('prm.portal.prospects.submitting', 'Saving…')
              : t('prm.portal.prospects.submit', 'Register')}
          </Button>
        </div>
      </form>
    </div>
  )
}
