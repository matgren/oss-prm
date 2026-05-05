'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

const createSchema = z.object({
  licenseIdentifier: z.string().min(2).max(120),
  clientCompanyName: z.string().min(1).max(200),
  clientIndustry: z.string().max(120).optional(),
  type: z.string().max(40).optional(),
  isRenewal: z.boolean().optional(),
  annualValueUsd: z.string().optional(),
  monthlyLicenseAmount: z.string().optional(),
  notes: z.string().max(10_000).optional(),
})

type CreateValues = z.infer<typeof createSchema>

const INITIAL: CreateValues = {
  licenseIdentifier: '',
  clientCompanyName: '',
  clientIndustry: '',
  type: 'enterprise',
  isRenewal: false,
  annualValueUsd: '',
  monthlyLicenseAmount: '',
  notes: '',
}

export default function CreateLicenseDealPage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageHeader title={t('prm.licenseDeals.create.title', 'New license deal')} />
      <PageBody>
        <CrudForm<CreateValues>
          schema={createSchema}
          initialValues={INITIAL}
          fields={[
            {
              id: 'licenseIdentifier',
              label: t('prm.licenseDeals.fields.identifier', 'License identifier'),
              type: 'text',
              required: true,
              layout: 'half',
              description: t(
                'prm.licenseDeals.fields.identifier.help',
                'Unique per tenant — e.g. OM-2026-0042.',
              ),
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
              defaultValue: 'enterprise',
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
              id: 'notes',
              label: t('prm.licenseDeals.fields.notes', 'Internal notes'),
              type: 'textarea',
            },
          ]}
          submitLabel={t('prm.licenseDeals.create.submit', 'Create')}
          cancelHref="/backend/prm/license-deals"
          backHref="/backend/prm/license-deals"
          onSubmit={async (values) => {
            const payload: Record<string, unknown> = {
              licenseIdentifier: values.licenseIdentifier,
              clientCompanyName: values.clientCompanyName,
              type: values.type ?? 'enterprise',
              isRenewal: values.isRenewal ?? false,
            }
            if (values.clientIndustry) payload.clientIndustry = values.clientIndustry
            if (values.annualValueUsd) payload.annualValueUsd = values.annualValueUsd
            if (values.monthlyLicenseAmount) payload.monthlyLicenseAmount = values.monthlyLicenseAmount
            if (values.notes) payload.notes = values.notes

            const res = await apiCallOrThrow<{ ok: true; licenseDeal: { id: string } }>(
              '/api/prm/license-deal',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              },
              {
                errorMessage: t(
                  'prm.licenseDeals.create.error',
                  'Failed to create license deal.',
                ),
              },
            )
            flash(t('prm.licenseDeals.create.flash.success', 'License deal created.'), 'success')
            const id = res.result?.licenseDeal?.id
            if (id) router.push(`/backend/prm/license-deals/${id}`)
          }}
        />
      </PageBody>
    </Page>
  )
}
