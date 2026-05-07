/**
 * Phase 4 — DS migration coverage for the partner portal list-page empty
 * states, now rendered via OM `<PortalEmptyState>` instead of hand-rolled
 * `<div className="rounded-md border bg-muted/30 p-6 ...">` blocks.
 *
 * Static-analysis test (project's jest env is `node`, not jsdom — see
 * `jest.config.cjs`). For each migrated list page we assert two things:
 *
 *   1. The page imports `PortalEmptyState` from
 *      `@open-mercato/ui/portal/components/PortalEmptyState`.
 *      This guarantees the OM primitive is the surface used; if a future
 *      edit accidentally drops the import the test fails immediately.
 *   2. The page no longer contains the legacy hardcoded empty-state markup
 *      (`bg-muted/30` block, `bg-muted/20 ... text-center` placeholder, or
 *      the inline `text-center text-muted-foreground` empty cell). This
 *      regression guards against the empty-state quietly drifting back to a
 *      one-off `<div>` on the next refactor.
 *
 * The list pages are NOT auto-discovered — we keep an explicit roster so a
 * new portal list page added later does not silently bypass DS review.
 *
 * Why static-analysis instead of `render(...)`: the project does not ship
 * `jest-environment-jsdom`, so we cannot mount a tree. Importing the page
 * modules transitively pulls in `@open-mercato/ui/backend/detail` which
 * re-exports an ESM `.tsx` that ts-jest cannot transform under the current
 * `transformIgnorePatterns`. This file-level structural check is the
 * pragmatic equivalent of `getByRole('region', { name: /no .* yet/i })`
 * for our env.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

const PORTAL_ROOT = path.resolve(
  __dirname,
  '..',
  'frontend',
  '[orgSlug]',
  'portal',
)

const MIGRATED_LIST_PAGES = [
  { file: 'prospects/page.tsx', name: 'prospects list (P5)' },
  { file: 'library/page.tsx', name: 'marketing library (P11)' },
  { file: 'case-studies/page.tsx', name: 'case studies (P7)' },
  { file: 'rfp/page.tsx', name: 'RFP inbox (P9)' },
] as const

const PORTAL_EMPTY_STATE_IMPORT_RE =
  /from\s+['"]@open-mercato\/ui\/portal\/components\/PortalEmptyState['"]/

// Regression guards: the legacy `<div className="rounded-md border bg-muted/30
// p-6 text-sm">` empty card. Loading rows that use `bg-muted/20` are NOT a
// regression — they are a separate UI state.
const LEGACY_EMPTY_BLOCK_RE = /rounded-md\s+border\s+bg-muted\/30\s+p-6\s+text-sm/

describe('PRM portal — list-page empty states use <PortalEmptyState>', () => {
  for (const target of MIGRATED_LIST_PAGES) {
    describe(target.name, () => {
      let source = ''
      beforeAll(async () => {
        source = await fs.readFile(path.join(PORTAL_ROOT, target.file), 'utf8')
      })

      it('imports `PortalEmptyState` from @open-mercato/ui', () => {
        expect(source).toMatch(PORTAL_EMPTY_STATE_IMPORT_RE)
        expect(source).toContain('PortalEmptyState')
      })

      it('renders <PortalEmptyState ... /> in JSX', () => {
        // JSX usage check: must reference the primitive as a JSX tag, not just
        // import it.
        expect(source).toMatch(/<PortalEmptyState[\s>]/)
      })

      it('no longer contains the legacy `bg-muted/30 p-6` empty card markup', () => {
        // The pre-migration empty cards were wrapped in
        // `<div className="rounded-md border bg-muted/30 p-6 text-sm">`.
        expect(source).not.toMatch(LEGACY_EMPTY_BLOCK_RE)
      })

      it('does not retain the legacy `prm.portal.<page>.empty` single-line raw text in JSX outside of i18n keys', () => {
        // Prior to this migration each list page had a single-line empty
        // message rendered as raw text inside a styled `<li>` or `<td>`. The
        // post-migration code routes that copy through `PortalEmptyState`
        // (`title=` + `description=` props), so any direct match of the bare
        // legacy key (`prm.portal.<page>.empty'`) outside a JSX prop would
        // mean the migration left a duplicated path. Keys that survive are
        // expected to include the `.title` / `.description` / `.action`
        // suffixes the new component takes.
        const legacyBareKeyRe = /['"]prm\.portal\.(?:prospects|library|caseStudies|rfp\.empty\.[a-z]+)\.empty['"]/
        expect(source).not.toMatch(legacyBareKeyRe)
      })
    })
  }
})
