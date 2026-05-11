'use client'
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { TagsInput, type TagsInputOption } from '@open-mercato/ui/backend/inputs/TagsInput'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { OnboardingChips } from '../_components/OnboardingChips'
import { PartnerStatusBanner } from '../_components/PartnerStatusBanner'

type AgencyView = {
  id: string
  name: string
  slug: string
  description: string | null
  websiteUrl: string | null
  logoUrl: string | null
  headquartersCountry: string | null
  headquartersCity: string | null
  teamSizeBucket: string | null
  industries: string[]
  services: string[]
  techCapabilities: string[]
  _prm?: {
    tier: string
    status: string
    contractSigned: boolean
    ndaSigned: boolean
    onboarded: boolean
  }
}

const TEAM_SIZE_BUCKETS = ['1-5', '6-20', '21-50', '51-100', '100+'] as const

export default function PortalAgencyProfilePage() {
  const t = useT()
  const [agency, setAgency] = React.useState<AgencyView | null>(null)
  const [agencyId, setAgencyId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({
    name: '',
    description: '',
    websiteUrl: '',
    headquartersCountry: '',
    headquartersCity: '',
    teamSizeBucket: '',
    technologies: [] as string[],
    services: [] as string[],
  })
  // SPEC-2026-05-11 — open-vocab tag suggestions pre-loaded once after agencyId resolves.
  const [techOptions, setTechOptions] = React.useState<TagsInputOption[]>([])
  const [servicesOptions, setServicesOptions] = React.useState<TagsInputOption[]>([])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const me = await apiCall<{ ok: true; agency: { id: string } | null }>('/api/prm/portal/me')
      if (!me.ok || !me.result?.ok || !me.result.agency) {
        setError(t('prm.portal.agency.notLinked', 'Your account is not linked to an agency yet.'))
        return
      }
      const id = me.result.agency.id
      setAgencyId(id)
      const res = await apiCall<{ ok: true; agency: AgencyView }>(`/api/prm/portal/agency/${id}`)
      if (!res.ok || !res.result?.ok) {
        setError(t('prm.portal.agency.loadError', 'Failed to load agency.'))
        return
      }
      const a = res.result.agency
      setAgency(a)
      setForm({
        name: a.name,
        description: a.description ?? '',
        websiteUrl: a.websiteUrl ?? '',
        headquartersCountry: a.headquartersCountry ?? '',
        headquartersCity: a.headquartersCity ?? '',
        teamSizeBucket: a.teamSizeBucket ?? '',
        technologies: a.techCapabilities ?? [],
        services: a.services ?? [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agency')
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  // SPEC-2026-05-11 — load open-vocab tag suggestions once `agencyId` resolves.
  // Silent degrade on failure: TagsInput still accepts type-and-enter without chips.
  React.useEffect(() => {
    if (!agencyId) return
    let cancelled = false
    void Promise.all([
      apiCall<{ ok: true; items: TagsInputOption[] }>(
        `/api/prm/portal/agency/${agencyId}/tag-suggestions?field=technologies`,
      ),
      apiCall<{ ok: true; items: TagsInputOption[] }>(
        `/api/prm/portal/agency/${agencyId}/tag-suggestions?field=services`,
      ),
    ])
      .then(([techRes, svcRes]) => {
        if (cancelled) return
        setTechOptions(techRes.result?.items ?? [])
        setServicesOptions(svcRes.result?.items ?? [])
      })
      .catch(() => {
        // Silent degrade.
      })
    return () => {
      cancelled = true
    }
  }, [agencyId])

  if (loading) {
    return <LoadingMessage label={t('prm.portal.agency.loading', 'Loading…')} />
  }
  if (error) {
    return <ErrorMessage label={error} />
  }
  if (!agency || !agencyId) return null

  const onSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    try {
      const country = form.headquartersCountry.trim()
      const body: Record<string, unknown> = {
        name: form.name,
        description: form.description || null,
        websiteUrl: form.websiteUrl || null,
        headquartersCity: form.headquartersCity || null,
        teamSizeBucket: form.teamSizeBucket || null,
        techCapabilities: form.technologies,
        services: form.services,
      }
      if (country) body.headquartersCountry = country.toUpperCase()
      await apiCallOrThrow(`/api/prm/portal/agency/${agencyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      flash(t('prm.portal.agency.saved', 'Profile saved.'), 'success')
      await load()
    } catch (err) {
      flash(err instanceof Error ? err.message : t('prm.portal.agency.saveError', 'Save failed.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <PartnerStatusBanner
        status={agency._prm?.status}
        t={t}
        messageKey="prm.portal.agency.banner.historical"
        message="Your partnership is historical — contact OM PartnerOps to reactivate."
        className="mb-4"
      />
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{agency.name}</h1>
          <p className="text-sm text-muted-foreground">
            {t('prm.portal.agency.subtitle', 'Slug: {slug}', { slug: agency.slug })}
          </p>
        </div>
        {agency._prm ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border px-2 py-0.5">Tier: {agency._prm.tier}</span>
            <span className="rounded-full border px-2 py-0.5">Status: {agency._prm.status}</span>
            <OnboardingChips
              contractSigned={agency._prm.contractSigned}
              ndaSigned={agency._prm.ndaSigned}
              onboarded={agency._prm.onboarded}
              t={t}
            />
          </div>
        ) : null}
      </header>

      <form
        className="grid grid-cols-1 gap-4 rounded-md border p-4 md:grid-cols-2"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            ;(e.currentTarget as HTMLFormElement).requestSubmit()
          }
          if (e.key === 'Escape') void load()
        }}
        onSubmit={onSave}
      >
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">{t('prm.portal.agency.fields.name', 'Name')}</span>
          <Input
            value={form.name}
            required
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">{t('prm.portal.agency.fields.description', 'Description')}</span>
          <Textarea
            className="min-h-24"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('prm.portal.agency.fields.website', 'Website')}</span>
          <Input
            type="url"
            value={form.websiteUrl}
            onChange={(e) => setForm((f) => ({ ...f, websiteUrl: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {t('prm.portal.agency.fields.country', 'Headquarters country')}
          </span>
          <Input
            value={form.headquartersCountry}
            maxLength={2}
            placeholder="US"
            pattern="[A-Za-z]{2}"
            onChange={(e) => setForm((f) => ({ ...f, headquartersCountry: e.target.value }))}
          />
          <span className="text-xs text-muted-foreground">
            {t('prm.portal.agency.fields.country.help', 'ISO-3166 alpha-2 code (e.g. US, GB, PL).')}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('prm.portal.agency.fields.city', 'Headquarters city')}</span>
          <Input
            value={form.headquartersCity}
            onChange={(e) => setForm((f) => ({ ...f, headquartersCity: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('prm.portal.agency.fields.teamSize', 'Team size')}</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={form.teamSizeBucket}
            onChange={(e) => setForm((f) => ({ ...f, teamSizeBucket: e.target.value }))}
          >
            <option value="">—</option>
            {TEAM_SIZE_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">
            {t('prm.portal.agency.fields.technologies', 'Technologies')}
          </span>
          <TagsInput
            value={form.technologies}
            onChange={(next) => setForm((f) => ({ ...f, technologies: next }))}
            suggestions={techOptions}
            placeholder={t(
              'prm.portal.agency.fields.technologies.placeholder',
              'Type to add a technology…',
            )}
          />
          <span className="text-xs text-muted-foreground">
            {t(
              'prm.portal.agency.fields.technologies.help',
              'Open vocabulary — type to add a new tag. Suggestions come from your agency profile + case studies.',
            )}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">
            {t('prm.portal.agency.fields.services', 'Services')}
          </span>
          <TagsInput
            value={form.services}
            onChange={(next) => setForm((f) => ({ ...f, services: next }))}
            suggestions={servicesOptions}
            placeholder={t(
              'prm.portal.agency.fields.services.placeholder',
              'Type to add a service…',
            )}
          />
          <span className="text-xs text-muted-foreground">
            {t(
              'prm.portal.agency.fields.services.help',
              'Open vocabulary — type to add a new service.',
            )}
          </span>
        </label>
        <div className="md:col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => void load()}>
            {t('prm.portal.agency.cancel', 'Cancel')}
          </Button>
          <Button type="submit" disabled={saving || agency._prm?.status === 'historical'}>
            {saving ? t('prm.portal.agency.saving', 'Saving…') : t('prm.portal.agency.save', 'Save changes')}
          </Button>
        </div>
      </form>
    </div>
  )
}
