import { COUNTRIES, resolveCountryLabel } from '../lib/countries'

describe('COUNTRIES list + resolveCountryLabel', () => {
  it('contains a sane set of ISO-3166-1 alpha-2 codes', () => {
    expect(COUNTRIES.length).toBeGreaterThan(240) // ~250 active codes
    expect(COUNTRIES.length).toBeLessThan(260)
  })

  it('every entry uses uppercase 2-letter alpha-2 codes', () => {
    const alpha2 = /^[A-Z]{2}$/
    for (const { value } of COUNTRIES) {
      expect(value).toMatch(alpha2)
    }
  })

  it('values are unique', () => {
    const seen = new Set<string>()
    for (const { value } of COUNTRIES) {
      expect(seen.has(value)).toBe(false)
      seen.add(value)
    }
  })

  it('labels are non-empty', () => {
    for (const { label } of COUNTRIES) {
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('resolveCountryLabel returns the English name for known codes', () => {
    expect(resolveCountryLabel('US')).toBe('United States')
    expect(resolveCountryLabel('GB')).toBe('United Kingdom')
    expect(resolveCountryLabel('PL')).toBe('Poland')
  })

  it('resolveCountryLabel is case-insensitive on input', () => {
    expect(resolveCountryLabel('us')).toBe('United States')
    expect(resolveCountryLabel('  pl  ')).toBe('Poland')
  })

  it('resolveCountryLabel falls back to the code for unknown values', () => {
    expect(resolveCountryLabel('ZZ')).toBe('ZZ')
    expect(resolveCountryLabel('XX')).toBe('XX')
  })

  it('resolveCountryLabel returns empty string for empty input', () => {
    expect(resolveCountryLabel('')).toBe('')
  })
})
