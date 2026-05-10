import { z } from 'zod'
import { llmProviderRegistry } from '@open-mercato/shared/lib/ai/llm-provider-registry'
import { Rfp, RfpResponse } from '../data/entities'
import { PRM_ERROR_CODES, PrmDomainError, isPrmDomainError } from './errors'

/**
 * LLM-assisted scoring draft (Spec #6 §3.2 — US5.6 LLM).
 *
 * Composes a structured-output prompt from the RFP brief + RfpResponse
 * markdown text, calls the configured LLM provider, and returns the
 * provider's recommended scores + reasoning. NEVER persists — the OM
 * PartnerOps user reviews + edits, then commits via §3.1.
 *
 * Provider resolution: walks `llmProviderRegistry.resolveFirstConfigured()`
 * with `['anthropic', 'openai', 'google']` priority (matches the
 * `ai_assistant` core module's default order). Returns `503 LLM_UNAVAILABLE`
 * when no provider has credentials.
 *
 * Bootstrap: on first call this module attempts to dynamically import
 * `@open-mercato/ai-assistant` to trigger its `llm-bootstrap` side effect
 * which populates the registry with built-in adapters. If the import
 * fails (module not installed in this deployment), the registry is left
 * empty and the route returns 503 — graceful degradation rather than a
 * hard build-time dependency.
 */

const ScoringDraftSchema = z.object({
  tech_fit_score: z.number().int().min(0).max(5),
  domain_fit_score: z.number().int().min(0).max(5),
  optional_score: z.number().int().min(0).max(5).nullable(),
  reasoning: z.string().min(10).max(8_000),
})

export type ScoringDraft = z.infer<typeof ScoringDraftSchema> & {
  /** Provider/model identifier for audit (`anthropic:claude-sonnet-4-…`). */
  llm_model_id: string
}

/**
 * Side-effect import that triggers `@open-mercato/ai-assistant`'s
 * `llm-bootstrap.ts` which registers the built-in adapters with
 * `llmProviderRegistry`. Wrapped in dynamic import so a deployment without
 * the ai-assistant module still type-checks and serves a clean 503.
 *
 * Memoised: bootstrap runs at most once per process; subsequent calls
 * are no-ops.
 */
let bootstrapped = false
let bootstrapInFlight: Promise<void> | null = null

async function ensureBootstrapped(): Promise<void> {
  if (bootstrapped) return
  if (bootstrapInFlight) return bootstrapInFlight
  bootstrapInFlight = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      await import('@open-mercato/ai-assistant/ai-sdk' as any)
    } catch {
      // Ignore — registry just stays empty and the consumer returns 503.
    } finally {
      bootstrapped = true
      bootstrapInFlight = null
    }
  })()
  return bootstrapInFlight
}

/**
 * Helper for tests — resets the bootstrap memoisation so the next call
 * re-imports the bootstrap module. Intentionally not exported from the
 * package barrel.
 */
export function __resetLlmBootstrapForTests(): void {
  bootstrapped = false
  bootstrapInFlight = null
}

/**
 * Builds the structured-output prompt. Centralised so the test suite can
 * snapshot it. Composition matches spec §2 — RFP brief + rubric criteria
 * + the agency's response markdown.
 */
export function buildScoringPrompt(args: { rfp: Rfp; response: RfpResponse }): string {
  const { rfp, response } = args
  return `You are a senior agency selector reviewing an RFP response. Score the
following RFPResponse against the RFP's tech and domain requirements on a
0..5 scale per dimension. Tech fit measures how strongly the agency's
described tech experience covers the RFP's tech_requirements. Domain fit
measures alignment between the agency's domain experience and the RFP's
domain_requirements. Optional score (when applicable) covers any additional
criterion the RFP names. Be evidence-driven — penalize generic claims.

# RFP brief
Title: ${rfp.title}
Description: ${rfp.description}
Tech requirements: ${rfp.techRequirements}
Domain requirements: ${rfp.domainRequirements}
Additional criterion: ${rfp.additionalCriterionName ?? '(none)'}

# RFPResponse
Tech experience:
${response.techExperience ?? '(empty)'}

Domain experience:
${response.domainExperience ?? '(empty)'}

Differentiators:
${response.differentiators ?? '(empty)'}

# Output
Return:
- tech_fit_score (integer 0..5)
- domain_fit_score (integer 0..5)
- optional_score (integer 0..5 or null when the RFP has no additional criterion)
- reasoning (10..8000 chars; cite evidence from the response text)
`
}

/**
 * Generates a draft score using the first configured LLM provider.
 *
 * Throws `PrmDomainError(LLM_UNAVAILABLE, 503)` when no provider is
 * configured or the provider call fails. The route layer surfaces those
 * to the UI which falls back to manual-only scoring.
 */
export async function generateScoringDraft(args: {
  rfp: Rfp
  response: RfpResponse
}): Promise<ScoringDraft> {
  await ensureBootstrapped()
  const provider = llmProviderRegistry.resolveFirstConfigured({
    order: ['anthropic', 'openai', 'google'],
  })
  if (!provider) {
    throw new PrmDomainError(
      PRM_ERROR_CODES.LLM_UNAVAILABLE,
      'No LLM provider configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY.',
      503,
    )
  }
  const apiKey = provider.resolveApiKey()
  if (!apiKey) {
    throw new PrmDomainError(
      PRM_ERROR_CODES.LLM_UNAVAILABLE,
      `API key missing for provider "${provider.id}".`,
      503,
    )
  }
  const modelId = provider.defaultModel
  const model = provider.createModel({ modelId, apiKey })

  // Lazy-import `'ai'` to avoid eager loading at module evaluation —
  // keeps Jest startup snappy in tests that mock the provider entirely.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateObject } = (await import('ai')) as typeof import('ai')

  const prompt = buildScoringPrompt({ rfp: args.rfp, response: args.response })
  try {
    const result = await generateObject({
      model: model as any,
      schema: ScoringDraftSchema as any,
      prompt,
    })
    const parsed = ScoringDraftSchema.safeParse(result.object)
    if (!parsed.success) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LLM_UNAVAILABLE,
        'LLM returned a non-schema response.',
        503,
        { issues: parsed.error.flatten().fieldErrors },
      )
    }
    return {
      ...parsed.data,
      llm_model_id: `${provider.id}:${modelId}`,
    }
  } catch (err) {
    if (isPrmDomainError(err)) throw err
    const message =
      err instanceof Error ? err.message : 'LLM provider call failed'
    throw new PrmDomainError(PRM_ERROR_CODES.LLM_UNAVAILABLE, message, 503)
  }
}

/**
 * Test-only adapter override. Lets unit tests inject a mock provider
 * without touching the singleton registry. Production code path goes
 * through `llmProviderRegistry`.
 */
export const __TEST_HOOKS__ = {
  schema: ScoringDraftSchema,
}
