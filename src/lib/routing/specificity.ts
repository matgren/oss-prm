/**
 * Route specificity sort — workaround for the OM framework's first-match-wins
 * `findRouteManifestMatch` / `findApiRouteManifestMatch`.
 *
 * The auto-generated route manifests in `.mercato/generated/*.generated.ts`
 * emit routes alphabetically by file path. ASCII-wise `[` (0x5B) sorts before
 * `n` (0x6E), so `/[orgSlug]/portal/case-studies/[id]` precedes the literal
 * `/[orgSlug]/portal/case-studies/new` in the manifest. Because the matcher
 * iterates first-to-last and returns the first match, `[id]` captures `/new`
 * with `id='new'` — the literal route never gets a chance.
 *
 * Standard router precedence (Next.js, React Router, Express) is: literal >
 * dynamic > catch-all, compared per segment. Sort the manifest by that key
 * before passing to the matcher.
 *
 * Upstream issue: framework should ship this in `findRouteManifestMatch`.
 */

type WithPattern = { pattern?: string; path?: string }

function specificityKey(pattern: string): Array<0 | 1 | 2> {
  return pattern.split('/').map((seg) => {
    if (seg.startsWith('[...')) return 2 // catch-all
    if (seg.startsWith('[')) return 1 // dynamic-named
    return 0 // literal
  })
}

function compareSpecificity(a: string, b: string): number {
  const ka = specificityKey(a)
  const kb = specificityKey(b)
  const len = Math.max(ka.length, kb.length)
  for (let i = 0; i < len; i++) {
    const av = ka[i] ?? -1
    const bv = kb[i] ?? -1
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Returns a new array with routes ordered by specificity ascending — most
 * specific first. Pass to `findRouteManifestMatch`/`findApiRouteManifestMatch`
 * so literal segments win over `[id]` dynamics.
 */
export function sortRoutesBySpecificity<T extends WithPattern>(routes: readonly T[]): T[] {
  return [...routes].sort((a, b) =>
    compareSpecificity(a.pattern ?? a.path ?? '/', b.pattern ?? b.path ?? '/'),
  )
}
