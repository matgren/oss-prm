'use client'
/**
 * Shared form config for the RFP create + edit pages.
 *
 * Why this file exists: the RFP form has three dependent fields
 * (`eligibilityFilter` chooses between `minTier` and `explicitAgencyIds`).
 * `CrudForm` host fields don't yet support `visibleWhen` — only injected
 * fields do — so we render the dependent trio as a single custom-component
 * group via `CrudFormGroup.component`. Once upstream
 * `CrudFieldBase.visibleWhen` ships (tracked at
 * ~/Documents/OM/agents/tasks/2026-05-10-crudform-host-field-visibleWhen),
 * the custom group can be flattened back to plain `fields[]` entries with
 * `visibleWhen` rules, removing ~80 LOC.
 */
import * as React from 'react'
import { z } from 'zod'
import type {
  CrudField,
  CrudFormGroup,
  CrudFormGroupComponentProps,
} from '@open-mercato/ui/backend/CrudForm'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'

const ELIGIBILITY_VALUES = ['all_active', 'by_min_tier', 'explicit'] as const
const MIN_TIER_VALUES = [
  '',
  'om_agency',
  'ai_native',
  'ai_native_expert',
  'ai_native_core',
] as const
const BUDGET_VALUES = ['<50k', '50k-250k', '250k-1m', '1m+', 'unknown', ''] as const
const TIMELINE_VALUES = ['0-3m', '3-6m', '6-12m', '12m+', 'unknown', ''] as const

export const rfpFormSchema = z
  .object({
    title: z.string().min(1).max(200),
    receivedFrom: z.string().min(1).max(200),
    receivedAt: z.string().min(1),
    description: z.string().min(1),
    techRequirements: z.string().min(1),
    domainRequirements: z.string().min(1),
    industry: z.string().max(120).optional(),
    budgetBucket: z.enum(BUDGET_VALUES).optional(),
    timelineBucket: z.enum(TIMELINE_VALUES).optional(),
    /**
     * Open-vocabulary technology tags (SPEC-2026-05-11). Client schema is a
     * loose array; the server-side `openTagSlugArray` enforces trim + min(1)
     * + max(80) per element and `.max(50)` per array.
     */
    requiredCapabilities: z.array(z.string()).default([]),
    additionalCriterionName: z.string().max(120).optional(),
    deadlineToRespond: z.string().optional(),
    eligibilityFilter: z.enum(ELIGIBILITY_VALUES),
    minTier: z.enum(MIN_TIER_VALUES).optional(),
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
      const ids = (v.explicitAgencyIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (ids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['explicitAgencyIds'],
          message: 'At least one agency UUID required',
        })
      }
    }
  })

export type RfpFormValues = z.infer<typeof rfpFormSchema>

export const RFP_FORM_INITIAL: RfpFormValues = {
  title: '',
  receivedFrom: '',
  receivedAt: '',
  description: '',
  techRequirements: '',
  domainRequirements: '',
  industry: '',
  budgetBucket: '',
  timelineBucket: '',
  requiredCapabilities: [],
  additionalCriterionName: '',
  deadlineToRespond: '',
  eligibilityFilter: 'all_active',
  minTier: '',
  explicitAgencyIds: '',
  notes: '',
}

/** Hydrate form values from a loaded RFP record (snake_case API → camelCase form). */
export function rfpToFormValues(rfp: {
  title: string
  receivedFrom: string
  receivedAt: string
  description: string
  techRequirements: string
  domainRequirements: string
  industry: string | null
  budgetBucket: string | null
  timelineBucket: string | null
  requiredCapabilities: string[]
  additionalCriterionName: string | null
  deadlineToRespond: string | null
  eligibilityFilter: string
  minTier: string | null
  explicitAgencyIds: string[] | null
  notes: string | null
}): RfpFormValues {
  return {
    title: rfp.title,
    receivedFrom: rfp.receivedFrom,
    receivedAt: rfp.receivedAt.slice(0, 10),
    description: rfp.description,
    techRequirements: rfp.techRequirements,
    domainRequirements: rfp.domainRequirements,
    industry: rfp.industry ?? '',
    budgetBucket: (rfp.budgetBucket ?? '') as RfpFormValues['budgetBucket'],
    timelineBucket: (rfp.timelineBucket ?? '') as RfpFormValues['timelineBucket'],
    requiredCapabilities: rfp.requiredCapabilities ?? [],
    additionalCriterionName: rfp.additionalCriterionName ?? '',
    deadlineToRespond: rfp.deadlineToRespond ? rfp.deadlineToRespond.slice(0, 16) : '',
    eligibilityFilter: rfp.eligibilityFilter as RfpFormValues['eligibilityFilter'],
    minTier: (rfp.minTier ?? '') as RfpFormValues['minTier'],
    explicitAgencyIds: (rfp.explicitAgencyIds ?? []).join(', '),
    notes: rfp.notes ?? '',
  }
}

/** Map camelCase form values → snake_case API payload, dropping empties / irrelevant companions. */
export function rfpFormValuesToPayload(values: RfpFormValues): Record<string, unknown> {
  // Per SPEC-2026-05-11 — `requiredCapabilities` is now an array end-to-end.
  // Server-side `openTagSlugArray` trims + caps; client passes through verbatim.
  const capabilities = values.requiredCapabilities ?? []
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
  if (values.additionalCriterionName) payload.additional_criterion_name = values.additionalCriterionName
  if (values.deadlineToRespond) payload.deadline_to_respond = values.deadlineToRespond
  if (values.eligibilityFilter === 'by_min_tier' && values.minTier) {
    payload.min_tier = values.minTier
  }
  if (values.eligibilityFilter === 'explicit' && explicitIds.length > 0) {
    payload.explicit_agency_ids = explicitIds
  }
  if (values.notes) payload.notes = values.notes
  return payload
}

/**
 * Same mapper as above, but emits explicit `null` for cleared optional fields
 * so PATCH semantics on the edit page can clear values that were previously
 * set. The server `updateRfpDraftSchema` accepts null for these.
 */
export function rfpFormValuesToPatchPayload(values: RfpFormValues): Record<string, unknown> {
  // Per SPEC-2026-05-11 — `requiredCapabilities` is now an array end-to-end.
  const capabilities = values.requiredCapabilities ?? []
  const explicitIds = (values.explicitAgencyIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    title: values.title,
    received_from: values.receivedFrom,
    received_at: values.receivedAt,
    description: values.description,
    tech_requirements: values.techRequirements,
    domain_requirements: values.domainRequirements,
    required_capabilities: capabilities,
    eligibility_filter: values.eligibilityFilter,
    industry: values.industry || null,
    budget_bucket: values.budgetBucket || null,
    timeline_bucket: values.timelineBucket || null,
    additional_criterion_name: values.additionalCriterionName || null,
    deadline_to_respond: values.deadlineToRespond || null,
    min_tier: values.eligibilityFilter === 'by_min_tier' ? values.minTier || null : null,
    explicit_agency_ids: values.eligibilityFilter === 'explicit' ? explicitIds : null,
    notes: values.notes || null,
  }
}

/* ----- Eligibility custom-group component ---------------------------- */

function EligibilityGroup({ values, setValue, errors }: CrudFormGroupComponentProps) {
  const eligibilityFilter = (values.eligibilityFilter as string) || 'all_active'
  const minTier = (values.minTier as string) ?? ''
  const explicitAgencyIds = (values.explicitAgencyIds as string) ?? ''
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Eligibility filter <span className="text-destructive">*</span>
        </span>
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={eligibilityFilter}
          onChange={(e) => {
            const next = e.target.value
            setValue('eligibilityFilter', next)
            // Clear the now-irrelevant companion so the schema validates and
            // the API payload omits it.
            if (next !== 'by_min_tier') setValue('minTier', '')
            if (next !== 'explicit') setValue('explicitAgencyIds', '')
          }}
        >
          <option value="all_active">All active agencies</option>
          <option value="by_min_tier">By minimum tier</option>
          <option value="explicit">Explicit agency list</option>
        </select>
      </label>
      {eligibilityFilter === 'by_min_tier' ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            Minimum tier <span className="text-destructive">*</span>
          </span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={minTier}
            onChange={(e) => setValue('minTier', e.target.value)}
          >
            <option value="">—</option>
            <option value="om_agency">OM Agency</option>
            <option value="ai_native">AI-Native</option>
            <option value="ai_native_expert">AI-Native Expert</option>
            <option value="ai_native_core">AI-Native Core</option>
          </select>
          {errors.minTier ? (
            <span className="text-xs text-destructive" role="alert">
              {errors.minTier}
            </span>
          ) : null}
        </label>
      ) : null}
      {eligibilityFilter === 'explicit' ? (
        <label className="col-span-1 flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium">
            Explicit agency IDs <span className="text-destructive">*</span>
          </span>
          <Textarea
            className="min-h-20"
            value={explicitAgencyIds}
            onChange={(e) => setValue('explicitAgencyIds', e.target.value)}
          />
          <span className="text-xs text-muted-foreground">Comma-separated UUIDs.</span>
          {errors.explicitAgencyIds ? (
            <span className="text-xs text-destructive" role="alert">
              {errors.explicitAgencyIds}
            </span>
          ) : null}
        </label>
      ) : null}
    </div>
  )
}

/**
 * Build the field/group config used by both create and edit pages.
 * The eligibility trio lives in a custom-component group; everything else
 * is a regular CrudForm field.
 */
export function buildRfpFormConfig(
  t: (key: string, fallback?: string) => string,
  tagOptions: {
    /** Pre-loaded tenant-wide tech tag suggestions for `requiredCapabilities`. */
    capabilities?: Array<{ value: string; label: string }>
  } = {},
): {
  fields: CrudField[]
  groups: CrudFormGroup[]
} {
  const fields: CrudField[] = [
    { id: 'title', label: t('prm.rfp.fields.title', 'Title'), type: 'text', required: true },
    {
      id: 'receivedFrom',
      label: t('prm.rfp.fields.receivedFrom', 'Received from'),
      type: 'text',
      required: true,
      layout: 'half',
      description: t('prm.rfp.fields.receivedFrom.help', 'Client / prospect name as received.'),
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
      type: 'tags',
      options: tagOptions.capabilities ?? [],
      description: t(
        'prm.rfp.fields.requiredCapabilities.help',
        'Open vocabulary — type to add. Suggestions come from the agency network (tech capabilities + case-study tech).',
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
    { id: 'notes', label: t('prm.rfp.fields.notes', 'Internal notes'), type: 'textarea' },
  ]

  const groups: CrudFormGroup[] = [
    {
      id: 'core',
      title: t('prm.rfp.form.groups.core', 'Core'),
      column: 1,
      fields: ['title', 'receivedFrom', 'receivedAt', 'description'],
    },
    {
      id: 'requirements',
      title: t('prm.rfp.form.groups.requirements', 'Requirements'),
      column: 2,
      fields: ['techRequirements', 'domainRequirements', 'requiredCapabilities'],
    },
    {
      id: 'context',
      title: t('prm.rfp.form.groups.context', 'Deal context'),
      column: 1,
      fields: ['industry', 'budgetBucket', 'timelineBucket', 'deadlineToRespond'],
    },
    {
      id: 'scoring',
      title: t('prm.rfp.form.groups.scoring', 'Scoring'),
      column: 2,
      fields: ['additionalCriterionName'],
    },
    {
      id: 'eligibility',
      title: t('prm.rfp.form.groups.eligibility', 'Eligibility'),
      column: 1,
      component: EligibilityGroup,
    },
    {
      id: 'notes',
      title: t('prm.rfp.form.groups.notes', 'Notes'),
      column: 2,
      fields: ['notes'],
    },
  ]

  return { fields, groups }
}
