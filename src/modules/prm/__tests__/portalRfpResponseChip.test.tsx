/**
 * Phase 3.2 — DS migration coverage for the RFP inbox "responded" chip,
 * now rendered via OM `<StatusBadge variant="success">` instead of a
 * hand-rolled `bg-emerald-50 text-emerald-900` span (which had `dark:`
 * overrides — but the migration standardizes on the OM primitive for
 * consistency with the agency profile chips).
 *
 * Pure-logic / structural test (project's jest env is `node`, not jsdom —
 * see `jest.config.cjs`). Same discipline as the other portal DS tests in
 * this module. Asserts:
 *
 *   - the chip's wrapper is `<StatusBadge variant="success">`;
 *   - NO regression of the legacy `bg-emerald-*` / `text-emerald-*` /
 *     `border-emerald-*` utility classes;
 *   - the legacy `data-testid="rfp-badge-responded"` hook is preserved so
 *     the existing Playwright fixtures (TC-PRM-T5-003 etc.) still match;
 *   - the right label is rendered for `submitted` vs `draft`, with i18n
 *     wiring through the optional `t` prop.
 *
 * Tone justification: response existence (draft or submitted) is positive
 * partner engagement on a shipped RFP — `success` is the right tone.
 */
import * as React from 'react'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { RfpResponseStatusChip } from '../frontend/[orgSlug]/portal/_components/RfpResponseStatusChip'

function asReactElement(value: React.ReactNode): React.ReactElement {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('expected a React element, got: ' + JSON.stringify(value))
  }
  return value as React.ReactElement
}

describe('PRM portal — RfpResponseStatusChip (DS migration: success StatusBadge)', () => {
  it('wraps in <StatusBadge variant="success"> for submitted', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'submitted' }))
    expect(tree.type).toBe(StatusBadge)
    expect((tree.props as { variant?: string }).variant).toBe('success')
  })

  it('wraps in <StatusBadge variant="success"> for draft', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'draft' }))
    expect(tree.type).toBe(StatusBadge)
    expect((tree.props as { variant?: string }).variant).toBe('success')
  })

  it('does NOT carry hardcoded emerald utility classes on the wrapper', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'submitted' }))
    const className = (tree.props as { className?: string }).className ?? ''
    expect(className).not.toMatch(/bg-emerald/)
    expect(className).not.toMatch(/text-emerald/)
    expect(className).not.toMatch(/border-emerald/)
  })

  it('preserves the data-testid hook for existing Playwright fixtures', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'submitted' }))
    const inner = asReactElement((tree.props as { children?: React.ReactNode }).children as React.ReactNode)
    expect(inner.type).toBe('span')
    expect((inner.props as { 'data-testid'?: string })['data-testid']).toBe('rfp-badge-responded')
  })

  it('renders "Submitted" label for submitted status (English fallback)', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'submitted' }))
    const inner = asReactElement((tree.props as { children?: React.ReactNode }).children as React.ReactNode)
    expect((inner.props as { children?: React.ReactNode }).children).toBe('Submitted')
  })

  it('renders "Draft saved" label for draft status (English fallback)', () => {
    const tree = asReactElement(RfpResponseStatusChip({ status: 'draft' }))
    const inner = asReactElement((tree.props as { children?: React.ReactNode }).children as React.ReactNode)
    expect((inner.props as { children?: React.ReactNode }).children).toBe('Draft saved')
  })

  it('uses i18n keys when `t` is provided', () => {
    const fakeT = (key: string, _fallback?: string) => `<<${key}>>`
    const submitted = asReactElement(RfpResponseStatusChip({ status: 'submitted', t: fakeT }))
    const submittedInner = asReactElement(
      (submitted.props as { children?: React.ReactNode }).children as React.ReactNode,
    )
    expect((submittedInner.props as { children?: React.ReactNode }).children).toBe(
      '<<prm.portal.rfp.badge.submitted>>',
    )

    const draft = asReactElement(RfpResponseStatusChip({ status: 'draft', t: fakeT }))
    const draftInner = asReactElement(
      (draft.props as { children?: React.ReactNode }).children as React.ReactNode,
    )
    expect((draftInner.props as { children?: React.ReactNode }).children).toBe(
      '<<prm.portal.rfp.badge.draft>>',
    )
  })
})
