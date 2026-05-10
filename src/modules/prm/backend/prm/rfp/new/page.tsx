'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

/**
 * Form-level Zod schema (camelCase form values mapped to the snake_case API
 * payload on submit). Mirrors the server's `createRfpDraftSchema` companion-
 * field rules: when eligibility=by_min_tier, minTier required; when
 * eligibility=explicit, explicitAgencyIds non-empty.
 */
const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    receivedFrom: z.string().min(1).max(200),
    receivedAt: z.string().min(1),
    description: z.string().min(1),
    techRequirements: z.string().min(1),
    domainRequirements: z.string().min(1),
    industry: z.string().max(120).optional(),
    budgetBucket: z
      .enum(['<50k', '50k-250k', '250k-1m', '1m+', 'unknown', ''])
      .optional(),
    timelineBucket: z
      .enum(['0-3m', '3-6m', '6-12m', '12m+', 'unknown', ''])
      .optional(),
    requiredCapabilities: z.string().optional(),
    additionalCriterionName: z.string().max(120).optional(),
    deadlineToRespond: z.string().optional(),
    eligibilityFilter: z.enum(['all_active', 'by_min_tier', 'explicit']),
    minTier: z
      .enum(['', 'om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core'])
      .optional(),
    explicitAgencyIds: z.string().optional(),
    notes: z.string().max(8_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.eligibilityFilter === 'by_min_tier' && !v.minTier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minTier'],
        message: 'Required when eligibility is "by min tier"',
      })
    }
    if (v.eligibilityFilter === 'explicit') {
      const ids = (v.explicitAgencyIds ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (ids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['explicitAgencyIds'],
          message: 'At least one agency UUID required',
        })
      }
    }
  })

type CreateValues = z.infer<typeof createSchema>

const INITIAL: CreateValues = {
  title: '',
  receivedFrom: '',
  receivedAt: '',
  description: '',
  techRequirements: '',
  domainRequirements: '',
  industry: '',
  budgetBucket: '',
  timelineBucket: '',
  requiredCapabilities: '',
  additionalCriterionName: '',
  deadlineToRespond: '',
  eligibilityFilter: 'all_active',
  minTier: '',
  explicitAgencyIds: '',
  notes: '',
}

export default function CreateRfpPage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageHeader title={t('prm.rfp.create.title', 'New RFP')} />
      <PageBody>
        <CrudForm<CreateValues>
          schema={createSchema}
          initialValues={INITIAL}
          fields={[
            {
              id: 'title',
              label: t('prm.rfp.fields.title', 'Title'),
              type: 'text',
              required: true,
            },
            {
              id: 'receivedFrom',
              label: t('prm.rfp.fields.receivedFrom', 'Received from'),
              type: 'text',
              required: true,
              layout: 'half',
              description: t(
                'prm.rfp.fields.receivedFrom.help',
                'Client / prospect name as received.',
              ),
            },
            {
              id: 'receivedAt',
              label: t('prm.rfp.fields.receivedAt', 'Received at'),
              type: 'date',
              required: true,
              layout: 'half',
            },
            {
              id: 'description',
              label: t('prm.rfp.fields.description', 'Description (markdown)'),
              type: 'textarea',
              required: true,
            },
            {
              id: 'techRequirements',
              label: t('prm.rfp.fields.techRequirements', 'Tech requirements (markdown)'),
              type: 'textarea',
              required: true,
            },
            {
              id: 'domainRequirements',
              label: t('prm.rfp.fields.domainRequirements', 'Domain requirements (markdown)'),
              type: 'textarea',
              required: true,
            },
            {
              id: 'industry',
              label: t('prm.rfp.fields.industry', 'Industry'),
              type: 'text',
              layout: 'third',
            },
            {
              id: 'budgetBucket',
              label: t('prm.rfp.fields.budgetBucket', 'Budget bucket'),
              type: 'select',
              layout: 'third',
              options: [
                { value: '<50k', label: '< $50k' },
                { value: '50k-250k', label: '$50k–$250k' },
                { value: '250k-1m', label: '$250k–$1M' },
                { value: '1m+', label: '$1M+' },
                { value: 'unknown', label: 'Unknown' },
              ],
            },
            {
              id: 'timelineBucket',
              label: t('prm.rfp.fields.timelineBucket', 'Timeline bucket'),
              type: 'select',
              layout: 'third',
              options: [
                { value: '0-3m', label: '0–3 months' },
                { value: '3-6m', label: '3–6 months' },
                { value: '6-12m', label: '6–12 months' },
                { value: '12m+', label: '12+ months' },
                { value: 'unknown', label: 'Unknown' },
              ],
            },
            {
              id: 'requiredCapabilities',
              label: t('prm.rfp.fields.requiredCapabilities', 'Required capabilities'),
              type: 'text',
              description: t(
                'prm.rfp.fields.requiredCapabilities.help',
                'Comma-separated capability slugs (e.g. nextjs,postgres).',
              ),
            },
            {
              id: 'additionalCriterionName',
              label: t('prm.rfp.fields.additionalCriterionName', 'Additional scoring criterion'),
              type: 'text',
              description: t(
                'prm.rfp.fields.additionalCriterionName.help',
                'Optional 4th rubric criterion (e.g. "Industry experience").',
              ),
            },
            {
              id: 'deadlineToRespond',
              label: t('prm.rfp.fields.deadlineToRespond', 'Deadline to respond'),
              type: 'datetime',
              layout: 'half',
            },
            {
              id: 'eligibilityFilter',
              label: t('prm.rfp.fields.eligibilityFilter', 'Eligibility filter'),
              type: 'select',
              required: true,
              layout: 'half',
              options: [
                { value: 'all_active', label: 'All active agencies' },
                { value: 'by_min_tier', label: 'By minimum tier' },
                { value: 'explicit', label: 'Explicit agency list' },
              ],
              defaultValue: 'all_active',
            },
            {
              id: 'minTier',
              label: t('prm.rfp.fields.minTier', 'Minimum tier (when filter = by_min_tier)'),
              type: 'select',
              layout: 'half',
              options: [
                { value: 'om_agency', label: 'OM Agency' },
                { value: 'ai_native', label: 'AI-Native' },
                { value: 'ai_native_expert', label: 'AI-Native Expert' },
                { value: 'ai_native_core', label: 'AI-Native Core' },
              ],
            },
            {
              id: 'explicitAgencyIds',
              label: t('prm.rfp.fields.explicitAgencyIds', 'Explicit agency IDs (when filter = explicit)'),
              type: 'textarea',
              description: t(
                'prm.rfp.fields.explicitAgencyIds.help',
                'Comma-separated UUIDs.',
              ),
            },
            {
              id: 'notes',
              label: t('prm.rfp.fields.notes', 'Internal notes'),
              type: 'textarea',
            },
          ]}
          submitLabel={t('prm.rfp.create.submit', 'Create draft')}
          cancelHref="/backend/prm/rfp"
          backHref="/backend/prm/rfp"
          onSubmit={async (values) => {
            // Map form values (camelCase) to API payload (snake_case).
            const capabilities = (values.requiredCapabilities ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const explicitIds = (values.explicitAgencyIds ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const payload: Record<string, unknown> = {
              title: values.title,
              received_from: values.receivedFrom,
              received_at: values.receivedAt,
              description: values.description,
              tech_requirements: values.techRequirements,
              domain_requirements: values.domainRequirements,
              required_capabilities: capabilities,
              eligibility_filter: values.eligibilityFilter,
            }
            if (values.industry) payload.industry = values.industry
            if (values.budgetBucket) payload.budget_bucket = values.budgetBucket
            if (values.timelineBucket) payload.timeline_bucket = values.timelineBucket
            if (values.additionalCriterionName) {
              payload.additional_criterion_name = values.additionalCriterionName
            }
            if (values.deadlineToRespond) payload.deadline_to_respond = values.deadlineToRespond
            if (values.eligibilityFilter === 'by_min_tier' && values.minTier) {
              payload.min_tier = values.minTier
            }
            if (values.eligibilityFilter === 'explicit' && explicitIds.length > 0) {
              payload.explicit_agency_ids = explicitIds
            }
            if (values.notes) payload.notes = values.notes

            const res = await apiCallOrThrow<{ ok: true; id: string }>(
              '/api/prm/rfp',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              },
              {
                errorMessage: t('prm.rfp.create.error', 'Failed to create RFP.'),
              },
            )
            flash(t('prm.rfp.create.flash.success', 'RFP draft created.'), 'success')
            const id = res.result?.id
            if (id) router.push(`/backend/prm/rfp/${id}`)
          }}
        />
      </PageBody>
    </Page>
  )
}
