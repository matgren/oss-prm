import {
  classifyDialogKey,
  isReasonValid,
  MIN_REASON_LENGTH,
} from '../backend/prm/license-deals/[id]/reasonDialog'
import {
  reverseLicenseDealSchema,
  unreverseLicenseDealStatusSchema,
} from '../data/validators'

/**
 * Component-test surface for the B5 reverse / unreverse-status reason dialog.
 *
 * The dialog is rendered into a real DOM in the page route at
 * `src/modules/prm/backend/prm/license-deals/[id]/page.tsx`. This test guards
 * the *contract* surface — keyboard intent classification + reason validation
 * predicate — that the dialog uses to decide whether Cmd/Ctrl+Enter submits
 * and whether Escape cancels. Keeping the predicates pure means we can unit
 * test them under the standalone-app's `node` jest env (no jsdom dependency)
 * and still get full coverage of the logic that previously lived inside
 * `window.prompt`.
 */
describe('reasonDialog — keyboard + validation contract (B5 reverse/unreverse)', () => {
  describe('isReasonValid', () => {
    it('rejects strings shorter than 10 chars after trim', () => {
      expect(isReasonValid('')).toBe(false)
      expect(isReasonValid('   ')).toBe(false)
      expect(isReasonValid('too short')).toBe(false) // 9 chars
      expect(isReasonValid('  9 chars  ')).toBe(false) // trims to 7
    })
    it('accepts strings of exactly 10 chars after trim', () => {
      expect(isReasonValid('1234567890')).toBe(true)
      expect(isReasonValid('  1234567890  ')).toBe(true)
    })
    it('accepts long reasons', () => {
      expect(isReasonValid('Reason for reversal: client invoked Path C correction.')).toBe(true)
    })
    it('matches the constant exposed for downstream consumers', () => {
      expect(MIN_REASON_LENGTH).toBe(10)
    })
    it('agrees with the reverse server-side schema (>=10 chars)', () => {
      const ok = reverseLicenseDealSchema.safeParse({ reason: 'A'.repeat(10) })
      const ko = reverseLicenseDealSchema.safeParse({ reason: 'A'.repeat(9) })
      expect(ok.success).toBe(true)
      expect(ko.success).toBe(false)
      expect(isReasonValid('A'.repeat(10))).toBe(true)
      expect(isReasonValid('A'.repeat(9))).toBe(false)
    })
    it('agrees with the unreverse-status server-side schema (>=10 chars)', () => {
      const ok = unreverseLicenseDealStatusSchema.safeParse({
        toStatus: 'signed',
        reason: 'A'.repeat(10),
      })
      const ko = unreverseLicenseDealStatusSchema.safeParse({
        toStatus: 'signed',
        reason: 'short',
      })
      expect(ok.success).toBe(true)
      expect(ko.success).toBe(false)
    })
  })

  describe('classifyDialogKey (AGENTS dialog convention)', () => {
    it('classifies Escape as cancel', () => {
      expect(classifyDialogKey({ key: 'Escape' })).toBe('cancel')
      expect(classifyDialogKey({ key: 'Escape', metaKey: true })).toBe('cancel')
    })
    it('classifies Cmd+Enter as submit', () => {
      expect(classifyDialogKey({ key: 'Enter', metaKey: true })).toBe('submit')
    })
    it('classifies Ctrl+Enter as submit (Windows / Linux)', () => {
      expect(classifyDialogKey({ key: 'Enter', ctrlKey: true })).toBe('submit')
    })
    it('treats plain Enter as none — typing newlines in the textarea must not submit', () => {
      expect(classifyDialogKey({ key: 'Enter' })).toBe('none')
    })
    it('treats Cmd alone, Ctrl alone, and unrelated keys as none', () => {
      expect(classifyDialogKey({ key: 'Meta', metaKey: true })).toBe('none')
      expect(classifyDialogKey({ key: 'Control', ctrlKey: true })).toBe('none')
      expect(classifyDialogKey({ key: 'a' })).toBe('none')
      expect(classifyDialogKey({ key: 'Tab' })).toBe('none')
    })
  })

  describe('end-to-end keyboard intent → action gating', () => {
    /**
     * Simulates what the dialog does at runtime: receive a key event, classify
     * intent, and only fire onConfirm when the reason is valid. Mirrors the
     * branching inside `<ReasonDialog onKeyDown>` so a regression in either
     * predicate is caught here.
     */
    function dispatch(
      reason: string,
      event: { key: string; metaKey?: boolean; ctrlKey?: boolean },
    ): { confirmed: boolean; cancelled: boolean } {
      const intent = classifyDialogKey(event)
      let confirmed = false
      let cancelled = false
      if (intent === 'cancel') cancelled = true
      else if (intent === 'submit' && isReasonValid(reason)) confirmed = true
      return { confirmed, cancelled }
    }

    it('Cmd+Enter with a valid reason → confirmed', () => {
      const r = dispatch('Long enough reason', { key: 'Enter', metaKey: true })
      expect(r).toEqual({ confirmed: true, cancelled: false })
    })

    it('Cmd+Enter with too short a reason → no dispatch (matches server validation)', () => {
      const r = dispatch('short', { key: 'Enter', metaKey: true })
      expect(r).toEqual({ confirmed: false, cancelled: false })
    })

    it('Escape always cancels regardless of reason validity', () => {
      const r1 = dispatch('', { key: 'Escape' })
      const r2 = dispatch('Valid reason here', { key: 'Escape' })
      expect(r1).toEqual({ confirmed: false, cancelled: true })
      expect(r2).toEqual({ confirmed: false, cancelled: true })
    })

    it('plain Enter never confirms — newline in the textarea is preserved', () => {
      const r = dispatch('Valid reason for reversal', { key: 'Enter' })
      expect(r).toEqual({ confirmed: false, cancelled: false })
    })
  })
})
