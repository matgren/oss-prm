/**
 * Tag suggestion union helpers (SPEC-2026-05-11).
 *
 * Consumed by:
 *  - GET /api/prm/portal/agency/[id]/tag-suggestions (per-agency portal)
 *  - GET /api/prm/agency/[id]/tag-suggestions       (per-agency backend, B1)
 *  - GET /api/prm/tag-suggestions                    (tenant-wide backend, B-RFP)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TagSuggestion = { value: string; label: string }

/**
 * Union an arbitrary number of slug arrays, then:
 *  - drop UUID-shaped values (legacy closed-vocab leftovers per SPEC-2026-05-11 M4)
 *  - drop empty / whitespace-only entries
 *  - dedupe case-insensitively, preserving first-seen casing
 *  - sort alphabetically (case-insensitive, locale-aware)
 *  - emit as TagSuggestion[] (value === label for open-vocab slugs).
 *
 * Pure function — no I/O. Each route loads its own DB rows and passes the
 * relevant column arrays in.
 */
export function unionTagSlugs(
  sources: Array<readonly string[] | null | undefined>,
): TagSuggestion[] {
  // key = trimmed + lowercased, value = canonical casing (first seen).
  const seen = new Map<string, string>()
  for (const source of sources) {
    if (!source) continue
    for (const raw of source) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (!trimmed) continue
      if (UUID_RE.test(trimmed)) continue
      const key = trimmed.toLowerCase()
      if (!seen.has(key)) seen.set(key, trimmed)
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((value) => ({ value, label: value }))
}
