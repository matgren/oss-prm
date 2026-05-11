'use client'
import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  buildRfpFormConfig,
  rfpFormSchema,
  rfpFormValuesToPatchPayload,
  rfpToFormValues,
  type RfpFormValues,
} from '../../_shared/rfpFormConfig'

type Rfp = {
  id: string
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
  notes: string | null
}

type DetailResponse = { ok: true; rfp: Rfp }

function resolveDynamicId(params: Record<string, unknown> | null): string | undefined {
  // OM framework routes module pages through a catch-all `/backend/[...slug]`.
  const slug = (params as { slug?: unknown } | null)?.slug
  if (Array.isArray(slug) && slug.length > 0) {
    // The last segment of /backend/prm/rfp/[id]/edit is "edit"; the [id] is
    // the second-to-last.
    const last = slug[slug.length - 1]
    if (last === 'edit' && slug.length >= 2) {
      const candidate = slug[slug.length - 2]
      if (typeof candidate === 'string') return candidate
    }
    if (typeof last === 'string') return last
  }
  const id = (params as { id?: unknown } | null)?.id
  if (Array.isArray(id) && id.length > 0 && typeof id[0] === 'string') return id[0]
  if (typeof id === 'string') return id
  return undefined
}

export default function EditRfpDraftPage() {
  const t = useT()
  const router = useRouter()
  const params = useParams() as Record<string, unknown> | null
  const id = resolveDynamicId(params)

  const [initial, setInitial] = React.useState<RfpFormValues | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notDraftRedirecting, setNotDraftRedirecting] = React.useState(false)

  // SPEC-2026-05-11 — pre-load tenant-wide tech tag suggestions once on mount;
  // CrudForm consumes them as static `options` for the `requiredCapabilities` field.
  const [capabilityOptions, setCapabilityOptions] = React.useState<
    Array<{ value: string; label: string }>
  >([])
  React.useEffect(() => {
    let cancelled = false
    void apiCall<{ ok: true; items: Array<{ value: string; label: string }> }>(
      '/api/prm/tag-suggestions?field=technologies',
    )
      .then((res) => {
        if (cancelled) return
        setCapabilityOptions(res.result?.items ?? [])
      })
      .catch(() => {
        // Silent degrade.
      })
    return () => {
      cancelled = true
    }
  }, [])
  const { fields, groups } = React.useMemo(
    () => buildRfpFormConfig(t, { capabilities: capabilityOptions }),
    [t, capabilityOptions],
  )
  const successRedirect = React.useMemo(
    () =>
      `/backend/prm/rfp?flash=${encodeURIComponent(
        t('prm.rfp.edit.flash.saved', 'Draft saved.'),
      )}&type=success`,
    [t],
  )

  React.useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiCall<DetailResponse>(`/api/prm/rfp/${id}`)
        if (cancelled) return
        if (!res.ok || !res.result?.ok) {
          throw new Error(t('prm.rfp.error.loadDetail', 'Failed to load RFP'))
        }
        const rfp = res.result.rfp
        if (rfp.status !== 'draft') {
          // Edit screen only handles drafts. Redirect to the read-only detail
          // page where lifecycle actions live.
          setNotDraftRedirecting(true)
          router.replace(`/backend/prm/rfp/${id}`)
          return
        }
        setInitial(rfpToFormValues(rfp))
      } catch (err) {
        if (cancelled) return
        setError(
          err instanceof Error
            ? err.message
            : t('prm.rfp.error.loadDetail', 'Failed to load RFP'),
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, router, t])

  if (!id) return null
  if (loading || notDraftRedirecting) {
    return <LoadingMessage label={t('prm.rfp.edit.loading', 'Loading…')} />
  }
  if (error || !initial) {
    return <ErrorMessage label={error ?? t('prm.rfp.error.loadDetail', 'Failed to load RFP')} />
  }

  return (
    <Page>
      <PageBody>
        <CrudForm<RfpFormValues>
          title={t('prm.rfp.edit.title', 'Edit RFP draft')}
          schema={rfpFormSchema}
          fields={fields}
          groups={groups}
          initialValues={initial}
          submitLabel={t('prm.rfp.edit.submit', 'Save draft')}
          cancelHref={`/backend/prm/rfp/${id}`}
          backHref={`/backend/prm/rfp/${id}`}
          successRedirect={successRedirect}
          onSubmit={async (values) => {
            await apiCallOrThrow(
              `/api/prm/rfp/${id}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rfpFormValuesToPatchPayload(values)),
              },
              { errorMessage: t('prm.rfp.edit.error', 'Failed to save draft.') },
            )
          }}
        />
      </PageBody>
    </Page>
  )
}
