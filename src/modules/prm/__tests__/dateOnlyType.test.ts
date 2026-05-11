import type { Platform } from '@mikro-orm/core'
import { DateOnlyType } from '../data/dateOnlyType'

describe('DateOnlyType.convertToJSValue', () => {
  const subject = new DateOnlyType()
  const platform = {} as Platform // unused by the override

  it('returns null when the DB value is null', () => {
    expect(subject.convertToJSValue(null, platform)).toBeNull()
  })

  it('returns null when the DB value is undefined', () => {
    expect(subject.convertToJSValue(undefined as unknown as null, platform)).toBeNull()
  })

  it('coerces a YYYY-MM-DD string into a UTC-midnight Date', () => {
    // Repro of the bug: pg-types returns DATE columns as strings, and the
    // base DateType's convertToJSValue passed that through unchanged so the
    // entity property was `string` at runtime even though TS said `Date`.
    const result = subject.convertToJSValue('2026-04-15', platform)
    expect(result).toBeInstanceOf(Date)
    expect(result?.toISOString()).toBe('2026-04-15T00:00:00.000Z')
  })

  it('passes Date inputs through untouched (in-memory entity path)', () => {
    const input = new Date('2026-04-15T00:00:00.000Z')
    const result = subject.convertToJSValue(input, platform)
    expect(result).toBe(input)
  })
})
