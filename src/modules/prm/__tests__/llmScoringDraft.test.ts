import { llmProviderRegistry } from '@open-mercato/shared/lib/ai/llm-provider-registry'
import { generateScoringDraft, buildScoringPrompt, __resetLlmBootstrapForTests } from '../lib/llmScoringDraft'
import { PRM_ERROR_CODES } from '../lib/errors'
import type { Rfp, RfpResponse } from '../data/entities'

/**
 * Spec #6 — LLM-assist draft endpoint helper tests.
 *
 * Mocks:
 *   - `'ai'`'s `generateObject` is module-mocked to return a deterministic
 *     payload, avoiding any real network call.
 *   - `llmProviderRegistry` is reset between tests so we can register a
 *     stub provider.
 */

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}))

const aiModule = jest.requireMock('ai') as { generateObject: jest.Mock }

function makeFakeRfp(): Rfp {
  return {
    id: 'rfp-1',
    organizationId: 'o-1',
    title: 'Test RFP',
    description: 'Description',
    techRequirements: 'React/TS',
    domainRequirements: 'Fintech',
    additionalCriterionName: null,
    receivedFrom: 'Acme',
    receivedAt: new Date(),
    industry: null,
    budgetBucket: null,
    timelineBucket: null,
    requiredCapabilities: [],
    deadlineToRespond: null,
    eligibilityFilter: 'all_active',
    minTier: null,
    explicitAgencyIds: null,
    status: 'scoring',
    selectedAgencyId: null,
    selectionDecidedAt: null,
    selectionDecidedByUserId: null,
    selectionReasoning: null,
    isPathBLocked: false,
    notes: null,
    createdByUserId: 'user-1',
    publishedAt: new Date(),
    closedAt: null,
    reopenedDeadlineAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  } as unknown as Rfp
}

function makeFakeResponse(status: 'submitted' | 'draft' = 'submitted'): RfpResponse {
  return {
    id: 'resp-1',
    organizationId: 'o-1',
    rfpId: 'rfp-1',
    agencyId: 'agency-1',
    submittedByMemberId: 'mem-1',
    status,
    techExperience: 'We use React + TypeScript daily.',
    domainExperience: 'Multiple fintech production deployments.',
    differentiators: null,
    attachedCaseStudyIds: [],
    firstSubmittedAt: new Date(),
    lastUpdatedAt: new Date(),
    challengeRoundUpdatedAt: null,
    createdAt: new Date(),
  } as unknown as RfpResponse
}

function registerStubProvider(opts: {
  configured: boolean
  apiKey: string | null
  modelId?: string
}): void {
  llmProviderRegistry.reset()
  llmProviderRegistry.register({
    id: 'anthropic',
    name: 'Anthropic',
    envKeys: ['ANTHROPIC_API_KEY'],
    defaultModel: opts.modelId ?? 'claude-sonnet-4-test',
    defaultModels: [
      { id: 'claude-sonnet-4-test', name: 'Claude Sonnet 4 (test)', contextWindow: 200_000 },
    ],
    isConfigured() {
      return opts.configured
    },
    resolveApiKey() {
      return opts.apiKey
    },
    getConfiguredEnvKey() {
      return 'ANTHROPIC_API_KEY'
    },
    createModel() {
      return { __mock: true }
    },
  })
}

describe('buildScoringPrompt', () => {
  it('embeds the RFP brief and response markdown', () => {
    const prompt = buildScoringPrompt({ rfp: makeFakeRfp(), response: makeFakeResponse() })
    expect(prompt).toContain('# RFP brief')
    expect(prompt).toContain('Title: Test RFP')
    expect(prompt).toContain('Tech requirements: React/TS')
    expect(prompt).toContain('Domain requirements: Fintech')
    expect(prompt).toContain('Multiple fintech production deployments.')
  })

  it('renders empty placeholders for missing fields', () => {
    const response = makeFakeResponse()
    response.techExperience = null
    response.domainExperience = null
    response.differentiators = null
    const prompt = buildScoringPrompt({ rfp: makeFakeRfp(), response })
    expect(prompt).toContain('Tech experience:\n(empty)')
    expect(prompt).toContain('Domain experience:\n(empty)')
  })
})

describe('generateScoringDraft', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetLlmBootstrapForTests()
    llmProviderRegistry.reset()
  })

  it('returns a draft when the provider succeeds', async () => {
    registerStubProvider({ configured: true, apiKey: 'sk-test' })
    aiModule.generateObject.mockResolvedValue({
      object: {
        tech_fit_score: 4,
        domain_fit_score: 3,
        optional_score: null,
        reasoning: 'Strong technical alignment with named-client evidence.',
      },
    })
    const draft = await generateScoringDraft({
      rfp: makeFakeRfp(),
      response: makeFakeResponse(),
    })
    expect(draft.tech_fit_score).toBe(4)
    expect(draft.domain_fit_score).toBe(3)
    expect(draft.optional_score).toBeNull()
    expect(draft.llm_model_id).toBe('anthropic:claude-sonnet-4-test')
    expect(aiModule.generateObject).toHaveBeenCalledTimes(1)
  })

  it('returns 503 LLM_UNAVAILABLE when no provider configured', async () => {
    // Registry is empty after reset.
    await expect(
      generateScoringDraft({ rfp: makeFakeRfp(), response: makeFakeResponse() }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.LLM_UNAVAILABLE,
      status: 503,
    })
    expect(aiModule.generateObject).not.toHaveBeenCalled()
  })

  it('returns 503 when provider has no API key', async () => {
    registerStubProvider({ configured: true, apiKey: null })
    await expect(
      generateScoringDraft({ rfp: makeFakeRfp(), response: makeFakeResponse() }),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('returns 503 when provider call throws', async () => {
    registerStubProvider({ configured: true, apiKey: 'sk-test' })
    aiModule.generateObject.mockRejectedValue(new Error('rate limited'))
    await expect(
      generateScoringDraft({ rfp: makeFakeRfp(), response: makeFakeResponse() }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.LLM_UNAVAILABLE,
      status: 503,
    })
  })

  it('returns 503 when provider returns a non-schema response', async () => {
    registerStubProvider({ configured: true, apiKey: 'sk-test' })
    aiModule.generateObject.mockResolvedValue({
      object: {
        tech_fit_score: 9, // out of range
        domain_fit_score: 3,
        optional_score: null,
        reasoning: 'short',
      },
    })
    await expect(
      generateScoringDraft({ rfp: makeFakeRfp(), response: makeFakeResponse() }),
    ).rejects.toMatchObject({
      code: PRM_ERROR_CODES.LLM_UNAVAILABLE,
      status: 503,
    })
  })
})
