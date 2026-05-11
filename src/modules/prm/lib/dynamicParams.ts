/**
 * Resolve a dynamic `[id]` path segment for PRM backend detail pages.
 *
 * The OM framework routes module pages through the catch-all
 * `/backend/[...slug]`, so `useParams()` inside a module page returns
 * `{ slug: ['prm', '<section>', '<uuid>'] }` rather than `{ id: '<uuid>' }`.
 * When Next.js routes a page directly we'd instead get `params.id`. This
 * helper covers both shapes and returns `''` when no id is present, so
 * callers can keep their `if (!id) return` guards unchanged.
 */
export function resolveDynamicId(params: Record<string, unknown> | null | undefined): string {
  const slug = (params as { slug?: unknown } | null | undefined)?.slug
  if (Array.isArray(slug) && slug.length > 0) {
    const last = slug[slug.length - 1]
    if (typeof last === 'string') return last
  }
  const id = (params as { id?: unknown } | null | undefined)?.id
  if (Array.isArray(id) && id.length > 0 && typeof id[0] === 'string') return id[0]
  if (typeof id === 'string') return id
  return ''
}
