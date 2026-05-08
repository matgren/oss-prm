'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  AttachmentPicker,
  type PickerFile,
  type PickerValue,
} from '../components/AttachmentPicker'

type AttachmentDto = {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  url: string
  isPrimary: boolean
}

type MaterialDto = {
  id: string
  title: string
  description: string | null
  materialType: string
  visibility: string
  minTier: string | null
  topics: string[]
  audiences: string[]
  primaryAttachmentId: string
  attachments: AttachmentDto[]
  publishedAt: string | null
  unpublishedAt: string | null
  isCurrentlyPublished: boolean
}

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

const VALID_AUDIENCES = new Set(['new_partner', 'active_partner', 'tier_progressing'])

const dtoToPickerFile = (a: AttachmentDto): PickerFile => ({
  id: a.id,
  fileName: a.fileName,
  fileSize: a.fileSize,
  mimeType: a.mimeType,
  url: a.url,
  source: 'bound',
})

export default function EditMarketingMaterialPage() {
  const t = useT()
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [data, setData] = React.useState<MaterialDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [pickerValue, setPickerValue] = React.useState<PickerValue | null>(null)
  const pickerValueRef = React.useRef<PickerValue | null>(null)
  pickerValueRef.current = pickerValue

  // Stable per-mount draftRecordId for any NEW files added on the edit page —
  // the saved material's existing attachments use the material id, freshly
  // uploaded ones use this draft id and get rebound on PUT.
  const [draftRecordId] = React.useState<string>(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall<{ ok: true; material: MaterialDto }>(`/api/prm/marketing-material/${id}`)
      if (!res.ok || !res.result?.ok) {
        throw new Error(t('prm.backend.marketingMaterials.error.loadFailed', 'Could not load.'))
      }
      const m = res.result.material
      setData(m)
      setPickerValue({
        primaryAttachmentId: m.primaryAttachmentId,
        attachments: (m.attachments ?? []).map(dtoToPickerFile),
        removedBoundIds: [],
      })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('prm.backend.marketingMaterials.error.loadFailed', 'Could not load.'),
      )
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const togglePublish = React.useCallback(async () => {
    if (!data) return
    const action = data.isCurrentlyPublished ? 'unpublish' : 'publish'
    try {
      await apiCallOrThrow(`/api/prm/marketing-material/${data.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      flash(
        t(
          action === 'publish'
            ? 'prm.backend.marketingMaterials.flash.published'
            : 'prm.backend.marketingMaterials.flash.unpublished',
          action,
        ),
        'success',
      )
      void load()
    } catch (err) {
      flash(
        err instanceof Error
          ? err.message
          : t('prm.backend.marketingMaterials.flash.publishError', 'Could not change publish state.'),
        'error',
      )
    }
  }, [data, load, t])

  if (loading) return <LoadingMessage label={t('common.loading', 'Loading…')} />
  if (error) return <ErrorMessage label={error} />
  if (!data || !pickerValue) return null

  const initial: FormValues = {
    title: data.title,
    description: data.description ?? '',
    materialType: data.materialType as FormValues['materialType'],
    visibility: data.visibility as FormValues['visibility'],
    minTier: data.minTier ?? '',
    topicsCsv: data.topics.join(', '),
    audiencesCsv: data.audiences.join(', '),
  }

  return (
    <Page>
      <PageHeader
        title={data.title}
        description={
          data.isCurrentlyPublished
            ? `${t('prm.backend.marketingMaterials.col.status', 'Status')}: Published`
            : `${t('prm.backend.marketingMaterials.col.status', 'Status')}: Draft`
        }
        actions={
          <Button type="button" variant="outline" onClick={() => void togglePublish()}>
            {data.isCurrentlyPublished
              ? t('prm.backend.marketingMaterials.action.unpublish', 'Unpublish')
              : t('prm.backend.marketingMaterials.action.publish', 'Publish')}
          </Button>
        }
      />
      <PageBody>
        <CrudForm<FormValues>
          schema={formSchema}
          initialValues={initial}
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
            if (!current || !current.primaryAttachmentId || current.attachments.length === 0) {
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
            // New files staged this session — anything still flagged 'staged'
            // needs to be rebound to the material on the server side.
            const stagedExtras = current.attachments
              .filter((a) => a.source === 'staged')
              .map((a) => a.id)
            // Keep extras stable: include staged ids except the (possibly
            // newly-promoted) primary. Already-bound non-primary files don't
            // need to be sent — they stay in place.
            const extraAttachmentIds = stagedExtras.filter(
              (id) => id !== current.primaryAttachmentId,
            )
            try {
              await apiCallOrThrow(`/api/prm/marketing-material/${data.id}`, {
                method: 'PUT',
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
                  removedAttachmentIds: current.removedBoundIds,
                  draftRecordId,
                }),
              })
              flash(t('prm.backend.marketingMaterials.flash.published', 'Saved.'), 'success')
              void load()
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
