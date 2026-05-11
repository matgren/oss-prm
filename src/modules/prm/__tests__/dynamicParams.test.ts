import { resolveDynamicId } from '../lib/dynamicParams'

describe('resolveDynamicId', () => {
  it('extracts the last segment from a catch-all slug array', () => {
    expect(resolveDynamicId({ slug: ['prm', 'agency-members', 'abc-123'] })).toBe('abc-123')
    expect(resolveDynamicId({ slug: ['prm', 'rfp', 'rfp-uuid'] })).toBe('rfp-uuid')
  })

  it('falls back to params.id (string form) when no slug array', () => {
    expect(resolveDynamicId({ id: 'plain-id' })).toBe('plain-id')
  })

  it('falls back to params.id (array form)', () => {
    expect(resolveDynamicId({ id: ['array-id'] })).toBe('array-id')
  })

  it('prefers slug over id when both are present', () => {
    expect(resolveDynamicId({ slug: ['prm', 'x', 'from-slug'], id: 'from-id' })).toBe('from-slug')
  })

  it('returns empty string when no id can be resolved', () => {
    expect(resolveDynamicId({})).toBe('')
    expect(resolveDynamicId(null)).toBe('')
    expect(resolveDynamicId(undefined)).toBe('')
    expect(resolveDynamicId({ slug: [] })).toBe('')
    expect(resolveDynamicId({ slug: [123] } as unknown as Record<string, unknown>)).toBe('')
    expect(resolveDynamicId({ id: [] } as unknown as Record<string, unknown>)).toBe('')
  })

  it('the empty-string return is falsy — callers can keep `if (!id) return` guards', () => {
    const id = resolveDynamicId({})
    expect(!id).toBe(true)
  })
})
