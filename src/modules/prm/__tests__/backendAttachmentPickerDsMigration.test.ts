/**
 * DS migration regression guard for the marketing-materials AttachmentPicker.
 *
 * Mirrors the static-analysis discipline of `backendLicenseDealsDsMigration.test.ts`
 * and `portalOnboardingChips.test.tsx` — the project's jest env is `node` (not
 * jsdom — see `jest.config.cjs`) and the component transitively pulls in
 * client-only OM modules that ts-jest cannot transform under the current
 * `transformIgnorePatterns`. Same pragmatic approach used by every other PRM
 * DS migration test.
 *
 * Sites guarded by this file:
 *   1. Upload flow uses `apiCallOrThrow` from `@open-mercato/ui/backend/utils/apiCall`
 *      instead of raw `fetch()`.
 *   2. Error display uses `<Alert variant="destructive">` instead of
 *      `<div className="text-xs text-red-600">`.
 *   3. Primary-attachment badge uses `<StatusBadge variant="warning">` instead
 *      of hand-rolled `bg-amber-500/10 text-amber-700` span with arbitrary
 *      `text-[10px]` size.
 *   4. The decorative gold-star toggle keeps its `text-amber-500` className
 *      (gold-star convention is a brand/decorative semantic, not a status
 *      semantic) and is marked with a `DS-SKIP: decorative` comment so future
 *      DS Guardian scans understand the intent.
 *
 * i18n regression guard: the translation keys
 * `prm.backend.marketingMaterials.attachments.uploadFailed` and `.primary` MUST
 * still appear in the source — the migration is rendering-only, not a copy
 * change.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

const COMPONENT_PATH = path.resolve(
  __dirname,
  '..',
  'backend',
  'prm',
  'marketing-materials',
  'components',
  'AttachmentPicker.tsx',
)

describe('PRM AttachmentPicker — DS migration to apiCallOrThrow / Alert / StatusBadge', () => {
  let source = ''
  beforeAll(async () => {
    source = await fs.readFile(COMPONENT_PATH, 'utf8')
  })

  describe('imports', () => {
    it('imports apiCallOrThrow from @open-mercato/ui/backend/utils/apiCall', () => {
      expect(source).toMatch(
        /import\s*\{[^}]*\bapiCallOrThrow\b[^}]*\}\s*from\s*['"]@open-mercato\/ui\/backend\/utils\/apiCall['"]/,
      )
    })

    it('imports Alert from @open-mercato/ui/primitives/alert', () => {
      expect(source).toMatch(
        /import\s*\{[^}]*\bAlert\b[^}]*\}\s*from\s*['"]@open-mercato\/ui\/primitives\/alert['"]/,
      )
    })

    it('imports StatusBadge from @open-mercato/ui/primitives/status-badge', () => {
      expect(source).toMatch(
        /import\s*\{[^}]*\bStatusBadge\b[^}]*\}\s*from\s*['"]@open-mercato\/ui\/primitives\/status-badge['"]/,
      )
    })
  })

  describe('site 1 — upload flow uses apiCallOrThrow (not raw fetch)', () => {
    it('calls apiCallOrThrow against the upload endpoint', () => {
      expect(source).toMatch(
        /apiCallOrThrow[^(]*\(\s*['"]\/api\/prm\/marketing-material\/upload['"]/,
      )
    })

    it('does not retain a raw fetch() call', () => {
      // Regression guard: the legacy implementation called `fetch(...)` directly
      // against the same endpoint. AGENTS.md mandates apiCall / apiCallOrThrow
      // wrappers everywhere — never raw fetch.
      expect(source).not.toMatch(/\bfetch\(\s*['"]\/api\/prm\/marketing-material\/upload['"]/)
    })
  })

  describe('site 2 — error surface uses <Alert variant="destructive">', () => {
    it('renders <Alert variant="destructive"> for the upload error', () => {
      expect(source).toMatch(/<Alert\s+variant=["']destructive["']/)
    })

    it('does not retain the legacy text-red-600 error div', () => {
      // Regression guard: the legacy error surface was
      // `<div className="text-xs text-red-600">{error}</div>` — semantic
      // tokens are required so dark mode renders correctly.
      expect(source).not.toMatch(/text-red-/)
    })
  })

  describe('site 3 — Primary badge uses <StatusBadge variant="warning">', () => {
    it('renders <StatusBadge variant="warning"> for the primary indicator', () => {
      expect(source).toMatch(/<StatusBadge\s+variant=["']warning["']/)
    })

    it('does not retain the hand-rolled amber Primary badge utilities', () => {
      // Regression guard: the legacy badge used
      // `bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase
      // tracking-wide text-amber-700` — both the amber utilities AND the
      // arbitrary `text-[10px]` size are forbidden by DS rules.
      expect(source).not.toMatch(/bg-amber-500\/10/)
      expect(source).not.toMatch(/bg-amber-7/)
      expect(source).not.toMatch(/text-amber-7/)
      expect(source).not.toMatch(/text-\[10px\]/)
    })
  })

  describe('site 4 — decorative gold-star icon keeps its color, is marked DS-SKIP', () => {
    it('keeps a single text-amber-500 site (the star toggle)', () => {
      const matches = source.match(/text-amber-500/g) ?? []
      // The conditional appears twice in the same className expression
      // (`isPrimary ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'`)
      // — both refer to the same decorative star element.
      expect(matches.length).toBeGreaterThanOrEqual(1)
      expect(matches.length).toBeLessThanOrEqual(2)
    })

    it('marks the star className with a DS-SKIP comment', () => {
      // The DS-SKIP comment must appear immediately above the star className
      // expression so DS Guardian scans treat the amber as decorative.
      expect(source).toMatch(
        /DS-SKIP:\s+decorative\s+gold-star\s+icon[\s\S]{0,200}text-amber-500/,
      )
    })
  })

  describe('i18n regression guard — translation keys are preserved', () => {
    it('still references the uploadFailed translation key', () => {
      expect(source).toContain('prm.backend.marketingMaterials.attachments.uploadFailed')
    })

    it('still references the primary translation key', () => {
      expect(source).toContain('prm.backend.marketingMaterials.attachments.primary')
    })
  })
})
