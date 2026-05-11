'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

const createSchema = z.object({
  licenseIdentifier: z.string().min(2).max(120),
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

type CreateValues = z.infer<typeof createSchema>

type SuggestResponse = { ok: true; identifier: string }

export default function CreateLicenseDealPage() {
  const t = useT()
  const router = useRouter()
  const [suggestedId, setSuggestedId] = React.useState<string | null>(null)
  const [suggestError, setSuggestError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    apiCall<SuggestResponse>('/api/prm/license-deal/next-identifier').then((res) => {
      if (!active) return
      if (res.ok && res.result?.identifier) {
        setSuggestedId(res.result.identifier)
      } else {
        setSuggestError(
          t(
            'prm.licenseDeals.create.suggestError',
            'Could not load the next license identifier. Please refresh.',
          ),
        )
      }
    })
    return () => {
      active = false
    }
  }, [t])

  if (suggestError) {
    return (
      <Page>
        <PageHeader title={t('prm.licenseDeals.create.title', 'New license deal')} />
        <PageBody>
          <ErrorMessage label={suggestError} />
        </PageBody>
      </Page>
    )
  }

  if (!suggestedId) {
    return (
      <Page>
        <PageHeader title={t('prm.licenseDeals.create.title', 'New license deal')} />
        <PageBody>
          <LoadingMessage label={t('common.loading', 'Loading…')} />
        </PageBody>
      </Page>
    )
  }

  const initialValues: CreateValues = {
    licenseIdentifier: suggestedId,
    clientCompanyName: '',
    clientIndustry: '',
    type: 'enterprise',
    isRenewal: false,
    annualValueUsd: '',
    monthlyLicenseAmount: '',
    licenseStartDate: '',
    licenseEndDate: '',
    notes: '',
  }

  return (
    <Page>
      <PageHeader
        title={t('prm.licenseDeals.create.title', 'New license deal')}
        description={t(
          'prm.licenseDeals.create.hint',
          "After creating, open the deal to attribute it to a Prospect (Path A) — attribution is what adds the deal to the partner agency's MIN. Direct deals can stay unattributed.",
        )}
      />
      <PageBody>
        <CrudForm<CreateValues>
          schema={createSchema}
          initialValues={initialValues}
          fields={[
            {
              id: 'licenseIdentifier',
              label: t('prm.licenseDeals.fields.identifier', 'License identifier'),
              type: 'text',
              required: true,
              disabled: true,
              layout: 'half',
              description: t(
                'prm.licenseDeals.fields.identifier.autoHelp',
                'Auto-assigned by the system on create — not editable.',
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
          submitLabel={t('prm.licenseDeals.create.submit', 'Create')}
          cancelHref="/backend/prm/license-deals"
          backHref="/backend/prm/license-deals"
          onSubmit={async (values) => {
            // licenseIdentifier is auto-generated server-side — do NOT forward
            // the disabled-field value; the create handler picks the next
            // identifier atomically and retries on race.
            const payload: Record<string, unknown> = {
              clientCompanyName: values.clientCompanyName,
              type: values.type ?? 'enterprise',
              isRenewal: values.isRenewal ?? false,
            }
            if (values.clientIndustry) payload.clientIndustry = values.clientIndustry
            if (values.annualValueUsd) payload.annualValueUsd = values.annualValueUsd
            if (values.monthlyLicenseAmount) payload.monthlyLicenseAmount = values.monthlyLicenseAmount
            if (values.licenseStartDate) payload.licenseStartDate = values.licenseStartDate
            if (values.licenseEndDate) payload.licenseEndDate = values.licenseEndDate
            if (values.notes) payload.notes = values.notes

            await apiCallOrThrow<{ ok: true; licenseDeal: { id: string; licenseIdentifier: string } }>(
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
            router.push('/backend/prm/license-deals')
          }}
        />
      </PageBody>
    </Page>
  )
}
