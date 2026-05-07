/**
 * Phase 1.1–1.3 — DS migration coverage for the shared `PartnerStatusBanner`.
 *
 * The legacy code had THREE near-identical hand-rolled `bg-amber-50
 * text-amber-900` divs across `agency/page.tsx`, `dashboard/page.tsx`, and
 * `members/page.tsx`. They are now replaced by a single shared component at
 * `src/modules/prm/frontend/[orgSlug]/portal/_components/PartnerStatusBanner.tsx`
 * that renders an OM `<Alert variant="warning">` — which means the banner
 * follows the semantic `--status-warning-{bg,text,border}` tokens shipped in
 * `src/app/globals.css` and renders correctly in both light and dark themes.
 *
 * Pure-logic / structural test (project's jest env is `node`, not jsdom — see
 * `jest.config.cjs`). Same discipline as `confirmDialog.test.ts`.
 *
 * What this guards:
 *   - The banner renders the OM `<Alert>` primitive — so dark-mode rendering
 *     bug from the audit cannot regress (any `bg-amber-*` / `text-amber-*`
 *     class on the wrapper would fail this test).
 *   - The semantic variant is `warning` (not `destructive` / `success`).
 *   - The banner is gated on `status === 'historical'` only, mirroring the
 *     legacy behavior so this is rendering-only.
 *   - i18n is wired through the optional `t` prop — when supplied, the
 *     banner reads the i18n key; otherwise the English fallback is used.
 */
import * as React from 'react'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { PartnerStatusBanner } from '../frontend/[orgSlug]/portal/_components/PartnerStatusBanner'

function asReactElement(value: React.ReactNode): React.ReactElement {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('expected a React element, got: ' + JSON.stringify(value))
  }
  return value as React.ReactElement
}

describe('PRM portal — PartnerStatusBanner (shared, DS warning Alert)', () => {
  describe('renders the right OM primitive', () => {
    it('returns an <Alert variant="warning"> when status is historical', () => {
      const tree = asReactElement(PartnerStatusBanner({ status: 'historical' }))
      expect(tree.type).toBe(Alert)
      expect((tree.props as { variant?: string }).variant).toBe('warning')
    })

    it('does NOT carry hardcoded amber/yellow utility classes on the wrapper', () => {
      const tree = asReactElement(PartnerStatusBanner({ status: 'historical' }))
      const className = (tree.props as { className?: string }).className ?? ''
      // Regression guard: the legacy banner used `bg-amber-50 text-amber-900` —
      // those classes have no dark-mode pair and broke the partner portal under
      // `.dark`. The new wrapper must not re-introduce them.
      expect(className).not.toMatch(/bg-amber/)
      expect(className).not.toMatch(/text-amber/)
      expect(className).not.toMatch(/border-amber/)
    })

    it('forwards `className` (consumers can apply margin/spacing tweaks)', () => {
      const tree = asReactElement(PartnerStatusBanner({ status: 'historical', className: 'mb-4' }))
      const className = (tree.props as { className?: string }).className ?? ''
      expect(className).toContain('mb-4')
    })
  })

  describe('gating', () => {
    it('returns null for every non-historical status (no false positives)', () => {
      expect(PartnerStatusBanner({ status: 'active' })).toBeNull()
      expect(PartnerStatusBanner({ status: 'pending' })).toBeNull()
      expect(PartnerStatusBanner({ status: 'archived' })).toBeNull()
      expect(PartnerStatusBanner({ status: undefined })).toBeNull()
      expect(PartnerStatusBanner({ status: null })).toBeNull()
      expect(PartnerStatusBanner({})).toBeNull()
    })
  })

  describe('i18n wiring', () => {
    it('uses the supplied i18n key when `t` is provided', () => {
      const fakeT = (key: string, _fallback?: string) => `<<${key}>>`
      const tree = asReactElement(
        PartnerStatusBanner({
          status: 'historical',
          t: fakeT,
          messageKey: 'prm.portal.agency.banner.historical',
          message: 'fallback English copy',
        }),
      )
      const childTree = asReactElement(
        (tree.props as { children?: React.ReactNode }).children as React.ReactNode,
      )
      expect((childTree.props as { children?: React.ReactNode }).children).toBe(
        '<<prm.portal.agency.banner.historical>>',
      )
    })

    it('falls back to the English message when `t` is not provided', () => {
      const tree = asReactElement(
        PartnerStatusBanner({ status: 'historical', message: 'plain English fallback' }),
      )
      const childTree = asReactElement(
        (tree.props as { children?: React.ReactNode }).children as React.ReactNode,
      )
      expect((childTree.props as { children?: React.ReactNode }).children).toBe(
        'plain English fallback',
      )
    })
  })
})
