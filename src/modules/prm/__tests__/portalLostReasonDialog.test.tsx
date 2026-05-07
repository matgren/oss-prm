/**
 * Phase 2 — DS migration coverage for the inline "mark prospect as lost"
 * confirmation card on the partner portal.
 *
 * Replaces a hand-rolled `border-rose-300 bg-rose-50` `<section>` (no
 * `dark:` overrides — broke under `.dark` cookie state) with the OM
 * `<Alert variant="destructive">` primitive that follows the semantic
 * `--status-error-{bg,text,border}` tokens shipped in `globals.css`.
 *
 * Pure-logic / structural test (project's jest env is `node`, not jsdom —
 * see `jest.config.cjs`). We import the extracted `LostReasonDialog` (so we
 * sidestep the parent page's transitive ESM imports) and assert:
 *
 *   - the wrapper is the `<Alert>` primitive with `variant="destructive"`;
 *   - the wrapper has NO regression of the old `bg-rose-*` / `border-rose-*`
 *     utility classes;
 *   - the OM dialog keyboard contract holds: `Escape` cancels at any time;
 *     `Cmd/Ctrl+Enter` submits ONLY when reason ≥ 10 chars and not busy.
 *
 * The keyboard contract is identical in shape to `confirmDialog.test.ts` /
 * `reasonDialog.test.ts` already in this module — same dispatch / classify
 * pattern.
 */
import * as React from 'react'
import { Alert } from '@open-mercato/ui/primitives/alert'
import {
  LostReasonDialog,
  classifyLostReasonKey,
} from '../frontend/[orgSlug]/portal/_components/LostReasonDialog'

function asReactElement(value: React.ReactNode): React.ReactElement {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('expected a React element, got: ' + JSON.stringify(value))
  }
  return value as React.ReactElement
}

describe('PRM portal — LostReasonDialog (DS migration: destructive Alert)', () => {
  describe('renders the right OM primitive', () => {
    const baseProps = {
      reason: 'lost because budget cut',
      onReasonChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    }

    it('wraps in <Alert variant="destructive">', () => {
      const tree = asReactElement(LostReasonDialog(baseProps))
      expect(tree.type).toBe(Alert)
      expect((tree.props as { variant?: string }).variant).toBe('destructive')
    })

    it('does NOT carry hardcoded rose/red utility classes on the wrapper', () => {
      const tree = asReactElement(LostReasonDialog(baseProps))
      const className = (tree.props as { className?: string }).className ?? ''
      // Regression guard: the legacy card used `border-rose-300 bg-rose-50` —
      // those classes had no dark-mode pair and broke the partner portal under
      // `.dark`. The new wrapper must not re-introduce them.
      expect(className).not.toMatch(/bg-rose/)
      expect(className).not.toMatch(/border-rose/)
      expect(className).not.toMatch(/text-rose/)
    })

    it('attaches the keyboard handler so Escape / Cmd-Enter are scoped to the dialog', () => {
      const tree = asReactElement(LostReasonDialog(baseProps))
      const handler = (tree.props as { onKeyDown?: unknown }).onKeyDown
      expect(typeof handler).toBe('function')
    })
  })

  describe('classifyLostReasonKey — keyboard contract (mirrors onKeyDown)', () => {
    const READY = { reason: 'lost because budget cut' /* 23 chars */ }
    const TOO_SHORT = { reason: 'too short' /* 9 chars */ }
    const READY_BUSY = { ...READY, submitting: true }

    it('Cmd+Enter when reason is ready → submit', () => {
      expect(classifyLostReasonKey({ key: 'Enter', metaKey: true }, READY)).toBe('submit')
    })
    it('Ctrl+Enter when reason is ready → submit', () => {
      expect(classifyLostReasonKey({ key: 'Enter', ctrlKey: true }, READY)).toBe('submit')
    })
    it('Cmd+Enter while submitting → noop (busy gate)', () => {
      expect(classifyLostReasonKey({ key: 'Enter', metaKey: true }, READY_BUSY)).toBe('noop')
    })
    it('Cmd+Enter when reason < 10 chars → noop (audit-trail invariant)', () => {
      expect(classifyLostReasonKey({ key: 'Enter', metaKey: true }, TOO_SHORT)).toBe('noop')
    })
    it('plain Enter never submits — keeps contract aligned with reasonDialog', () => {
      expect(classifyLostReasonKey({ key: 'Enter' }, READY)).toBe('noop')
    })

    it('Escape when idle → cancel', () => {
      expect(classifyLostReasonKey({ key: 'Escape' }, READY)).toBe('cancel')
    })
    it('Escape while submitting → still cancel (user can always abort intent)', () => {
      expect(classifyLostReasonKey({ key: 'Escape' }, READY_BUSY)).toBe('cancel')
    })
    it('Escape when reason is too short → still cancel', () => {
      expect(classifyLostReasonKey({ key: 'Escape' }, TOO_SHORT)).toBe('cancel')
    })

    it('unrelated keys never dispatch', () => {
      expect(classifyLostReasonKey({ key: 'a' }, READY)).toBe('noop')
      expect(classifyLostReasonKey({ key: 'Tab' }, READY)).toBe('noop')
      expect(classifyLostReasonKey({ key: 'Meta', metaKey: true }, READY)).toBe('noop')
    })
  })
})
