import { expect, type APIRequestContext } from '@playwright/test'
import {
  apiRequest,
  deleteEntityByPathIfExists,
  expectId,
  readJsonSafe,
} from '@open-mercato/core/testing/integration'

/**
 * Reset every PRM-owned table.
 *
 * Hits the test-only `POST /api/prm/test-fixtures/reset` seam (gated by
 * `OM_PRM_TEST_FIXTURES_ENABLED=1`). Used by Playwright integration specs in
 * `test.beforeEach` so cross-spec Agency / RFP / Prospect leaks don't bleed
 * into siblings within a single ephemeral run.
 *
 * Non-PRM tables (organisations, customer_users, customer_roles, ...) are NOT
 * touched — those are seeded once per ephemeral run by the bootstrap step and
 * the suite depends on that state surviving across specs.
 *
 * Pass the staff `admin` Bearer token (the same one every PRM spec already
 * obtains via `getAuthToken(request, 'admin')` for its other fixture calls).
 *
 * Throws if the seam returns anything other than 200 + `{ ok: true }`. The
 * 404-branch (env var unset) is the most likely failure mode in production-y
 * environments and the assertion error makes that easy to diagnose.
 */
export async function resetPrmState(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const response = await apiRequest(request, 'POST', '/api/prm/test-fixtures/reset', { token })
  const body = await readJsonSafe<{ ok?: boolean; truncatedTables?: string[]; error?: string }>(response)
  expect(
    response.status(),
    `POST /api/prm/test-fixtures/reset should return 200 (set OM_PRM_TEST_FIXTURES_ENABLED=1); got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  expect(body?.ok, `reset response should have ok:true; body=${JSON.stringify(body)}`).toBe(true)
}

/**
 * Agency creation fixture.
 *
 * Hits `POST /api/prm/agency` with the staff `admin` token. Returns the new
 * agency id. The handler also creates an `Organization` row + scopes the
 * Agency to it (see `agencyService.createAgencyWithOrganization`), so a
 * single call seeds enough state for downstream PRM smokes.
 *
 * Note: `/api/prm/agency` does NOT expose a DELETE endpoint (Agency lifecycle
 * uses `status = historical` rather than hard delete). `deleteAgencyIfExists`
 * therefore relies on the ephemeral testcontainers DB being torn down at the
 * end of the run for cleanup. Tests should use unique slugs per invocation.
 */
export async function createAgencyFixture(
  request: APIRequestContext,
  token: string,
  input: {
    name: string
    slug: string
    tier?: 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'
    headquartersCountry?: string
  },
): Promise<string> {
  const data: Record<string, unknown> = {
    name: input.name,
    slug: input.slug,
    tier: input.tier ?? 'om_agency',
    headquartersCountry: (input.headquartersCountry ?? 'US').toUpperCase(),
  }
  const response = await apiRequest(request, 'POST', '/api/prm/agency', { token, data })
  const body = await readJsonSafe<{ ok: true; agency?: { id?: string } }>(response)
  expect(
    response.status(),
    `POST /api/prm/agency should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  return expectId(body?.agency?.id, 'Agency creation response should include agency.id')
}

/**
 * Agency cleanup. No DELETE endpoint exists on `/api/prm/agency/[id]`, so
 * this is a no-op kept for symmetry with the OM fixture pattern. Tests must
 * either rely on ephemeral DB teardown or mark the agency `historical`
 * via PATCH if isolation matters within a single test run.
 */
export async function deleteAgencyIfExists(
  _request: APIRequestContext,
  _token: string | null,
  _agencyId: string | null,
): Promise<void> {
  return
}

/**
 * License-deal creation fixture.
 *
 * Hits `POST /api/prm/license-deal` (backend, staff token). Body matches
 * `createLicenseDealSchema` in `src/modules/prm/data/validators.ts` —
 * `licenseIdentifier` + `clientCompanyName` are required, the rest default
 * to a minimum that validates. Note that `agencyId` is NOT part of the
 * create payload; attribution to an agency happens via the separate
 * `POST /api/prm/license-deal/{id}/attribute` route.
 */
export async function createLicenseDealFixture(
  request: APIRequestContext,
  token: string,
  input: {
    licenseIdentifier?: string
    clientCompanyName: string
    clientIndustry?: string
    type?: string
    isRenewal?: boolean
    annualValueUsd?: number
    monthlyLicenseAmount?: number
    notes?: string
  },
): Promise<string> {
  const data: Record<string, unknown> = {
    licenseIdentifier: input.licenseIdentifier ?? `LIC-${Date.now().toString(36)}`,
    clientCompanyName: input.clientCompanyName,
    type: input.type ?? 'enterprise',
    isRenewal: input.isRenewal ?? false,
  }
  if (input.clientIndustry !== undefined) data.clientIndustry = input.clientIndustry
  if (input.annualValueUsd !== undefined) data.annualValueUsd = input.annualValueUsd
  if (input.monthlyLicenseAmount !== undefined) data.monthlyLicenseAmount = input.monthlyLicenseAmount
  if (input.notes !== undefined) data.notes = input.notes

  const response = await apiRequest(request, 'POST', '/api/prm/license-deal', { token, data })
  const body = await readJsonSafe<{ ok: true; licenseDeal?: { id?: string } }>(response)
  expect(
    response.status(),
    `POST /api/prm/license-deal should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  return expectId(
    body?.licenseDeal?.id,
    'License deal creation response should include licenseDeal.id',
  )
}

/**
 * License-deal cleanup. Wraps `deleteEntityByPathIfExists` against
 * `/api/prm/license-deal/{id}` (which exposes a DELETE handler).
 */
export async function deleteLicenseDealIfExists(
  request: APIRequestContext,
  token: string | null,
  licenseDealId: string | null,
): Promise<void> {
  if (!token || !licenseDealId) return
  await deleteEntityByPathIfExists(
    request,
    token,
    `/api/prm/license-deal/${encodeURIComponent(licenseDealId)}`,
  )
}

/**
 * Prospect creation fixture (portal-side).
 *
 * Prospect WRITES are portal-only (`POST /api/prm/portal/prospects`); the
 * backend list at `/api/prm/prospects` is read-only by design (Spec #2 §3.2,
 * "B4 — Cross-agency Prospect read-only list").
 *
 * Pass a partner-admin / partner-member CustomerUser JWT obtained via
 * `bootPartnerAgencyWithMembers(...)` (returned as `.admin.token` /
 * `.member.token`). The portal route resolves the Agency from the caller's
 * `AgencyMember` row, so an `agencyId` argument is intentionally not part of
 * the public surface — it would be ignored anyway.
 *
 * Backwards-compatibility: the legacy stub used to throw "not yet
 * implemented"; existing call sites passing a staff token will get a clear
 * error from the API (401/403) instead of a silent success.
 */
export async function createProspectFixture(
  request: APIRequestContext,
  customerToken: string,
  input: {
    companyName: string
    contactName: string
    contactEmail: string
    source?: 'agency_owned' | 'event' | 'other'
  },
): Promise<string> {
  const data: Record<string, unknown> = {
    companyName: input.companyName,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    ...(input.source ? { source: input.source } : {}),
  }
  const response = await apiRequest(request, 'POST', '/api/prm/portal/prospects', {
    token: customerToken,
    data,
  })
  const body = await readJsonSafe<{ ok?: true; id?: string; prospect?: { id?: string } }>(response)
  expect(
    response.status(),
    `POST /api/prm/portal/prospects should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  return expectId(body?.id ?? body?.prospect?.id, 'Prospect creation response should include id')
}

export async function deleteProspectIfExists(
  _request: APIRequestContext,
  _token: string | null,
  _prospectId: string | null,
): Promise<void> {
  return
}

/**
 * PATCH an Agency into the `status='active' AND onboarded=true` state required
 * to make it eligible for RFP broadcast (Spec #5 §2 — eligibility evaluator
 * filters `status='active' AND onboarded=true` in SQL).
 *
 * `tier` is also patchable here so a single helper covers the §9.1 #1 setup
 * shape (3 agencies, distinct tiers).
 */
export async function setAgencyOnboardedFixture(
  request: APIRequestContext,
  token: string,
  agencyId: string,
  input: {
    tier?: 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'
    onboarded?: boolean
    status?: 'active' | 'inactive' | 'historical'
  } = {},
): Promise<void> {
  const data: Record<string, unknown> = {
    onboarded: input.onboarded ?? true,
  }
  if (input.tier !== undefined) data.tier = input.tier
  if (input.status !== undefined) data.status = input.status
  const response = await apiRequest(request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token,
    data,
  })
  expect(
    response.status(),
    `PATCH /api/prm/agency/${agencyId} should return 200; got ${response.status()}`,
  ).toBe(200)
}

/**
 * RFP draft creation fixture — Spec #5 §3.1 `POST /api/prm/rfp`.
 *
 * Returns the new RFP id. Defaults are tuned to satisfy `createRfpDraftSchema`
 * with a minimum-viable payload; callers override `eligibility_filter`,
 * `min_tier`, or `explicit_agency_ids` to drive the §9.1 cases.
 */
export async function createRfpDraftFixture(
  request: APIRequestContext,
  token: string,
  input: {
    title?: string
    received_from?: string
    received_at?: string
    description?: string
    tech_requirements?: string
    domain_requirements?: string
    eligibility_filter: 'all_active' | 'by_min_tier' | 'explicit'
    min_tier?: 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'
    explicit_agency_ids?: string[]
    deadline_to_respond?: string
  },
): Promise<string> {
  const data: Record<string, unknown> = {
    title: input.title ?? `Test RFP ${Date.now().toString(36)}`,
    received_from: input.received_from ?? 'Test Client',
    received_at: input.received_at ?? new Date().toISOString(),
    description: input.description ?? 'Test RFP description.',
    tech_requirements: input.tech_requirements ?? 'Test tech requirements.',
    domain_requirements: input.domain_requirements ?? 'Test domain requirements.',
    eligibility_filter: input.eligibility_filter,
  }
  if (input.min_tier !== undefined) data.min_tier = input.min_tier
  if (input.explicit_agency_ids !== undefined) data.explicit_agency_ids = input.explicit_agency_ids
  if (input.deadline_to_respond !== undefined) data.deadline_to_respond = input.deadline_to_respond

  const response = await apiRequest(request, 'POST', '/api/prm/rfp', { token, data })
  const body = await readJsonSafe<{ ok: true; id?: string; rfp?: { id?: string } }>(response)
  expect(
    response.status(),
    `POST /api/prm/rfp should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  return expectId(body?.id ?? body?.rfp?.id, 'RFP creation response should include id')
}

/**
 * Publish an RFP via `POST /api/prm/rfp/{id}/publish`. Returns the response
 * body envelope so callers can assert `broadcastAgencyIds` / `status`.
 */
export async function publishRfpFixture(
  request: APIRequestContext,
  token: string,
  rfpId: string,
  body: { confirmedAgencyIds?: string[] } = {},
): Promise<{
  status: number
  body: {
    ok?: boolean
    id?: string
    status?: string
    broadcastAgencyIds?: string[]
    error?: { code: string; message: string; details?: Record<string, unknown> }
  } | null
}> {
  const response = await apiRequest(request, 'POST', `/api/prm/rfp/${rfpId}/publish`, {
    token,
    data: body,
  })
  const json = await readJsonSafe<{
    ok?: boolean
    id?: string
    status?: string
    broadcastAgencyIds?: string[]
    error?: { code: string; message: string; details?: Record<string, unknown> }
  }>(response)
  return { status: response.status(), body: json }
}

/**
 * Unpublish an RFP via `POST /api/prm/rfp/{id}/unpublish`. `reason` is
 * mandatory per §3.3 idempotency table.
 */
export async function unpublishRfpFixture(
  request: APIRequestContext,
  token: string,
  rfpId: string,
  reason: string,
): Promise<{
  status: number
  body: {
    ok?: boolean
    id?: string
    status?: string
    error?: { code: string; message: string; details?: Record<string, unknown> }
  } | null
}> {
  const response = await apiRequest(request, 'POST', `/api/prm/rfp/${rfpId}/unpublish`, {
    token,
    data: { reason },
  })
  const json = await readJsonSafe<{
    ok?: boolean
    id?: string
    status?: string
    error?: { code: string; message: string; details?: Record<string, unknown> }
  }>(response)
  return { status: response.status(), body: json }
}

/* -------------------------------------------------------------------------- *
 * Portal-side prospect helpers (Spec #2 §3.2 — used by T1/T2 §9 smokes)
 * -------------------------------------------------------------------------- */

/**
 * Shape of the prospect summary returned by both
 * `GET  /api/prm/portal/prospects/{id}` and the PATCH responses.
 *
 * We only declare the fields the §9 smokes assert on. Surfaced verbatim from
 * `summariseProspect` in `src/modules/prm/api/portal/prospects/route.ts`.
 */
export type PortalProspectSummary = {
  id: string
  agencyId: string
  organizationId: string
  companyName: string
  contactName: string
  contactEmail: string
  source: string
  status: string
  lostReason: string | null
  notes: string | null
  registeredAt: string
  statusChangedAt: string
  registeredByAgencyMemberId: string
  canEdit?: boolean
  canTransitionTo?: string[]
}

/**
 * GET `/api/prm/portal/prospects/{id}` as a partner_admin / partner_member.
 *
 * Used by saga-polling specs (T2) to read the prospect's `status` after the
 * attribution saga walks it to `won`. The portal route already enforces
 * own-agency scope; the caller's `customerToken` carries the agency context.
 *
 * Imports the customer-portal `customerApiRequest` helper from `./customerAuth`
 * to keep parity with the customer JWT header contract.
 */
export async function getProspectViaPortalFixture(
  request: APIRequestContext,
  customerToken: string,
  prospectId: string,
): Promise<PortalProspectSummary> {
  const { customerApiRequest } = await import('./customerAuth')
  const response = await customerApiRequest(request, 'GET', `/api/prm/portal/prospects/${prospectId}`, {
    customerToken,
  })
  const body = await readJsonSafe<{ ok?: true; prospect?: PortalProspectSummary }>(response)
  expect(
    response.status(),
    `GET /api/prm/portal/prospects/${prospectId} should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  if (!body?.prospect) {
    throw new Error(
      `GET /api/prm/portal/prospects/${prospectId} returned 200 but no prospect — body=${JSON.stringify(body)}`,
    )
  }
  return body.prospect
}

/**
 * PATCH `/api/prm/portal/prospects/{id}` with the `kind: 'transition'` discriminator.
 *
 * Two-step flow because the portal API requires `ifMatchStatusChangedAt` for
 * optimistic concurrency (Spec #2 invariant #15 / OQ-018 — concurrent
 * editors must see a 409 instead of silently overwriting):
 *
 *   1. GET the current prospect to capture `statusChangedAt`.
 *   2. PATCH with that token + the requested `toStatus`.
 *
 * Returns the post-transition prospect summary so callers can chain assertions.
 *
 * `toStatus` is constrained to portal-allowed transitions (`won` is system-only
 * and walked via the attribution saga in T2).
 */
export async function transitionProspectViaPortalFixture(
  request: APIRequestContext,
  customerToken: string,
  prospectId: string,
  toStatus: 'qualified' | 'contacted' | 'lost' | 'dormant',
  options: { lostReason?: string } = {},
): Promise<PortalProspectSummary> {
  const { customerApiRequest } = await import('./customerAuth')
  // Step 1: read current statusChangedAt for the optimistic-concurrency token.
  const current = await getProspectViaPortalFixture(request, customerToken, prospectId)
  const data: Record<string, unknown> = {
    kind: 'transition',
    toStatus,
    ifMatchStatusChangedAt: current.statusChangedAt,
  }
  if (toStatus === 'lost') {
    if (!options.lostReason) {
      throw new Error('transitionProspectViaPortalFixture: lostReason is required when toStatus="lost"')
    }
    data.lostReason = options.lostReason
  }
  const response = await customerApiRequest(
    request,
    'PATCH',
    `/api/prm/portal/prospects/${prospectId}`,
    { customerToken, data },
  )
  const body = await readJsonSafe<{ ok?: true; prospect?: PortalProspectSummary }>(response)
  expect(
    response.status(),
    `PATCH /api/prm/portal/prospects/${prospectId} (toStatus=${toStatus}) should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  if (!body?.prospect) {
    throw new Error(
      `PATCH /api/prm/portal/prospects/${prospectId} returned 200 but no prospect — body=${JSON.stringify(body)}`,
    )
  }
  return body.prospect
}

/* -------------------------------------------------------------------------- *
 * Backend license-deal helpers (Spec #3 §3.1 — used by T2 §9 smoke)
 * -------------------------------------------------------------------------- */

/**
 * Discriminated input payload for `POST /api/prm/license-deal/{id}/attribute`.
 * Mirrors `attributeLicenseDealSchema` in `src/modules/prm/data/validators.ts`.
 *
 * Only Path A is exercised by the T2 happy-path smoke (Golden Rule auto-pick),
 * but Path B / Path C shapes are exposed so future smokes can reuse the helper.
 */
export type AttributeLicenseDealInput =
  | {
      attribution_path: 'A'
      prospect_id: string
      golden_rule_default_prospect_id: string
      attribution_reasoning?: string
      competing_prospect_ids_to_retire?: string[]
    }
  | { attribution_path: 'B'; rfp_id: string }
  | { attribution_path: 'C'; attributed_agency_id: string; attribution_reasoning: string }

/**
 * POST `/api/prm/license-deal/{id}/attribute` with the staff `admin` token.
 *
 * Returns the 202 envelope so callers can assert `sagaCorrelationKey` +
 * `licenseDeal.attributedAgencyId`. The backend route runs the saga inline
 * (idempotent) so the response already reflects the attributed snapshot —
 * the T2 smoke still polls portal `/min` for defence-in-depth against
 * workers-not-running regressions.
 */
export async function attributeLicenseDealFixture(
  request: APIRequestContext,
  token: string,
  licenseDealId: string,
  input: AttributeLicenseDealInput,
): Promise<{
  status: number
  body: {
    ok?: boolean
    licenseDealId?: string
    sagaCorrelationKey?: string
    emittedEvents?: string[]
    licenseDeal?: { id: string; attributedAgencyId?: string | null; status?: string; attributionPath?: string }
    error?: { code: string; message: string; details?: Record<string, unknown> }
  } | null
}> {
  const response = await apiRequest(
    request,
    'POST',
    `/api/prm/license-deal/${encodeURIComponent(licenseDealId)}/attribute`,
    { token, data: input as unknown as Record<string, unknown> },
  )
  const json = await readJsonSafe<{
    ok?: boolean
    licenseDealId?: string
    sagaCorrelationKey?: string
    emittedEvents?: string[]
    licenseDeal?: { id: string; attributedAgencyId?: string | null; status?: string; attributionPath?: string }
    error?: { code: string; message: string; details?: Record<string, unknown> }
  }>(response)
  return { status: response.status(), body: json }
}

/**
 * GET `/api/prm/license-deal/golden-rule-candidates?clientCompanyName=...`.
 *
 * Used by the T2 smoke to resolve the deterministic `golden_rule_default_prospect_id`
 * for the Path A attribute call. The route returns ordered candidates with exactly
 * one `isDefaultPick: true` row (oldest non-lost match) — invariant #14.
 */
export async function listGoldenRuleCandidatesFixture(
  request: APIRequestContext,
  token: string,
  query: { clientCompanyName: string; contactEmail?: string; limit?: number },
): Promise<
  Array<{
    prospectId: string
    agencyId: string
    organizationId: string
    companyName: string
    contactName: string
    contactEmail: string
    status: string
    registeredAt: string
    registeredByAgencyMemberId: string
    isDefaultPick: boolean
  }>
> {
  const params = new URLSearchParams()
  params.set('clientCompanyName', query.clientCompanyName)
  if (query.contactEmail) params.set('contactEmail', query.contactEmail)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const response = await apiRequest(
    request,
    'GET',
    `/api/prm/license-deal/golden-rule-candidates?${params.toString()}`,
    { token },
  )
  const body = await readJsonSafe<{
    ok?: boolean
    candidates?: Array<{
      prospectId: string
      agencyId: string
      organizationId: string
      companyName: string
      contactName: string
      contactEmail: string
      status: string
      registeredAt: string
      registeredByAgencyMemberId: string
      isDefaultPick: boolean
    }>
  }>(response)
  expect(
    response.status(),
    `GET /api/prm/license-deal/golden-rule-candidates should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  return body?.candidates ?? []
}
