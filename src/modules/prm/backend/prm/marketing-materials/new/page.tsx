'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { TagsInput, type TagsInputOption } from '@open-mercato/ui/backend/inputs/TagsInput'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  AttachmentPicker,
  emptyPickerValue,
  type PickerValue,
} from '../components/AttachmentPicker'

const formSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2_000).optional(),
  materialType: z.enum(['playbook', 'sales_deck', 'video', 'guide', 'case_study_template', 'other']),
  minTier: z.string().optional(),
  topics: z.array(z.string()).default([]),
  allowedRoles: z.array(z.enum(['partner_admin', 'partner_member'])).default([]),
})

type FormValues = z.infer<typeof formSchema>

const INITIAL: FormValues = {
  title: '',
  description: '',
  materialType: 'playbook',
  minTier: '',
  topics: [],
  allowedRoles: [],
}

const ROLE_OPTIONS: TagsInputOption[] = [
  { value: 'partner_admin', label: 'Partner admin' },
  { value: 'partner_member', label: 'Partner member' },
]

type DictionaryEntriesResponse = {
  ok: true
  items: TagsInputOption[]
}

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

  // TagsInput state for `topics` and `allowedRoles`. We keep these as local
  // React state and read them on submit instead of relying on CrudForm's
  // value plumbing, since `type: 'custom'` fields are uncontrolled wrt the
  // form value.
  const [topicsValue, setTopicsValue] = React.useState<string[]>([])
  const [topicsOptions, setTopicsOptions] = React.useState<TagsInputOption[]>([])
  const [allowedRolesValue, setAllowedRolesValue] = React.useState<string[]>([])

  React.useEffect(() => {
    let cancelled = false
    void apiCall<DictionaryEntriesResponse>('/api/prm/dictionaries/topics/entries')
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.result?.ok && Array.isArray(res.result.items)) {
          setTopicsOptions(res.result.items)
        }
      })
      .catch(() => {
        // Silently degrade to empty suggestions — closed-list TagsInput still
        // renders (just without autocomplete) so the form remains usable.
      })
    return () => {
      cancelled = true
    }
  }, [])

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
              description: t(
                'prm.backend.marketingMaterials.form.minTier.help',
                'Optional. Leave empty to allow all partners.',
              ),
            },
            {
              id: 'topics',
              label: t('prm.backend.marketingMaterials.form.topics', 'Topics'),
              type: 'custom',
              component: () => (
                <TagsInput
                  value={topicsValue}
                  onChange={setTopicsValue}
                  suggestions={topicsOptions}
                  allowCustomValues={false}
                  placeholder={t('prm.backend.marketingMaterials.form.topics.placeholder', 'Pick topics…')}
                />
              ),
            },
            {
              id: 'allowedRoles',
              label: t('prm.backend.marketingMaterials.form.allowedRoles', 'Visible to roles'),
              type: 'custom',
              description: t(
                'prm.backend.marketingMaterials.form.allowedRoles.help',
                'Leave empty to make visible to all partner roles.',
              ),
              component: () => (
                <TagsInput
                  value={allowedRolesValue}
                  onChange={setAllowedRolesValue}
                  suggestions={ROLE_OPTIONS}
                  allowCustomValues={false}
                  placeholder={t(
                    'prm.backend.marketingMaterials.form.allowedRoles.placeholder',
                    'Pick roles…',
                  )}
                />
              ),
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
                    minTier: values.minTier || null,
                    topics: topicsValue,
                    allowedRoles: allowedRolesValue,
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
