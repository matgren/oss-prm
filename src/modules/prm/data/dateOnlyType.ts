import { DateType, type Platform } from '@mikro-orm/core'

/**
 * Mikro-ORM date-only column type that yields a real `Date` on hydration.
 *
 * Mikro-ORM v6's built-in `DateType` delegates `convertToJSValue` to the
 * platform, and the base Postgres platform returns the value unchanged — so
 * `@Property({ type: 'date' })` columns come back from the DB as
 * `YYYY-MM-DD` strings, not `Date` objects. Anything that calls
 * `.getUTCFullYear()` etc. on the property then crashes at runtime even
 * though the TS annotation reads `Date | null`. Identity-map caching masks
 * this in unit tests (entities seeded in-memory keep their Date instances),
 * so the trap only surfaces after a full DB round-trip — historically after
 * the user saves a record and the next read deserialises it.
 *
 * Use this type for any DATE-only column where the property type is `Date`:
 *
 *   @Property({ name: 'partnership_start_date', type: DateOnlyType, nullable: true })
 *   partnershipStartDate?: Date | null
 *
 * The SQL column type is still `date` (inherited from `DateType.getColumnType`),
 * so swapping `'date'` → `DateOnlyType` is a no-op at the schema level.
 */
export class DateOnlyType extends DateType {
  // Override signature uses `any` to widen Mikro-ORM's DateType<string> return
  // type — the actual runtime value we want callers to receive is `Date | null`,
  // which is what the entity TS annotation already claims. The cast inside the
  // body is the truth of the contract.
  override convertToJSValue(value: any, _platform: Platform): any {
    if (value == null) return null
    if (value instanceof Date) return value
    return new Date(`${String(value)}T00:00:00Z`)
  }
}
