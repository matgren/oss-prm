import { classifyDialogKey } from '../backend/prm/license-deals/[id]/reasonDialog'

/**
 * Component-test surface for the B5 confirm-only dialog (POST-MVP soft-delete).
 *
 * The dialog is rendered into a real DOM in the page route at
 * `src/modules/prm/backend/prm/license-deals/[id]/page.tsx`. Like the existing
 * `reasonDialog.test.ts`, this guards the *contract* surface — keyboard intent
 * + action gating — without spinning up jsdom (which is not in this project's
 * jest env). The dialog re-uses `classifyDialogKey` from `reasonDialog.tsx`
 * so the keyboard convention stays in lockstep across both dialogs.
 *
 * What this file specifically locks down (delta vs reasonDialog.test.ts):
 *   - No textarea / no length-validation gate. Cmd/Ctrl+Enter dispatches as
 *     soon as the dialog is open and not busy.
 *   - `busy` gates the confirm action even when the keyboard intent says
 *     submit (so a double-press during `Deleting…` cannot fire DELETE twice).
 *   - Escape always cancels regardless of busy state.
 */
describe('confirmDialog — keyboard + busy contract (B5 soft-delete)', () => {
  /**
   * Mirrors the branching inside `<ConfirmDialog onKeyDown>`: receive a key
   * event, classify intent, and only fire onConfirm when the dialog is NOT
   * busy. There is no reason-length gate here — the dialog is confirm-only.
   */
  function dispatch(
    busy: boolean,
    event: { key: string; metaKey?: boolean; ctrlKey?: boolean },
  ): { confirmed: boolean; cancelled: boolean } {
    const intent = classifyDialogKey(event)
    let confirmed = false
    let cancelled = false
    if (intent === 'cancel') cancelled = true
    else if (intent === 'submit' && !busy) confirmed = true
    return { confirmed, cancelled }
  }

  describe('Cmd/Ctrl+Enter dispatches without any reason', () => {
    it('Cmd+Enter when idle → confirmed (no reason required)', () => {
      expect(dispatch(false, { key: 'Enter', metaKey: true })).toEqual({
        confirmed: true,
        cancelled: false,
      })
    })
    it('Ctrl+Enter when idle → confirmed (Windows / Linux)', () => {
      expect(dispatch(false, { key: 'Enter', ctrlKey: true })).toEqual({
        confirmed: true,
        cancelled: false,
      })
    })
    it('plain Enter never confirms — keeps the keyboard contract aligned with ReasonDialog', () => {
      expect(dispatch(false, { key: 'Enter' })).toEqual({ confirmed: false, cancelled: false })
    })
  })

  describe('busy gating prevents double-fire during in-flight DELETE', () => {
    it('Cmd+Enter while busy → no dispatch', () => {
      expect(dispatch(true, { key: 'Enter', metaKey: true })).toEqual({
        confirmed: false,
        cancelled: false,
      })
    })
    it('Ctrl+Enter while busy → no dispatch', () => {
      expect(dispatch(true, { key: 'Enter', ctrlKey: true })).toEqual({
        confirmed: false,
        cancelled: false,
      })
    })
  })

  describe('Escape cancels regardless of busy state', () => {
    it('Escape when idle → cancelled', () => {
      expect(dispatch(false, { key: 'Escape' })).toEqual({ confirmed: false, cancelled: true })
    })
    it('Escape while busy → cancelled (user can always abort intent)', () => {
      expect(dispatch(true, { key: 'Escape' })).toEqual({ confirmed: false, cancelled: true })
    })
    it('Escape with modifiers → still cancelled', () => {
      expect(dispatch(false, { key: 'Escape', metaKey: true })).toEqual({
        confirmed: false,
        cancelled: true,
      })
    })
  })

  describe('unrelated keys never dispatch', () => {
    it('letters and modifier keys alone are passthrough', () => {
      expect(dispatch(false, { key: 'a' })).toEqual({ confirmed: false, cancelled: false })
      expect(dispatch(false, { key: 'Tab' })).toEqual({ confirmed: false, cancelled: false })
      expect(dispatch(false, { key: 'Meta', metaKey: true })).toEqual({
        confirmed: false,
        cancelled: false,
      })
      expect(dispatch(false, { key: 'Control', ctrlKey: true })).toEqual({
        confirmed: false,
        cancelled: false,
      })
    })
  })
})
