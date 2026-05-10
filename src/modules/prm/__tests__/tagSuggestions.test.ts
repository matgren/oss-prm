import { unionTagSlugs } from '../lib/tagSuggestions'

describe('unionTagSlugs (SPEC-2026-05-11)', () => {
  const LEGACY_UUID = '7a4b8c9d-1234-5678-9abc-def012345678'

  it('returns an empty array when all sources are empty / null / undefined', () => {
    expect(unionTagSlugs([])).toEqual([])
    expect(unionTagSlugs([null, undefined, []])).toEqual([])
  })

  it('unions slugs from multiple sources, preserving the first-seen casing', () => {
    const result = unionTagSlugs([
      ['React'],
      ['react'], // case-insensitive match to 'React' — collapsed, 'React' wins.
      ['LangGraph', 'PyTorch'],
    ])
    expect(result.map((r) => r.value)).toEqual(['LangGraph', 'PyTorch', 'React'])
    expect(result.every((r) => r.value === r.label)).toBe(true)
  })

  it('filters out legacy UUID-shaped values (M4)', () => {
    const result = unionTagSlugs([[LEGACY_UUID, 'GoLang']])
    expect(result.map((r) => r.value)).toEqual(['GoLang'])
  })

  it('filters out UUID-shaped values regardless of casing (case-insensitive UUID match)', () => {
    const upper = LEGACY_UUID.toUpperCase()
    const result = unionTagSlugs([[upper, 'Rust']])
    expect(result.map((r) => r.value)).toEqual(['Rust'])
  })

  it('trims whitespace and drops empty / whitespace-only entries', () => {
    const result = unionTagSlugs([['  React  ', '', '   ', 'PyTorch']])
    expect(result.map((r) => r.value)).toEqual(['PyTorch', 'React'])
  })

  it('sorts alphabetically with case-insensitive locale-aware comparison', () => {
    const result = unionTagSlugs([['zoom', 'Apple', 'banana', 'Banana']])
    expect(result.map((r) => r.value)).toEqual(['Apple', 'banana', 'zoom'])
  })

  it('first-write-wins on casing across multiple sources (AC-INV-8)', () => {
    // Source #1 holds 'React', source #2 holds 'react'.
    // Helper sees 'React' first, collapses 'react' into the same key.
    const result = unionTagSlugs([['React'], ['react']])
    expect(result.map((r) => r.value)).toEqual(['React'])
  })

  it('skips non-string entries defensively (robust to dirty data)', () => {
    const dirty = [null, 1, true, 'LangGraph', undefined] as unknown as string[]
    const result = unionTagSlugs([dirty])
    expect(result.map((r) => r.value)).toEqual(['LangGraph'])
  })
})
