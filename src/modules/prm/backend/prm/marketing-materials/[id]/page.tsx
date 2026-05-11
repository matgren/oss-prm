'use client'
import * as React from 'react'
import { useParams } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { TagsInput, type TagsInputOption } from '@open-mercato/ui/backend/inputs/TagsInput'
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
  minTier: string | null
  topics: string[]
  allowedRoles: string[]
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
  minTier: z.string().optional(),
  topics: z.array(z.string()).default([]),
  allowedRoles: z.array(z.enum(['partner_admin', 'partner_member'])).default([]),
})

type FormValues = z.infer<typeof formSchema>

const ROLE_OPTIONS: TagsInputOption[] = [
  { value: 'partner_admin', label: 'Partner admin' },
  { value: 'partner_member', label: 'Partner member' },
]

type DictionaryEntriesResponse = {
  ok: true
  items: TagsInputOption[]
}

const dtoToPickerFile = (a: AttachmentDto): PickerFile => ({
  id: a.id,
  fileName: a.fileName,
  fileSize: a.fileSize,
  mimeType: a.mimeType,
  url: a.url,
  source: 'bound',
})

function resolveDynamicId(params: Record<string, unknown> | null): string {
  // OM framework routes module pages through a catch-all `/backend/[...slug]`,
  // so `useParams()` returns `{ slug: ['prm', 'marketing-materials', '<uuid>'] }`
  // instead of `{ id: '<uuid>' }`. Cover both shapes.
  const slug = (params as { slug?: unknown } | null)?.slug
  if (Array.isArray(slug) && slug.length > 0) {
    const last = slug[slug.length - 1]
    if (typeof last === 'string') return last
  }
  const id = (params as { id?: unknown } | null)?.id
  if (Array.isArray(id) && id.length > 0 && typeof id[0] === 'string') return id[0]
  if (typeof id === 'string') return id
  return ''
}

export default function EditMarketingMaterialPage() {
  const t = useT()
  const params = useParams() as Record<string, unknown> | null
  const id = resolveDynamicId(params)
  const [data, setData] = React.useState<MaterialDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [pickerValue, setPickerValue] = React.useState<PickerValue | null>(null)
  const pickerValueRef = React.useRef<PickerValue | null>(null)
  pickerValueRef.current = pickerValue

  // TagsInput state mirrored from the loaded DTO once it arrives.
  const [topicsValue, setTopicsValue] = React.useState<string[]>([])
  const [topicsOptions, setTopicsOptions] = React.useState<TagsInputOption[]>([])
  const [allowedRolesValue, setAllowedRolesValue] = React.useState<string[]>([])

  // Stable per-mount draftRecordId for any NEW files added on the edit page —
  // the saved material's existing attachments use the material id, freshly
  // uploaded ones use this draft id and get rebound on PUT.
  const [draftRecordId] = React.useState<string>(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

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
      setTopicsValue(Array.isArray(m.topics) ? m.topics : [])
      setAllowedRolesValue(Array.isArray(m.allowedRoles) ? m.allowedRoles : [])
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
    minTier: data.minTier ?? '',
    topics: topicsValue,
    allowedRoles: allowedRolesValue as FormValues['allowedRoles'],
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
                  minTier: values.minTier || null,
                  topics: topicsValue,
                  allowedRoles: allowedRolesValue,
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
