'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  AttachmentPicker,
  emptyPickerValue,
  type PickerValue,
} from '../components/AttachmentPicker'

const formSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2_000).optional(),
  materialType: z.enum(['playbook', 'sales_deck', 'video', 'guide', 'case_study_template', 'other']),
  visibility: z.enum(['all_partners', 'tier_gated']),
  minTier: z.string().optional(),
  topicsCsv: z.string().max(2_000).optional(),
  audiencesCsv: z.string().max(500).optional(),
})

type FormValues = z.infer<typeof formSchema>

const INITIAL: FormValues = {
  title: '',
  description: '',
  materialType: 'playbook',
  visibility: 'all_partners',
  minTier: '',
  topicsCsv: '',
  audiencesCsv: '',
}

const VALID_AUDIENCES = new Set(['new_partner', 'active_partner', 'tier_progressing'])

export default function NewMarketingMaterialPage() {
  const t = useT()
  const router = useRouter()
  // Stable per-mount draftRecordId — every upload from this form posts under
  // this id; the server rebinds them to the new material on save.
  const [draftRecordId] = React.useState<string>(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const [pickerValue, setPickerValue] = React.useState<PickerValue>(emptyPickerValue())
  const pickerValueRef = React.useRef(pickerValue)
  pickerValueRef.current = pickerValue

  return (
    <Page>
      <PageHeader title={t('prm.backend.marketingMaterials.btn.new', 'New material')} />
      <PageBody>
        <CrudForm<FormValues>
          schema={formSchema}
          initialValues={INITIAL}
          fields={[
            { id: 'title', label: t('prm.backend.marketingMaterials.form.title', 'Title'), type: 'text', required: true },
            {
              id: 'description',
              label: t('prm.backend.marketingMaterials.form.description', 'Description'),
              type: 'textarea',
            },
            {
              id: 'materialType',
              label: t('prm.backend.marketingMaterials.form.materialType', 'Type'),
              type: 'select',
              required: true,
              options: [
                { value: 'playbook', label: 'Playbook' },
                { value: 'sales_deck', label: 'Sales deck' },
                { value: 'video', label: 'Video' },
                { value: 'guide', label: 'Guide' },
                { value: 'case_study_template', label: 'Case study template' },
                { value: 'other', label: 'Other' },
              ],
            },
            {
              id: 'visibility',
              label: t('prm.backend.marketingMaterials.form.visibility', 'Visibility'),
              type: 'select',
              required: true,
              options: [
                { value: 'all_partners', label: 'All partners' },
                { value: 'tier_gated', label: 'Tier-gated' },
              ],
            },
            {
              id: 'minTier',
              label: t('prm.backend.marketingMaterials.form.minTier', 'Minimum tier'),
              type: 'select',
              options: [
                { value: '', label: '—' },
                { value: 'om_agency', label: 'om_agency' },
                { value: 'ai_native', label: 'ai_native' },
                { value: 'ai_native_expert', label: 'ai_native_expert' },
                { value: 'ai_native_core', label: 'ai_native_core' },
              ],
              description: 'Required when visibility = tier_gated.',
            },
            {
              id: 'topicsCsv',
              label: t('prm.backend.marketingMaterials.form.topics', 'Topics (comma-separated slugs)'),
              type: 'text',
            },
            {
              id: 'audiencesCsv',
              label: t('prm.backend.marketingMaterials.form.audiences', 'Audiences'),
              type: 'text',
              description: 'Comma-separated, one of new_partner | active_partner | tier_progressing.',
            },
            {
              id: '__attachments',
              label: t('prm.backend.marketingMaterials.form.attachments', 'Files'),
              type: 'custom',
              required: true,
              component: () => (
                <AttachmentPicker
                  value={pickerValue}
                  onChange={setPickerValue}
                  draftRecordId={draftRecordId}
                />
              ),
            },
          ]}
          submitLabel={t('prm.backend.marketingMaterials.form.save', 'Save')}
          onSubmit={async (values) => {
            const current = pickerValueRef.current
            if (!current.primaryAttachmentId || current.attachments.length === 0) {
              flash(
                t(
                  'prm.backend.marketingMaterials.attachments.atLeastOne',
                  'Add at least one file before saving.',
                ),
                'error',
              )
              return
            }
            const topics = (values.topicsCsv ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const audiences = (values.audiencesCsv ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => VALID_AUDIENCES.has(s))
            const extraAttachmentIds = current.attachments
              .map((a) => a.id)
              .filter((id) => id !== current.primaryAttachmentId)
            try {
              const res = await apiCallOrThrow<{ ok: true; material: { id: string } }>(
                '/api/prm/marketing-material',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: values.title,
                    description: values.description || null,
                    materialType: values.materialType,
                    visibility: values.visibility,
                    minTier: values.visibility === 'tier_gated' ? values.minTier || null : null,
                    topics,
                    audiences,
                    primaryAttachmentId: current.primaryAttachmentId,
                    extraAttachmentIds,
                    draftRecordId,
                  }),
                },
              )
              flash(t('prm.backend.marketingMaterials.flash.published', 'Material saved.'), 'success')
              const newId = res.result?.material?.id
              if (newId) router.push(`/backend/prm/marketing-materials/${newId}`)
            } catch (err) {
              flash(
                err instanceof Error
                  ? err.message
                  : t('prm.backend.marketingMaterials.flash.saveError', 'Could not save material.'),
                'error',
              )
            }
          }}
        />
      </PageBody>
    </Page>
  )
}
