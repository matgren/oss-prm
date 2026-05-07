/**
 * Phase 3.1 — DS migration coverage for the agency profile onboarding chips
 * (Contract / NDA / Onboarded), now rendered via OM `<StatusBadge>` instead
 * of hand-rolled `bg-emerald-50 text-emerald-800` spans.
 *
 * Pure-logic / structural test (project's jest env is `node`, not jsdom —
 * see `jest.config.cjs`). We import the extracted `OnboardingChips` and
 * assert each rendered chip is a `<StatusBadge variant="success">` and has
 * NO regression of the legacy emerald utility classes.
 *
 * Tone justification: all three chips signal a positive completion / trust
 * milestone — `success` is the only fit (vs `info` for neutral state, or
 * `warning` for unmet expectations). Documented in the component file.
 */
import * as React from 'react'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { OnboardingChips } from '../frontend/[orgSlug]/portal/_components/OnboardingChips'

function renderToArray(node: React.ReactNode): React.ReactElement[] {
  // Components return a Fragment whose `children` is the array of conditional
  // chips. Walk that into a typed array of React elements (skipping nulls).
  if (!node || typeof node !== 'object' || !('type' in node)) {
    return []
  }
  const tree = node as React.ReactElement
  const inner = (tree.props as { children?: React.ReactNode }).children
  const arr = Array.isArray(inner) ? inner : [inner]
  return arr.filter((child): child is React.ReactElement => {
    return Boolean(child) && typeof child === 'object' && 'type' in (child as object)
  })
}

describe('PRM portal — OnboardingChips (DS migration: success StatusBadge)', () => {
  it('renders all three chips when every flag is set', () => {
    const tree = OnboardingChips({ contractSigned: true, ndaSigned: true, onboarded: true })
    const chips = renderToArray(tree)
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip.type).toBe(StatusBadge)
      expect((chip.props as { variant?: string }).variant).toBe('success')
    }
  })

  it('omits chips for unset flags (no-op for false / undefined)', () => {
    expect(renderToArray(OnboardingChips({}))).toHaveLength(0)
    expect(
      renderToArray(OnboardingChips({ contractSigned: true })),
    ).toHaveLength(1)
    expect(
      renderToArray(OnboardingChips({ contractSigned: true, ndaSigned: true })),
    ).toHaveLength(2)
    expect(
      renderToArray(OnboardingChips({ contractSigned: false, ndaSigned: false, onboarded: false })),
    ).toHaveLength(0)
  })

  it('does NOT carry hardcoded emerald utility classes on any chip', () => {
    const chips = renderToArray(
      OnboardingChips({ contractSigned: true, ndaSigned: true, onboarded: true }),
    )
    for (const chip of chips) {
      const className = (chip.props as { className?: string }).className ?? ''
      // Regression guard: legacy chips used `bg-emerald-50 text-emerald-800`.
      expect(className).not.toMatch(/bg-emerald/)
      expect(className).not.toMatch(/text-emerald/)
      expect(className).not.toMatch(/border-emerald/)
    }
  })

  it('uses i18n keys when `t` is provided', () => {
    const seen: string[] = []
    const fakeT = (key: string, _fallback?: string) => {
      seen.push(key)
      return `<<${key}>>`
    }
    const chips = renderToArray(
      OnboardingChips({
        contractSigned: true,
        ndaSigned: true,
        onboarded: true,
        t: fakeT,
      }),
    )
    expect(seen).toEqual([
      'prm.portal.agency.chip.contract',
      'prm.portal.agency.chip.nda',
      'prm.portal.agency.chip.onboarded',
    ])
    expect((chips[0].props as { children?: React.ReactNode }).children).toBe(
      '<<prm.portal.agency.chip.contract>>',
    )
  })

  it('falls back to the English labels when `t` is not provided', () => {
    const chips = renderToArray(
      OnboardingChips({ contractSigned: true, ndaSigned: true, onboarded: true }),
    )
    expect((chips[0].props as { children?: React.ReactNode }).children).toBe('Contract')
    expect((chips[1].props as { children?: React.ReactNode }).children).toBe('NDA')
    expect((chips[2].props as { children?: React.ReactNode }).children).toBe('Onboarded')
  })
})
