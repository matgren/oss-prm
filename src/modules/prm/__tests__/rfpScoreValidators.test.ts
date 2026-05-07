import {
  RFP_RESPONSE_SCORE_SOURCES,
  RFP_STATUSES,
  recordRfpResponseScoreSchema,
  selectRfpWinnerSchema,
  closeRfpSchema,
  reopenRfpSchema,
} from '../data/validators'

describe('Spec #6 — RFP scoring & selection validators', () => {
  describe('recordRfpResponseScoreSchema', () => {
    const baseManual = {
      tech_fit_score: 4,
      domain_fit_score: 3,
      optional_score: null,
      include_optional: false,
      reasoning: 'Strong tech depth, evidence cited from public docs.',
      source: 'manual',
      llm_model_id: null,
    }

    it('accepts a valid manual score', () => {
      const ok = recordRfpResponseScoreSchema.safeParse(baseManual)
      expect(ok.success).toBe(true)
    })

    it('rejects scores out of range (0..5)', () => {
      const bad = recordRfpResponseScoreSchema.safeParse({ ...baseManual, tech_fit_score: 9 })
      expect(bad.success).toBe(false)
    })

    it('requires reasoning min length 10', () => {
      const bad = recordRfpResponseScoreSchema.safeParse({ ...baseManual, reasoning: 'too short' })
      expect(bad.success).toBe(false)
    })

    it('rejects manual + non-null llm_model_id', () => {
      const bad = recordRfpResponseScoreSchema.safeParse({
        ...baseManual,
        llm_model_id: 'anthropic:claude-sonnet-4',
      })
      expect(bad.success).toBe(false)
      if (!bad.success) {
        expect(bad.error.issues.some((i) => i.path.includes('llm_model_id'))).toBe(true)
      }
    })

    it('rejects llm_assisted with null llm_model_id', () => {
      const bad = recordRfpResponseScoreSchema.safeParse({
        ...baseManual,
        source: 'llm_assisted',
        llm_model_id: null,
      })
      expect(bad.success).toBe(false)
    })

    it('accepts llm_assisted with model id', () => {
      const ok = recordRfpResponseScoreSchema.safeParse({
        ...baseManual,
        source: 'llm_assisted',
        llm_model_id: 'anthropic:claude-sonnet-4-test',
      })
      expect(ok.success).toBe(true)
    })

    it('accepts optional change_reason', () => {
      const ok = recordRfpResponseScoreSchema.safeParse({
        ...baseManual,
        change_reason: 'Re-scored after agency clarification',
      })
      expect(ok.success).toBe(true)
    })
  })

  describe('selectRfpWinnerSchema', () => {
    it('accepts a valid select payload', () => {
      const ok = selectRfpWinnerSchema.safeParse({
        winner_rfp_response_id: '11111111-1111-4111-8111-111111111111',
        selection_reasoning: 'Tech depth + domain fit + named-client evidence.',
      })
      expect(ok.success).toBe(true)
    })

    it('rejects non-uuid winner id', () => {
      const bad = selectRfpWinnerSchema.safeParse({
        winner_rfp_response_id: 'not-a-uuid',
        selection_reasoning: 'long enough reasoning string here.',
      })
      expect(bad.success).toBe(false)
    })

    it('rejects too-short reasoning', () => {
      const bad = selectRfpWinnerSchema.safeParse({
        winner_rfp_response_id: '11111111-1111-4111-8111-111111111111',
        selection_reasoning: 'short',
      })
      expect(bad.success).toBe(false)
    })
  })

  describe('closeRfpSchema', () => {
    it('accepts an empty body (close with selection)', () => {
      const ok = closeRfpSchema.safeParse({})
      expect(ok.success).toBe(true)
    })

    it('accepts a close_reason', () => {
      const ok = closeRfpSchema.safeParse({ close_reason: 'Budget reallocated' })
      expect(ok.success).toBe(true)
    })

    it('rejects too-short close_reason', () => {
      const bad = closeRfpSchema.safeParse({ close_reason: 'no' })
      expect(bad.success).toBe(false)
    })
  })

  describe('reopenRfpSchema', () => {
    it('accepts a valid reopen payload', () => {
      const ok = reopenRfpSchema.safeParse({
        reopen_reason: 'Client added a new requirement',
        reopened_deadline_at: '2026-06-30T12:00:00Z',
      })
      expect(ok.success).toBe(true)
    })

    it('rejects too-short reason', () => {
      const bad = reopenRfpSchema.safeParse({
        reopen_reason: 'short',
        reopened_deadline_at: '2026-06-30T12:00:00Z',
      })
      expect(bad.success).toBe(false)
    })

    it('rejects malformed deadline', () => {
      const bad = reopenRfpSchema.safeParse({
        reopen_reason: 'Client added a new requirement',
        reopened_deadline_at: 'tomorrow',
      })
      expect(bad.success).toBe(false)
    })
  })

  describe('enums', () => {
    it('exposes the source enum verbatim', () => {
      expect(RFP_RESPONSE_SCORE_SOURCES).toEqual(['manual', 'llm_assisted'])
    })

    it('extends RFP status enum with reopened', () => {
      expect(RFP_STATUSES).toContain('reopened')
      // Spec #5 enum still present.
      expect(RFP_STATUSES).toContain('selection_made')
      expect(RFP_STATUSES).toContain('closed')
    })
  })
})
