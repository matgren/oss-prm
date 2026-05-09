/**
 * Portal-side RFP test fixtures (T5 / TC-PRM-PORTAL-RFP-BROWSE — Spec #5).
 *
 * Wraps the customer-portal RFP routes (under `/api/prm/portal/rfp/...`) for
 * use in Playwright integration specs. All helpers go through real
 * production routes; auth is the customer JWT obtained via `loginCustomer`.
 *
 * Composes with the new tenant fixture: pass `tenant.request` for the
 * `APIRequestContext`, but use `customerToken` (not `tenant.staffToken`) —
 * portal routes require customer auth, not staff auth.
 */

import { expect, type APIRequestContext } from '@playwright/test'
import { customerApiRequest } from './customerAuth'
import { readJsonSafe, expectId } from '@open-mercato/core/testing/integration'

/**
 * GET `/api/prm/portal/rfp` — agency-side RFP inbox.
 *
 * Returns the parsed body envelope (status code is asserted 200 inside).
 * Used by TC-PRM-PORTAL-RFP-BROWSE-001 to assert that a freshly-published
 * RFP shows up in the portal inbox of an eligible agency's member.
 */
export async function listPortalRfpInboxFixture(
  request: APIRequestContext,
  customerToken: string,
  query: { tab?: 'unread' | 'responded' | 'declined' | 'all'; pageSize?: number } = {},
): Promise<{
  items: Array<{
    rfpId: string
    broadcastId: string
    title: string
    status: string
    receivedFrom?: string | null
    firstOpenedAt?: string | null
    declinedAt?: string | null
  }>
  total?: number
}> {
  const search = new URLSearchParams()
  if (query.tab) search.set('tab', query.tab)
  if (query.pageSize !== undefined) search.set('pageSize', String(query.pageSize))
  const path = `/api/prm/portal/rfp${search.toString() ? `?${search.toString()}` : ''}`
  const response = await customerApiRequest(request, 'GET', path, { customerToken })
  const body = await readJsonSafe<{
    ok?: true
    items?: Array<{
      rfpId: string
      broadcastId: string
      title: string
      status: string
      receivedFrom?: string | null
      firstOpenedAt?: string | null
      declinedAt?: string | null
    }>
    total?: number
  }>(response)
  expect(
    response.status(),
    `GET /api/prm/portal/rfp should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  return {
    items: Array.isArray(body?.items) ? body!.items! : [],
    total: body?.total,
  }
}

/**
 * POST `/api/prm/portal/rfp/{id}/response/draft` — auto-save a draft.
 *
 * Idempotent upsert by `(rfp_id, agency_id)`; first POST creates the row,
 * subsequent POSTs update it. Returns the response id.
 */
export async function draftPortalRfpResponseFixture(
  request: APIRequestContext,
  customerToken: string,
  rfpId: string,
  input: {
    tech_experience?: string | null
    domain_experience?: string | null
    differentiators?: string | null
    attached_case_study_ids?: string[]
  },
): Promise<string> {
  const data: Record<string, unknown> = {
    attached_case_study_ids: input.attached_case_study_ids ?? [],
  }
  if (input.tech_experience !== undefined) data.tech_experience = input.tech_experience
  if (input.domain_experience !== undefined) data.domain_experience = input.domain_experience
  if (input.differentiators !== undefined) data.differentiators = input.differentiators

  const response = await customerApiRequest(
    request,
    'POST',
    `/api/prm/portal/rfp/${encodeURIComponent(rfpId)}/response/draft`,
    { customerToken, data },
  )
  const body = await readJsonSafe<{ ok?: true; id?: string; response?: { id?: string } }>(response)
  expect(
    response.status(),
    `POST /api/prm/portal/rfp/${rfpId}/response/draft should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  return expectId(
    body?.id ?? body?.response?.id,
    'Portal RFP draft response should include id',
  )
}

/**
 * POST `/api/prm/portal/rfp/{id}/response/submit` — submit a previously-drafted response.
 *
 * Returns the response status + parsed envelope so callers can assert on
 * domain-specific shapes (the submit endpoint is idempotent — re-submitting
 * a submitted response is OK).
 */
export async function submitPortalRfpResponseFixture(
  request: APIRequestContext,
  customerToken: string,
  rfpId: string,
): Promise<{ status: number; body: { ok?: boolean; id?: string; status?: string; error?: { code: string; message: string } } | null }> {
  const response = await customerApiRequest(
    request,
    'POST',
    `/api/prm/portal/rfp/${encodeURIComponent(rfpId)}/response/submit`,
    { customerToken },
  )
  const body = await readJsonSafe<{
    ok?: boolean
    id?: string
    status?: string
    error?: { code: string; message: string }
  }>(response)
  return { status: response.status(), body }
}
