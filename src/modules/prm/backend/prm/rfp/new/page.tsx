'use client'
import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  buildRfpFormConfig,
  rfpFormSchema,
  rfpFormValuesToPayload,
  RFP_FORM_INITIAL,
  type RfpFormValues,
} from '../_shared/rfpFormConfig'

export default function CreateRfpPage() {
  const t = useT()
  // SPEC-2026-05-11 — pre-load tenant-wide tech tag suggestions once on mount;
  // CrudForm consumes them as static `options` so TagsInput filters client-side.
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
        // Silent degrade — type-and-enter still works.
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
        t('prm.rfp.create.flash.success', 'RFP draft created.'),
      )}&type=success`,
    [t],
  )

  return (
    <Page>
      <PageBody>
        <CrudForm<RfpFormValues>
          title={t('prm.rfp.create.title', 'New RFP')}
          schema={rfpFormSchema}
          fields={fields}
          groups={groups}
          initialValues={RFP_FORM_INITIAL}
          submitLabel={t('prm.rfp.create.submit', 'Create draft')}
          cancelHref="/backend/prm/rfp"
          backHref="/backend/prm/rfp"
          successRedirect={successRedirect}
          onSubmit={async (values) => {
            await apiCallOrThrow<{ ok: true; id: string }>(
              '/api/prm/rfp',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rfpFormValuesToPayload(values)),
              },
              { errorMessage: t('prm.rfp.create.error', 'Failed to create RFP.') },
            )
          }}
        />
      </PageBody>
    </Page>
  )
}
