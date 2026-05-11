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
  name: z.string().min(1, 'prm.errors.nameRequired').max(120),
  slug: z
    .string()
    .min(2, 'prm.errors.invalidSlug')
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'prm.errors.invalidSlug'),
  tier: z.enum(['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core']),
  status: z.enum(['active', 'historical']),
  contractSigned: z.boolean(),
  ndaSigned: z.boolean(),
  onboarded: z.boolean(),
  partnershipStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'prm.errors.invalidDate')
    .or(z.literal(''))
    .optional(),
})

type CreateValues = z.infer<typeof createSchema>

const INITIAL: CreateValues = {
  name: '',
  slug: '',
  tier: 'om_agency',
  status: 'active',
  contractSigned: false,
  ndaSigned: false,
  onboarded: false,
  partnershipStartDate: '',
}

export default function CreateAgencyPage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageHeader
        title={t('prm.agencies.create.title', 'Create agency')}
        description={t(
          'prm.agencies.create.subtitle',
          'OM staff seeds identity + status. The agency admin fills in the profile from the portal.',
        )}
      />
      <PageBody>
        <CrudForm<CreateValues>
          schema={createSchema}
          initialValues={INITIAL}
          fields={[
            { id: 'name', label: t('prm.agencies.fields.name', 'Name'), type: 'text', required: true, layout: 'half' },
            {
              id: 'slug',
              label: t('prm.agencies.fields.slug', 'Slug'),
              type: 'text',
              required: true,
              layout: 'half',
              description: t('prm.agencies.fields.slug.help', 'Lowercase letters, digits, and dashes only.'),
            },
            {
              id: 'tier',
              label: t('prm.agencies.fields.tier', 'Tier'),
              type: 'select',
              required: true,
              options: [
                { value: 'om_agency', label: 'OM Agency' },
                { value: 'ai_native', label: 'AI Native' },
                { value: 'ai_native_expert', label: 'AI Native Expert' },
                { value: 'ai_native_core', label: 'AI Native Core' },
              ],
              defaultValue: 'om_agency',
              description: t('prm.agencies.fields.tier.help', 'Admin-only — controls Marketing visibility and tier widgets.'),
            },
            {
              id: 'status',
              label: t('prm.agencies.fields.status', 'Status (admin-only)'),
              type: 'select',
              required: true,
              options: [
                { value: 'active', label: 'Active' },
                { value: 'historical', label: 'Historical' },
              ],
              defaultValue: 'active',
            },
            { id: 'contractSigned', label: t('prm.agencies.fields.contract', 'Contract signed (admin-only)'), type: 'checkbox' },
            { id: 'ndaSigned', label: t('prm.agencies.fields.nda', 'NDA signed (admin-only)'), type: 'checkbox' },
            { id: 'onboarded', label: t('prm.agencies.fields.onboarded', 'Onboarded (admin-only)'), type: 'checkbox' },
            {
              id: 'partnershipStartDate',
              label: t('prm.agencies.fields.partnershipStartDate', 'Partnership start date (admin-only)'),
              type: 'text',
              layout: 'half',
              placeholder: 'YYYY-MM-DD',
              description: t(
                'prm.agencies.fields.partnershipStartDate.help',
                'Anchor for partnership-year KPI windows. Leave empty if unknown.',
              ),
            },
          ]}
          submitLabel={t('prm.agencies.create.submit', 'Create')}
          cancelHref="/backend/prm"
          backHref="/backend/prm"
          onSubmit={async (values) => {
            const payload: Record<string, unknown> = {
              name: values.name,
              slug: values.slug,
              tier: values.tier,
              status: values.status,
              contractSigned: values.contractSigned,
              ndaSigned: values.ndaSigned,
              onboarded: values.onboarded,
            }
            if (values.partnershipStartDate) {
              payload.partnershipStartDate = values.partnershipStartDate
            }
            await apiCallOrThrow<{ ok: true; agency: { id: string } }>(
              '/api/prm/agency',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              },
              { errorMessage: t('prm.agencies.create.error', 'Failed to create agency.') },
            )
            flash(t('prm.agencies.create.flash.success', 'Agency created.'), 'success')
            router.push('/backend/prm')
          }}
        />
      </PageBody>
    </Page>
  )
}

// Metadata lives in `page.meta.ts`.
