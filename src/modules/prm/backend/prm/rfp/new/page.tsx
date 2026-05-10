'use client'
import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  buildRfpFormConfig,
  rfpFormSchema,
  rfpFormValuesToPayload,
  RFP_FORM_INITIAL,
  type RfpFormValues,
} from '../_shared/rfpFormConfig'

export default function CreateRfpPage() {
  const t = useT()
  const { fields, groups } = React.useMemo(() => buildRfpFormConfig(t), [t])
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
