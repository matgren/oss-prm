# SPEC-2026-05-10 — Partnership Year Anchor

**Date**: 2026-05-10
**Status**: Ready
**Reviewed**: PM ×2 (om-product-manager subagent), CTO ×2 (om-cto subagent, fresh context for the second pass per memory rule on pre-flip review)
**Type**: Cross-spec refinement (touches Spec #1 Agency Foundation, Spec #2 WIP Scoreboard, Spec #3 Attribution Loop)
**Estimated commits**: 3 — (a) entity + migration; (b) helper + route + validator updates; (c) event declaration + invalidator subscriber + UI banner/confirm.

> **Refines**:
> - `SPEC-2026-04-23-agency-foundation` §5 (Agency entity gains `partnership_start_date`)
> - `SPEC-2026-04-23-wip-scoreboard` §3.3 (dashboard year window)
> - `SPEC-2026-04-23-attribution-loop` (MIN aggregation window)
>
> **App-spec edits** (`app-spec/app-spec.md`) — find via `grep`, not by line number (line numbers shift):
> - Glossary entry for **MIN** (`grep -nE "^\| \*\*MIN\*\* \|"`): replace "Calendar year (Jan 1 – Dec 31 UTC)" with "Partnership year (12 months from `Agency.partnership_start_date`)".
> - KPI summary line (`grep -n "MIN = calendar year"`): drop "calendar year".
> - US-5.6 (`grep -n "MIN count increments for that agency's calendar year"`): "calendar year" → "partnership year".
> - Acceptance line (`grep -n "MIN calendar year boundary is UTC"`): rephrase to partnership-year boundary.
> - Changelog summary (`grep -nE "calendar year.*MIN|MIN.*calendar year"` near the bottom): note the shift.

---

## 1. TLDR

Partnership KPIs (MIN, plus the "This year" toggles on WIP and WIC) currently
roll over on January 1 calendar year. That is wrong: an agency that signs a
contract on August 15 should get a full 12-month MIN window from that date, not
4 months of credit before the calendar year resets.

We add `partnership_start_date: Date | null` to `Agency`, expose a single helper
`getPartnershipYearWindow(agency, asOf)`, and replace the two hard-coded
`Date.UTC(year, 0, 1)` blocks in the dashboard and MIN routes. When the field
is null, the dashboard falls back to calendar year and shows a banner asking
OM staff to set the date.

## 2. Problem Statement

`Agency` has `contract_signed: boolean` only — no date. The MIN route
(`src/modules/prm/api/portal/min/route.ts:74-75`) and the portal dashboard
route (`src/modules/prm/api/portal/dashboard/route.ts:96-97`) both compute the
year window as:

```ts
const yearStart = new Date(Date.UTC(year, 0, 1))
const yearEnd = new Date(Date.UTC(year + 1, 0, 1))
```

Consequence: an agency onboarded mid-year sees their MIN counter reset on
January 1, which contradicts the business meaning of MIN ("X licenses in the
12 months following partnership start"). Tier evaluation that depends on
MIN/year (per app-spec §1.4) inherits the same bug.

The app-spec glossary line 71 currently reinforces the bug:
> **MIN** ... Calendar year (Jan 1 – Dec 31 UTC)

This needs to flip to partnership year.

## 2.1 User Stories

### US-PY.1 — OM staff sets a partnership start date
**As** OM Partnership Manager (`partnership_manager` role)
**I want** to set / edit `partnership_start_date` on each agency I manage
**So that** the agency's MIN counter and "This year" KPIs aggregate over their actual partnership window, not the calendar year.

- **Happy path:** PM opens `/backend/prm/agency/{id}`, picks a date in the date input, saves. The agency's portal dashboard banner disappears on the next reload; MIN tile shows "Year 1 · since {date}".
- **Failure: future-dated.** PM enters `2099-01-01`. PATCH route rejects with 400 + inline error: "Partnership start date cannot be more than 30 days in the future."
- **Failure: ancient.** PM enters `1990-01-01`. PATCH route rejects with 400 + inline error: "Partnership start date must be on or after 2020-01-01."
- **Failure: null already, agency has KPIs.** PM clears the field. Dashboard banner returns; KPIs fall back to calendar year. Allowed — sometimes a date is set in error and needs to be cleared before being re-set.

### US-PY.2 — Agency admin sees their partnership year
**As** Agency Admin (`partner_admin`) or Business Developer (`partner_member`)
**I want** the dashboard to show me which partnership year I'm in and when it rolls over
**So that** I can plan for tier review and understand why MIN resets.

- **Happy path:** Dashboard shows "Partnership Year 2 · ends Aug 14, 2027" near the MIN tile. KPIs labeled "this year" use the partnership window.
- **Edge: ≤30 days before rollover.** Dashboard shows a hint: "New partnership year starts {date} — your MIN counter will reset."
- **Edge: rollover day.** MIN tile shows the new year's running total starting at 0 AND a small "Year N-1 closed with X licenses" caption for the first 30 days of the new year so the reset is legible, not surprising.
- **Failure: PM hasn't set the date.** Dashboard shows the OM-staff-targeted banner ("OM staff: set this agency's partnership start date…"). Agency users see nothing actionable but understand the data is incomplete; KPIs fall back to calendar year so the dashboard isn't blank.

## 3. Proposed Solution

### 3.1 Entity change (Spec #1 amendment)

Add to `src/modules/prm/data/entities.ts` `Agency` aggregate:

```ts
@Property({ name: 'partnership_start_date', type: Date, nullable: true })
partnershipStartDate: Date | null = null
```

Keep the existing `contract_signed: boolean` for one cycle — it is referenced
by Spec #1's onboarding cascade subscriber (renames are out of scope for this
amendment). A future cleanup spec can derive `contract_signed = partnership_start_date != null`.

**Rationale for the simplest model** (per user decision 2026-05-10):
- Single field. No `contract_history` table. Partnership is treated as one
  continuous undefined-period engagement.
- If OM staff need to correct the anchor (e.g., wrong date entered, contract
  renegotiated with effective re-anchor), they edit the field. All future
  partnership-year computations move accordingly.
- No renewal event, no audit trail beyond what `updated_at` already captures.
  If audit becomes a requirement, promote to `partnership_anchors` table later.

### 3.2 Helper

New file `src/modules/prm/lib/partnershipYear.ts`:

```ts
export type PartnershipYearWindow = {
  start: Date          // inclusive
  end: Date            // exclusive
  yearNumber: number   // 1 = first partnership year
}

/**
 * Returns the partnership-year window containing `asOf`.
 * Returns null if `agency.partnershipStartDate` is null — caller decides
 * whether to fall back to calendar year or block the read.
 */
export function getPartnershipYearWindow(
  agency: { partnershipStartDate: Date | null },
  asOf: Date,
): PartnershipYearWindow | null
```

Single source of truth. **Future tier-evaluation work** (no spec exists yet —
deferred per `POST-MVP-FOLLOW-UPS.md`; the spec slot Spec #5 is currently
occupied by `rfp-broadcast-response`) MUST use this helper for MIN
aggregation. Flagged as a forward contract: when the tier-eval spec is
written, it imports `getPartnershipYearWindow` from this module — no
re-implementation.

Unit tests live at `src/modules/prm/__tests__/partnershipYear.test.ts` —
flat path matching the actual sibling `src/modules/prm/__tests__/tierRequirements.test.ts`.
The `__tests__/lib/` subdirectory does NOT exist; do not create it.

### 3.3 Route updates (Spec #2 amendment)

Both `dashboard/route.ts` and `min/route.ts`:

1. Load the caller's `Agency` (already loaded in `dashboard/route.ts`; add to
   `min/route.ts`).
2. Replace the calendar-year block with `getPartnershipYearWindow(agency, now)`.
3. If `null`, fall back to calendar year AND set a flag in the response:
   `period.partnershipYear: null` + `period.warnings: ['partnership_start_date_missing']`.
4. Otherwise, return `period.partnershipYear: { start, end, number }` so the
   dashboard can show "Partnership year 2 · ends Aug 14, 2027".

The "This year" toggles on WIP and WIC widgets read the same window — they
already share the `/api/prm/portal/dashboard` aggregate, so this is a single
change site.

### 3.4 UI changes (out-of-band, scaffolded separately)

Already iterated in `tmp/dashboard-widget-scaffold.html`:
- MIN tile shows "Attributed (Year 2 · since Aug 15)" when known.
- Tier widget MIN rail caption: "/ this partnership year".
- Banner at top of dashboard when `partnership_start_date` is null:
  "OM staff: set this agency's partnership start date to enable accurate yearly KPIs."

OM staff edit the field on the Agency edit page (Spec #1's existing form gains
one date input — additive, no migration to forms).

#### Rollover legibility (US-PY.2 edges)

The day MIN resets to 0 must be legible, not surprising:

- **≤30 days before rollover:** dashboard shows a hint near the MIN tile —
  "New partnership year starts {date} — your MIN counter will reset."
  Computed client-side from `period.partnershipYear.end`.
- **First 30 days of the new year:** MIN tile shows the running total (starts
  at 0) PLUS a small caption "Year {N-1} closed with {X} licenses" so the
  reset is contextualised. Requires the dashboard route to also return the
  prior partnership year's final count: `period.partnershipYear.priorYearMinCount: number | null`.
- **>30 days into a new year:** caption falls off; widget reverts to the
  baseline "Attributed (Year N · since {date})" header.

Implementation note: `priorYearMinCount` is a single SQL count query against
`prm_partner_license_deals` filtered to the previous partnership-year window —
cheap. Cache with the rest of the dashboard aggregate.

## 4. Data Models

### Agency — added column

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `partnership_start_date` | `date` | yes | `null` | The date the agency's partnership year is anchored to. Edited by OM staff. |

**Migration**:

```sql
ALTER TABLE prm_agencies ADD COLUMN partnership_start_date DATE NULL;
```

No backfill (per user decision 2026-05-10): existing agencies are left null.
Dashboard banner prompts OM staff to set them via the Agency edit page.

## 5. API Contracts

### `/api/prm/portal/dashboard` GET — response addition

```ts
{
  ok: true,
  dashboard: {
    // ... existing fields ...
    period: {
      year: number,                    // calendar year (kept for compatibility)
      month: number,
      partnershipYear: {               // NEW
        start: string,                 // ISO8601 UTC
        end: string,                   // ISO8601 UTC, exclusive
        number: number,                // 1, 2, 3, ...
      } | null,                        // null when partnership_start_date missing
      warnings?: ['partnership_start_date_missing'],
    },
    // wip / wic / min aggregates now use the partnership-year window when
    // available, otherwise calendar year.
  }
}
```

### `/api/prm/portal/min` GET — query-param semantic flip

**Shipped reality (verified 2026-05-10):** `portalMinQuerySchema` in
`src/modules/prm/data/validators.ts:440` accepts `?year=<int>` (calendar).
Response shape is camelCase: `{ ok, year, ownCount, ownAnnualValueUsd, ownDeals }`
— there is no `tier_target` field (that was in Spec #3's draft text but never
shipped). All field names below preserve camelCase OM convention.

This spec **adds a canonical query param** to make the semantic shift explicit:

- **New canonical param:** `?partnershipYear=<int>` — interpreted as the
  partnership-year number (1 = first year since `partnership_start_date`).
  Note: existing PRM portal query params are lowercase (`year`); the new
  param is camelCase. The intentional break is to flag the new semantics —
  callers must opt into them.
- **Backward compatibility:** `?year=<int>` still accepted. When
  `partnership_start_date` is set, `?year=N` is reinterpreted as "the
  partnership year containing the calendar-year-N anchor" with
  `warnings: ['year_param_deprecated']` in the response. When
  `partnership_start_date` is null, `?year=N` keeps the old calendar-year
  semantics with no warning. Frontend must migrate to `?partnershipYear`
  within 1 release.
- **Null-anchor + canonical param:** `?partnershipYear=N` against an agency
  whose `partnership_start_date` is null returns **HTTP 400** with body
  `{ error: { code: 'anchor_missing', message: 'Agency partnership_start_date is not set; use ?year=<calendar-year> as a fallback or ask OM staff to set the anchor.' } }`.
- **Response shape (additive):** keep all existing fields (`ok`, `year`,
  `ownCount`, `ownAnnualValueUsd`, `ownDeals`). Add:
  - `partnershipYear: number | null` — populated when anchor is set, null otherwise
  - `calendarYear: number` — always populated, equals existing `year` field
  - `period: { partnershipYear: { start, end, number, priorYearMinCount } | null, warnings?: string[] }` — same envelope as the dashboard route
  Existing `year: number` field is kept indefinitely (matches Spec #3
  documentation). Removing it is a separate cleanup spec, not this one.
- **Validator update:** `portalMinQuerySchema` gains an optional
  `partnershipYear: z.coerce.number().int().positive().optional()` field
  alongside the existing `year`. Mutual-exclusivity between the two params
  is NOT enforced — passing both is fine; `partnershipYear` wins.
- **MIN counting predicate (UNCHANGED):** the existing
  `licenseDealService.listForMinWidget` predicate
  `signedAt OR (signedAt null AND attributedAt within window)` is preserved
  byte-for-byte. **Only the window bounds change.** The same predicate is
  used for `priorYearMinCount` so the prior-year caption number always
  equals what last year's tile showed.

Same `period.partnershipYear` envelope as the dashboard route is added to the
top-level response.

### `/api/prm/agency/{id}` PATCH — body addition

**Shipped reality (verified 2026-05-10):**
- Route: `src/modules/prm/api/agency/[id]/route.ts` (singular, NOT `agencies`)
- Backend gate: `requireFeatures(['prm.agency.update_all'])` (declared in
  `src/modules/prm/acl.ts:10`). The string `prm.agency.manage` does NOT exist.
- Validator: `updateAgencyBackendSchema` in `src/modules/prm/data/validators.ts:43`
- Admin-only-field guard: `ADMIN_ONLY_AGENCY_FIELDS` in
  `src/modules/prm/data/validators.ts:100` — the portal API interceptor uses
  this list to reject portal-side writes. Both camelCase and snake_case
  mirrors are listed.

**Validator updates (mandatory):**

1. `updateAgencyBackendSchema` gains:

```ts
partnershipStartDate: z
  .string()
  .date() // YYYY-MM-DD
  .refine((s) => new Date(s) >= new Date('2020-01-01'),
          { message: 'Partnership start date must be on or after 2020-01-01.' })
  .refine((s) => {
    const d = new Date(s)
    const max = new Date()
    max.setUTCDate(max.getUTCDate() + 30)
    return d <= max
  }, { message: 'Partnership start date cannot be more than 30 days in the future.' })
  .nullable()
  .optional()
```

2. `ADMIN_ONLY_AGENCY_FIELDS` gains both `'partnershipStartDate'` and
   `'partnership_start_date'` so the portal interceptor rejects portal-side
   writes (matching the existing `tier` / `status` / `contractSigned` pattern).

3. `createAgencyBackendSchema` is **NOT** updated. The field is editable
   only after creation, which keeps Spec #1's create flow untouched and
   means new agencies start with `partnership_start_date = null` (banner
   prompts PM to set it).

Hard-reject server-side (400) with inline field error. UI form surfaces the
Zod message under the input. Clearing the field (setting to `null`) is allowed
— mirrors the failure path in US-PY.1.

**Event emission — location and payload convention:**

- **Where:** the event fires from `agencyService.updateAgency`
  (`src/modules/prm/lib/agencyService.ts:198`+), NOT from the route handler.
  This matches the existing `prm.agency.tier_changed` /
  `status_changed` / `onboarding_state_changed` emission sites — the service
  takes a `before` snapshot of the entity, runs the patch, then `safeEmit`s
  for each watched field that changed. The implementer adds a new branch
  alongside the existing field-diff blocks (around lines 261–305).
- **Service-level set:** `agencyService.updateAgency` must explicitly assign
  `agency.partnershipStartDate = patch.partnershipStartDate` when the patch
  contains the field. The current method maps fields explicitly; the new
  field needs adding to that map or it silently no-ops.
- **Payload (matching `prm.agency.*` convention — `tenantId`, not
  `organizationId`):**

```ts
{
  id: 'prm.agency.partnership_anchor_changed',
  label: 'Agency partnership anchor changed',
  entity: 'agency',
  category: 'lifecycle',
  payload: {
    agencyId: 'string',
    tenantId: 'string',           // matches sibling prm.agency.* events
    previous: 'string | null',    // ISO date YYYY-MM-DD or null
    current: 'string | null',
    changedByUserId: 'string',
  },
  // Future: portalBroadcast for SSE-driven dashboard refresh.
}
```

The event is purely additive — the frozen events table comment explicitly
allows additions; only renames/deletions are forbidden. This event is
**distinct** from `prm.agency.onboarding_state_changed`; setting the anchor
does NOT count as an onboarding state change for the purposes of Spec #1's
cascade subscriber.

**Response DTO update — `summariseAgency`:**
The PATCH route returns `summariseAgency(agency)` (defined in
`src/modules/prm/api/agency/route.ts:33`). The DTO whitelists fields
explicitly. **It must be updated to include `partnershipStartDate`** —
otherwise PATCH silently drops the new field from its response and the
US-PY.1 happy path ("UI re-reads the agency after save") breaks. This DTO
is also reused by the GET list route (`api/agency/route.ts:97`), so the
field appears in agency-list responses for free.

**Optimistic concurrency — `version` bump:**
`updateAgencyBackendSchema` is `.strict()` and the entity tracks `version`
(see entity comment lines 95–101 — optimistic-concurrency contract). Like
every other admin-only field write, mutating `partnership_start_date` MUST
bump `agency.version`. `agencyService.updateAgency` already increments
`version` on any field change; the implementer must verify the new
field-diff branch is reached before the version increment, not after.

**Cache invalidation — clarified scope:** the dashboard route is currently
UNCACHED in v1 (per Spec #2 §3.3 deferral note: "cache wrappers attach at
the CRUD-factory layer; not wired in T1"). The only cache today is the
30s in-memory TTL in `useDashboardData` (`src/modules/prm/widgets/injection/_shared/useDashboardData.ts:48`),
which is browser-side and cannot be invalidated server-side. So:

- **v1 staleness budget:** 30s after PM edits the anchor — agency users see
  stale partnership year for that window. Acceptable trade for v1.
- **Future-ready hook:** the new event is the invalidation signal for
  whenever the dashboard cache wrapper lands (tracked in `POST-MVP-FOLLOW-UPS.md`).
  When a `portalBroadcast` mechanism exists, the same event drives an SSE
  refresh to clients.

**UI confirm guard:** the Agency edit page MUST show a confirm dialog when
PM edits a non-null `partnership_start_date` to a different non-null value:
"Changing the partnership start date will retroactively recompute every prior
partnership year — historical 'Year N closed with X' captions will move and
tier-eval history will be non-deterministic. Continue?" Clearing to null and
setting from null require no confirm.

## 6. Acceptance Criteria

**Data + helper**
- [ ] Migration adds `partnership_start_date` to `prm_agencies` (nullable, no default backfill).
- [ ] `getPartnershipYearWindow` helper unit-tested for: mid-year start, leap-year start (Feb 29 → Feb 28 next year), null input, asOf before `partnership_start_date` (returns Year 1).

**Validation (US-PY.1 failure paths)**
- [ ] PATCH `/api/prm/agency/{id}` rejects `partnership_start_date` more than 30 days in the future with HTTP 400 + Zod field error.
- [ ] PATCH rejects dates before 2020-01-01 with HTTP 400 + Zod field error.
- [ ] PATCH accepts `null` to clear the date.

**Dashboard window (US-PY.2 happy path)**
- [ ] Dashboard route returns `period.partnershipYear` correctly for an agency with `partnership_start_date = '2025-08-15'` and `asOf = '2026-09-01'` → `{ start: 2026-08-15, end: 2027-08-15, number: 2 }`.
- [ ] Dashboard route returns `period.partnershipYear: null` + `warnings: ['partnership_start_date_missing']` for an agency with null anchor.
- [ ] WIP "This year" and WIC "This year" toggles aggregate over the same partnership-year window when the anchor is set, and over calendar year as fallback when null.

**MIN route (Spec #3 contract)**
- [ ] `/api/prm/portal/min?partnershipYear=2` returns the correct deals for partnership year 2.
- [ ] `/api/prm/portal/min?partnershipYear=N` against a null-anchor agency returns HTTP 400 with `error.code = 'anchor_missing'`.
- [ ] Legacy `/api/prm/portal/min?year=N` still works; response includes `warnings: ['year_param_deprecated']` when `partnership_start_date` is set.
- [ ] `/api/prm/portal/min?year=N` against a null-anchor agency returns calendar-year results (no warning) — fallback path is unchanged from today's behavior.
- [ ] Response includes both `partnershipYear: number | null` and `calendarYear: number`. The legacy `year` field still ships and equals `calendarYear` for one release.

**Rollover legibility (US-PY.2 edges)**
- [ ] Within 30 days before rollover, dashboard shows the "New partnership year starts {date}" hint near the MIN tile.
- [ ] On the rollover day and for the next 30 days, MIN tile shows the prior year's final count via `period.partnershipYear.priorYearMinCount`.
- [ ] Dashboard route returns `priorYearMinCount` correctly when prior year exists; returns `null` when current year is Year 1.
- [ ] Leap-year edge: anchor `2024-02-29` rollover at `2025-02-28` produces a prior-year window of `[2024-02-29, 2025-02-28)` exclusive — `priorYearMinCount` over this window is correct.

**Event + audit (anchor mutation)**
- [ ] `prm.agency.partnership_anchor_changed` declared in `src/modules/prm/events.ts` with payload `{ agencyId, organizationId, previous, current, changedByUserId }`.
- [ ] PATCH `/api/prm/agency/{id}` mutating `partnership_start_date` (set / edit / clear) emits the event with both `previous` and `current` populated correctly.
- [ ] Setting `partnership_start_date` does NOT emit `prm.agency.onboarding_state_changed` (the existing onboarding cascade is unaffected).
- [ ] Agency edit page shows a confirm dialog when PM edits a non-null `partnership_start_date` to a different non-null value (no confirm for null→value or value→null).
- [ ] Spec acknowledges no server-side dashboard cache invalidation in v1 — staleness budget is 30s (client `useDashboardData` TTL). Documented, not a bug.

**Demo / test data**
- [ ] "Add Agency" PM flow does NOT auto-set `partnership_start_date` — it stays null until PM explicitly enters one (`createAgencyBackendSchema` does not include the field).
- [ ] No seed pathway in `setup.ts` is modified — there is no agency-row seeder there. Demo dashboards exercising the rollover affordance require OM staff to manually set the date on demo agencies via the Agency edit page (documented in §7 as deferred).

**OM staff UI**
- [ ] OM staff can set `partnership_start_date` via the Agency edit page (`/backend/prm/agency/{id}`) and the dashboard banner disappears for that agency on the next reload.

**Validator surface**
- [ ] `updateAgencyBackendSchema` (`.strict()`) gains the `partnershipStartDate` field with the documented Zod refinements.
- [ ] `createAgencyBackendSchema` does NOT add `partnershipStartDate` (new agencies start with null).
- [ ] `ADMIN_ONLY_AGENCY_FIELDS` adds both `'partnershipStartDate'` and `'partnership_start_date'` so the portal interceptor rejects portal-side writes.
- [ ] `portalMinQuerySchema` gains optional `partnershipYear` field; mutual-exclusivity with `year` is NOT enforced (`partnershipYear` wins when both supplied) — explicit test asserts that passing both does not error and returns the partnership-year window.

**Service + DTO + concurrency**
- [ ] `agencyService.updateAgency` adds an explicit field-diff branch for `partnershipStartDate` (matching existing branches for `tier`, `status`, `onboarded`, etc.).
- [ ] PATCH on `partnership_start_date` bumps `agency.version` (existing optimistic-concurrency contract — entity comment lines 95–101).
- [ ] `summariseAgency` DTO (`api/agency/route.ts:33`) returns `partnershipStartDate` (ISO date string or null). The agency-list route (`api/agency/route.ts:97`) inherits this for free.
- [ ] PATCH response shape: the field round-trips correctly (US-PY.1 happy path verifies the UI re-read after save).

**App-spec hygiene**
- [ ] App-spec glossary entry for MIN updated to "Partnership year (12 months from `Agency.partnership_start_date`)".
- [ ] All other "calendar year" references in MIN/KPI context (US-5.6, KPI summary, acceptance line, changelog summary) updated to "partnership year". Verified by `grep -nE "MIN.*calendar year|calendar year.*MIN" app-spec/app-spec.md` returning zero matches.

## 6.1 Surface inventory

**Touched (must change):**

| File | Why |
|---|---|
| `src/modules/prm/data/entities.ts` | Add `partnershipStartDate` column to `Agency` |
| `src/modules/prm/data/validators.ts` | `updateAgencyBackendSchema`, `ADMIN_ONLY_AGENCY_FIELDS`, `portalMinQuerySchema` |
| `src/modules/prm/lib/agencyService.ts` | Explicit field-diff branch + event emission in `updateAgencyBackendSchema`'s consumer (`updateAgency`) |
| `src/modules/prm/lib/partnershipYear.ts` | NEW — helper |
| `src/modules/prm/__tests__/partnershipYear.test.ts` | NEW — flat path matches sibling `tierRequirements.test.ts` (no `__tests__/lib/` subdir exists) |
| `src/modules/prm/api/agency/route.ts` | Update `summariseAgency` DTO to include the new field |
| `src/modules/prm/api/portal/min/route.ts` | Window swap, validator update, response shape additions |
| `src/modules/prm/api/portal/dashboard/route.ts` | Window swap, response envelope addition |
| `src/modules/prm/widgets/injection/_shared/useDashboardData.ts` | Type for new `period.partnershipYear` field |
| `src/modules/prm/widgets/injection/portal-{min,tier,wip,wic}/widget.client.tsx` | Use new envelope; show banner / rollover hint |
| `src/modules/prm/events.ts` | NEW event entry — additive |
| `src/modules/prm/migrations/Migration<timestamp>_prm_agency_partnership_start_date.ts` | NEW migration — descriptive suffix matches the dominant PRM convention |
| `src/modules/prm/backend/.../agency/[id]/page.tsx` (Agency edit page) | New date input + confirm dialog |

**Explicit no-ops (do NOT touch):**

| File | Why no-op |
|---|---|
| `src/modules/prm/search.ts` | Admin-only metadata, not user-searchable |
| `src/modules/prm/ce.ts` | Native column, not a custom field |
| `src/modules/prm/translations.ts` | Date field, not translated |
| `src/modules/prm/notifications.ts` | No notification fires in v1 — rollover hint is client-side from `period.partnershipYear.end` |
| `src/modules/prm/data/enrichers.ts` | Direct column read; no enrichment needed |
| `src/modules/prm/setup.ts` | No agency-row seeding pathway exists in `setup.ts` (it seeds dictionaries + workflow + sidebar order only). Demo data setup is out of scope for this spec — see §7. |
| `src/modules/prm/api/agency-member/`, `case-study/`, `prospects/`, `rfp/`, etc. | Unrelated surfaces |

## 7. Out of Scope (deferred)

- Backfill strategy for existing agencies. **Decision: leave null.** OM staff sets each one manually via the Agency edit page.
- **Demo / test agency seeding** — `setup.ts` has no agency-row seeder today (only dictionaries, workflow, sidebar order). Adding one is out of scope; demo dashboards exercising rollover require OM staff to set `partnership_start_date` manually on demo agencies. If a seeder is added later, it should set the field to a date 6–18 months in the past, varied per agency.
- Renewal as a first-class event (TierRenewal entity, audit trail). If needed, promote to a follow-up spec.
- Pro-rated tier thresholds for partial first partnership year. Tier thresholds are evaluated against full-year MIN counts; an agency 3 months into their first year simply has a low MIN count and won't qualify for higher tiers yet — that's correct behaviour.
- Notification when partnership year is about to roll over. Add later if requested.
- Server-side dashboard cache invalidation. Dashboard route is uncached in v1 (per Spec #2 §3.3 deferral). When the cache wrapper lands, the `prm.agency.partnership_anchor_changed` event is the invalidation signal — already declared.

## 8. Risk & BC Analysis

- **Forward contract for deferred tier-evaluation work:** no spec exists yet (Spec #5 in `.ai/specs/` is `rfp-broadcast-response`, unrelated). On approval of this spec, add an entry to `POST-MVP-FOLLOW-UPS.md` worded as: *"When the PRM tier-evaluation worker is specced, MIN aggregation MUST import `getPartnershipYearWindow` from `src/modules/prm/lib/partnershipYear.ts` — do NOT recompute calendar-year windows. Same constraint applies to `priorYearMinCount` for downgrade decisions."*
- **BC for Spec #3 (attribution-loop) historical MIN:** the `priorYearMinCount` rollover affordance gives Spec #3's deferred MIN-snapshot table a second consumer (the first being tier-eval downgrade decisions). Worth noting in `POST-MVP-FOLLOW-UPS.md` so the snapshot table's design accommodates both consumers.
- **BC for `contract_signed: boolean`:** kept untouched. Spec #1's onboarding cascade subscriber continues to work. Future cleanup possible but not required.
- **MIN route param migration:** `?year=N` continues to work for one release with a deprecation warning. Frontend (`useDashboardData` is the only caller; the legacy MIN page was removed) must migrate to `?partnershipYear=N` before the next release. Tracked as a single follow-up commit; if missed, fallback semantics keep the route working.
- **Migration safety:** column add is non-blocking on Postgres for any reasonable table size. Zero-downtime.
- **PM edits an existing anchor — accepted history mutation.** When PM changes a non-null `partnership_start_date` to a different non-null value, every prior partnership year's window recomputes. `priorYearMinCount` is computed live (no snapshot table in v1), so historical "Year N closed with X licenses" captions move accordingly. Tier-eval history (once Spec #5 ships) becomes non-deterministic against the same calendar dates. **Accepted v1 risk** — OM staff is small, trusted, and the alternative (immutable anchor + a `partnership_anchors` history table) is over-engineering for the current scale. The UI confirm dialog (§5) makes the consequence explicit at edit time. Promote to a snapshot table in a follow-up spec if Spec #5 needs deterministic history.
- **Integration tests:** PRM Playwright suite is currently empty (deleted 2026-05-09 per the abandoned SPEC-2026-05-09; rebuild owed via SPEC-2026-05-09b under the tenant-per-spec model). This spec adds **no integration tests** — the helper gets unit tests, the API contract tests follow whatever shape SPEC-2026-05-09b produces. Do not recreate deleted Playwright helpers.

## 9. Changelog

| Date | Change |
|------|--------|
| 2026-05-10 | Initial spec, drafted from dashboard widget iteration session |
| 2026-05-10 | PM review (om-product-manager subagent) → applied 4 must-haves: user stories, future/far-past validation, Spec #3 MIN-route param semantics, rollover legibility. Plus 3 corrections: app-spec line list expanded (252/908/1129/1519), `seedExamples` promoted to acceptance criterion, empty Playwright suite noted. |
| 2026-05-10 | Second-pass PM review → applied 4 follow-ups: null-anchor + canonical-param 400 + `anchor_missing` code, dashboard cache-bust on anchor mutation, UI confirm dialog for non-null anchor edits, leap-year `priorYearMinCount` acceptance line. Documented "anchor edits move history" as accepted v1 risk in §8. |
| 2026-05-10 | Third-pass adversarial review (om-cto subagent) → corrected factual errors against shipped code: route is `/api/prm/agency/{id}` (singular, not plural), feature flag is `prm.agency.update_all` (not `prm.agency.manage`), MIN response is camelCase with no `tier_target` field. Added missing validator surface (`portalMinQuerySchema`, `updateAgencyBackendSchema`, `ADMIN_ONLY_AGENCY_FIELDS`). Declared the new `prm.agency.partnership_anchor_changed` event explicitly. Downgraded the cache-bust claim — dashboard route is uncached in v1; staleness budget is the 30s client TTL. Reworded "Spec #5" forward-contract since no such spec exists yet. Added §6.1 explicit no-op surface list. Locked MIN counting predicate (`signedAt OR attributedAt`) as unchanged — only the window bounds shift. Bumped commits estimate to 3. Replaced app-spec line numbers with grep strings. |
| 2026-05-10 | Fourth-pass adversarial review (fresh-context om-cto subagent) → caught: (1) `seedExamples` doesn't exist in `setup.ts` — fictitious AC dropped, demo seeding moved to §7 deferred. (2) `summariseAgency` DTO (`api/agency/route.ts:33`) whitelists fields and would silently drop the new column from PATCH responses — added DTO update to surface inventory + AC. (3) Event emission lives in `agencyService.updateAgency`, not the route handler; payload convention uses `tenantId` not `organizationId` — corrected both. (4) Service-level field-diff branch must be added explicitly. (5) `version` bump AC made explicit (optimistic concurrency). (6) Migration filename pinned to `Migration<ts>_prm_agency_partnership_start_date.ts`. (7) Test path corrected to flat `__tests__/partnershipYear.test.ts` (no `__tests__/lib/`). (8) `portalMinQuerySchema` precedence AC made explicit. §6.1 rewritten as a touched/no-op surface inventory. |

---

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| Phase 1 — Entity + migration | Done | 2026-05-10 | `partnership_start_date` (nullable date) added to `Agency`. Migration `Migration20260510210902_prm_agency_partnership_start_date.ts` — single ALTER TABLE add column. Applied via `yarn mercato db migrate`. |
| Phase 2 — Helper + routes + validators + service | Done | 2026-05-10 | `getPartnershipYearWindow` helper at `src/modules/prm/lib/partnershipYear.ts` with 8 unit tests passing (covers Feb-29 clamp, asOf-before-anchor, multi-year walk). Validator updates (3 schemas) + admin-only field guard. `agencyService.updateAgency` field-diff branch + version bump. `summariseAgency` DTO returns `partnershipStartDate`. Dashboard + MIN routes use the helper; `?partnershipYear=N` against null anchor returns 400 `anchor_missing`; `?year=N` falls back to calendar year. New response envelope `period.partnershipYear` + `priorYearMinCount` for rollover affordance. |
| Phase 3 — Event + UI | Partial | 2026-05-10 | Backend portions DONE: `prm.agency.partnership_anchor_changed` event added to `events.ts`, emitted from `agencyService.updateAgency` with `tenantId` payload convention. Agency edit page gains a `date` input + `useConfirmDialog` confirm guard for non-null → non-null edits. **Deferred — portal MIN-widget banner/hint/caption**: the PRM portal widgets tree (`src/modules/prm/widgets/`) is currently uncommitted on `develop` and lands in a separate PR. When that tree ships, the spec's required portal UI affordances (null-anchor banner, "New partnership year starts {date}" pre-rollover hint, "Year N-1 closed with X licenses" post-rollover caption) wire into the MIN widget. The dashboard route already returns the envelope; the widget consumer is the remaining gap. Tracked in `POST-MVP-FOLLOW-UPS.md`. |
| Phase 4 — App-spec edits | Done | 2026-05-10 | Glossary entry + 4 cross-references updated. Verified `grep -nE "MIN.*calendar year|calendar year.*MIN"` returns only intentional fallback documentation. |
| Phase 5 — Verification | Done | 2026-05-10 | `yarn generate` ✓. `yarn jest` PRM scope: 679/680 passing — single failure (`llmScoringDraft.test.ts`) is a pre-existing model-id mismatch unrelated to this spec. TypeScript: 0 errors. |

### Cosmetic UI changes (out-of-scope for this spec)

The dashboard widget iteration produced cosmetic changes (WIC/WIP/MIN title expansions per the user's renames, MIN list cleanup, WIP redesign with the correct prospect-lifecycle states, tier 4-pip stepper, etc.) — those land in a separate PR alongside the partnership-year envelope changes that ARE in this spec.
