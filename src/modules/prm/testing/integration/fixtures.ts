import { expect, type APIRequestContext } from '@playwright/test'
import {
  apiRequest,
  deleteEntityByPathIfExists,
  expectId,
  readJsonSafe,
} from '@open-mercato/core/testing/integration'

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
 * Prospect creation fixture — placeholder.
 *
 * Prospect WRITES are portal-only (`POST /api/prm/portal/prospects`). The
 * backend list at `/api/prm/prospects` is read-only by design (Spec #2 §3.2,
 * "B4 — Cross-agency Prospect read-only list").
 *
 * To seed a Prospect via API a partner-admin customer token is required,
 * which depends on a customer-portal auth helper that is not yet shipped in
 * `@open-mercato/core/testing/integration`. Filling this in is owed work
 * (see Phase 4 of the run plan). Calling this fixture today throws so
 * tests fail loud rather than silently skip the partner-admin path.
 */
export async function createProspectFixture(
  _request: APIRequestContext,
  _token: string,
  _input: {
    agencyId: string
    companyName: string
    contactName: string
    contactEmail: string
    source?: 'agency_owned' | 'event' | 'other'
  },
): Promise<string> {
  throw new Error(
    'createProspectFixture is not yet implemented — needs a partner-admin portal token. ' +
      'Track the customer-portal auth helper in the run plan (Phase 4).',
  )
}

export async function deleteProspectIfExists(
  _request: APIRequestContext,
  _token: string | null,
  _prospectId: string | null,
): Promise<void> {
  return
}
