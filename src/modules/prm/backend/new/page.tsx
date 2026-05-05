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
  headquartersCountry: z.string().length(2).regex(/^[A-Z]{2}$/, 'prm.errors.invalidCountry'),
})

type CreateValues = z.infer<typeof createSchema>

export default function CreateAgencyPage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageHeader title={t('prm.agencies.create.title', 'Create agency')} />
      <PageBody>
        <CrudForm<CreateValues>
          schema={createSchema}
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
            },
            {
              id: 'headquartersCountry',
              label: t('prm.agencies.fields.country', 'Headquarters country (ISO-3166 alpha-2)'),
              type: 'text',
              required: true,
              placeholder: 'US',
            },
          ]}
          submitLabel={t('prm.agencies.create.submit', 'Create')}
          cancelHref="/backend/prm"
          backHref="/backend/prm"
          onSubmit={async (values) => {
            const res = await apiCallOrThrow<{ ok: true; agency: { id: string } }>(
              '/api/prm/agency',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...values,
                  headquartersCountry: values.headquartersCountry.toUpperCase(),
                }),
              },
              { errorMessage: t('prm.agencies.create.error', 'Failed to create agency.') },
            )
            flash(t('prm.agencies.create.flash.success', 'Agency created.'), 'success')
            const id = res.result?.agency?.id
            if (id) router.push(`/backend/prm/${id}`)
          }}
        />
      </PageBody>
    </Page>
  )
}

// Metadata lives in `page.meta.ts`.
