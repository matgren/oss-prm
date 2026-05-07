/**
 * DS migration coverage for the B5 license-deal detail page.
 *
 * This file mirrors the discipline of `portalEmptyStateMigration.test.ts` and
 * `portalPartnerStatusBanner.test.tsx` — static-analysis assertions that
 * guard against regressing from the OM `<Alert>` / `<StatusBadge>` primitives
 * back to the hand-rolled tailwind utilities listed in
 * `.ai/specs/POST-MVP-FOLLOW-UPS.md` "Design system follow-ups".
 *
 * Why static-analysis instead of `render(...)`: the project's jest env is
 * `node`, not `jsdom` (see `jest.config.cjs`), and the page transitively
 * pulls in client-only OM modules that ts-jest cannot transform under the
 * current `transformIgnorePatterns`. Same pragmatic structural check used by
 * the portal DS migration in PR #21.
 *
 * Sites guarded by this file (matches the three backend migrations in this PR):
 *   1. Empty Path-A candidates banner — was
 *      `border-amber-300 bg-amber-50 text-amber-900`, now
 *      `<Alert variant="warning">`.
 *   2. LOST candidate badge — was
 *      `bg-red-100 text-red-700`, now `<StatusBadge variant="error">`.
 *   3. Attribution-reasoning quote box — was
 *      `border-l-2 border-primary/60`, now `<Alert variant="info">`.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

const PAGE_PATH = path.resolve(
  __dirname,
  '..',
  'backend',
  'prm',
  'license-deals',
  '[id]',
  'page.tsx',
)

describe('PRM B5 license-deal detail — DS migration to <Alert>/<StatusBadge>', () => {
  let source = ''
  beforeAll(async () => {
    source = await fs.readFile(PAGE_PATH, 'utf8')
  })

  describe('imports', () => {
    it('imports Alert + AlertTitle + AlertDescription from @open-mercato/ui', () => {
      expect(source).toMatch(
        /from\s+['"]@open-mercato\/ui\/primitives\/alert['"]/,
      )
      expect(source).toContain('Alert')
      expect(source).toContain('AlertTitle')
      expect(source).toContain('AlertDescription')
    })

    it('imports StatusBadge from @open-mercato/ui', () => {
      expect(source).toMatch(
        /from\s+['"]@open-mercato\/ui\/primitives\/status-badge['"]/,
      )
      expect(source).toContain('StatusBadge')
    })
  })

  describe('site 1 — empty Path-A candidates banner uses <Alert variant="warning">', () => {
    it('uses <Alert variant="warning">', () => {
      expect(source).toMatch(/<Alert\s+variant=["']warning["']/)
    })

    it('does not retain hand-rolled amber utilities', () => {
      // Regression guard: the legacy banner used
      // `rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900`
      // with no dark-mode pair. Any reintroduction fails this test.
      expect(source).not.toMatch(/border-amber-/)
      expect(source).not.toMatch(/bg-amber-/)
      expect(source).not.toMatch(/text-amber-/)
    })
  })

  describe('site 2 — LOST candidate badge uses <StatusBadge variant="error">', () => {
    it('uses <StatusBadge variant="error">', () => {
      expect(source).toMatch(/<StatusBadge\s+variant=["']error["']/)
    })

    it('does not retain hand-rolled red utilities on the lost-badge surface', () => {
      // Regression guard: the legacy badge used
      // `rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700`.
      expect(source).not.toMatch(/bg-red-/)
      expect(source).not.toMatch(/text-red-/)
    })
  })

  describe('site 3 — attribution-reasoning callout uses <Alert variant="info">', () => {
    it('uses <Alert variant="info">', () => {
      expect(source).toMatch(/<Alert\s+variant=["']info["']/)
    })

    it('does not retain the legacy `border-l-2 border-primary/60` quote box', () => {
      // Regression guard for the raw primary-tint quote callout.
      expect(source).not.toMatch(/border-l-2\s+border-primary\/60/)
    })
  })
})
