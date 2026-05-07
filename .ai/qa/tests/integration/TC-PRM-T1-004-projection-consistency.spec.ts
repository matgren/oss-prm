import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-004 — Spec #2 §9 IT-9.4 ProspectCandidateIndex projection consistency.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.4 + §4.3 (subscriber)
 *   + §5.2 (`prm_prospect_candidate_index`), POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.4".
 *
 * Scenario:
 *   "`ProspectCandidateIndex` keys match aggregate after edit + soft-delete."
 *
 * The projection subscriber binds three event names:
 *   - `prm.prospect.registered`           → UPSERT row keyed by prospect_id
 *   - `prm.prospect.updated`              → re-derive normalized keys
 *   - `prm.prospect.registration_reverted` → DELETE row
 *   - `prm.prospect.status_changed`       → UPDATE current_status mirror
 *
 * The projection drives the B4 cross-agency candidate-picker (`/api/prm/prospects`),
 * which the route uses to translate normalized-key filters into prospect IDs.
 * Hits in the keyed search ⇒ projection has the row; misses ⇒ row is gone.
 *
 * Subscribers are declared `persistent: true` (see `subscribers/prospect-candidate-index-*.ts`)
 * — they are queued and processed asynchronously by the worker, so this test
 * uses `expect.poll(...)` to wait for projection convergence after each write.
 * The 10s timeout is defence-in-depth; in practice a healthy worker processes
 * the event in <1s.
 *
 * Soft-delete (revert) is a service-only path — there is no public API endpoint
 * for it (intentional: invariants forbid hard delete and the only legitimate
 * undo is the saga-driven compensating event in Spec #3). This test therefore
 * exercises the projection paths reachable via PUBLIC HTTP routes:
 *   1. POST register   → projection has the original normalized keys.
 *   2. PATCH edit      → projection swaps to the new normalized keys.
 *   3. PATCH transition → projection mirrors `current_status`.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-004: Spec #2 §9 IT-9.4 — projection consistency after edit + transition', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Projection reflects normalized keys + current_status after register/edit/transition', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-004-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // Distinct keys so the keyed search is deterministic — `${suffix}` ensures
    // no cross-spec leak via a previous test's data (resetPrmState already
    // covers it but defence-in-depth helps when the suite is run in isolation).
    const originalCompany = `T1-004 Original Co ${suffix}`
    const originalEmail = `t1-004-original-${suffix}@example.test`
    const editedCompany = `T1-004 Edited Co ${suffix}`
    const editedEmail = `t1-004-edited-${suffix}@example.test`

    // ---- Step 1: register
    const prospectId = await createProspectFixture(request, agency.admin.token, {
      companyName: originalCompany,
      contactName: 'Jamie Lead',
      contactEmail: originalEmail,
      source: 'agency_owned',
    })

    // Verify projection caught the original keys via B4 normalized-key search.
    // `normalizeCompanyName` lower-cases + strips punctuation; the route
    // re-applies the same normalization so we can pass the raw inputs.
    const findOriginal = async () => listB4ByKey(request, staffToken, {
      normalizedCompanyName: originalCompany,
      lowercasedContactEmail: originalEmail,
    })
    const findEdited = async () => listB4ByKey(request, staffToken, {
      normalizedCompanyName: editedCompany,
      lowercasedContactEmail: editedEmail,
    })

    // Subscriber is async (`persistent: true`) — poll until the row appears.
    await expect
      .poll(async () => (await findOriginal()).map((p) => p.id).includes(prospectId), {
        timeout: 10_000,
        message: 'projection must include the registered prospect under the original normalized keys',
      })
      .toBe(true)
    const afterRegister = await findOriginal()
    expect(afterRegister.find((p) => p.id === prospectId)?.status).toBe('new')

    // The same query against the EDITED keys must NOT return the prospect yet —
    // proves our search is sensitive (defence against false positives).
    const editedKeysPreEdit = await findEdited()
    expect(editedKeysPreEdit.map((p) => p.id)).not.toContain(prospectId)

    // ---- Step 2: edit normalized fields via portal PATCH
    const editResponse = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'edit',
          companyName: editedCompany,
          contactEmail: editedEmail,
        },
      },
    )
    const editBody = await readJsonSafe<{
      ok?: true
      prospect?: { id?: string; companyName?: string; contactEmail?: string }
      changedFields?: string[]
    }>(editResponse)
    expect(editResponse.status(), `PATCH edit body=${JSON.stringify(editBody)}`).toBe(200)
    expect(editBody?.prospect?.companyName).toBe(editedCompany)
    expect(editBody?.prospect?.contactEmail).toBe(editedEmail)
    expect(editBody?.changedFields).toEqual(expect.arrayContaining(['companyName', 'contactEmail']))

    // The `prm.prospect.updated` subscriber re-derives the normalized keys; poll
    // until the new keys hit AND the original keys evict (idempotent UPSERT
    // keyed on prospect_id, so the row migrates rather than duplicates).
    await expect
      .poll(async () => (await findEdited()).map((p) => p.id).includes(prospectId), {
        timeout: 10_000,
        message: 'projection must match the new keys after edit',
      })
      .toBe(true)
    await expect
      .poll(async () => (await findOriginal()).map((p) => p.id).includes(prospectId), {
        timeout: 10_000,
        message: 'projection must NOT match the original keys after edit (subscriber re-derived normalized keys)',
      })
      .toBe(false)
    const afterEditNewKeys = await findEdited()
    // current_status mirror still reflects the aggregate — `new` (no transition yet).
    expect(afterEditNewKeys.find((p) => p.id === prospectId)?.status).toBe('new')

    // ---- Step 3: transition the prospect; current_status mirror MUST update
    const fresh = afterEditNewKeys.find((p) => p.id === prospectId)!
    const transitionResponse = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'transition',
          toStatus: 'qualified',
          ifMatchStatusChangedAt: fresh.statusChangedAt,
        },
      },
    )
    expect(transitionResponse.status()).toBe(200)

    // Poll until the `prm.prospect.status_changed` subscriber has updated the
    // projection's `current_status` mirror to `qualified`.
    await expect
      .poll(
        async () => {
          const rows = await findEdited()
          return rows.find((p) => p.id === prospectId)?.status
        },
        {
          timeout: 10_000,
          message: 'projection current_status mirror must converge to qualified after transition',
        },
      )
      .toBe('qualified')

    // ---- Step 4: status filter is honoured via the projection's current_status column
    const qualifiedOnly = await listB4ByKey(request, staffToken, {
      normalizedCompanyName: editedCompany,
      lowercasedContactEmail: editedEmail,
      status: 'qualified',
    })
    expect(qualifiedOnly.map((p) => p.id)).toContain(prospectId)

    const newOnlyAfterTransition = await listB4ByKey(request, staffToken, {
      normalizedCompanyName: editedCompany,
      lowercasedContactEmail: editedEmail,
      status: 'new',
    })
    expect(
      newOnlyAfterTransition.map((p) => p.id),
      'projection current_status mirror must filter the prospect out of status=new after transition',
    ).not.toContain(prospectId)
  })
})

/**
 * GET `/api/prm/prospects` — B4 backend cross-agency list.
 *
 * The route reads the `prm_prospect_candidate_index` projection when normalized-key
 * filters are present (see `src/modules/prm/api/prospects/route.ts`). A hit on
 * normalized keys = the projection has a row keyed under those normalized values;
 * a miss = the row is absent or under different keys.
 */
async function listB4ByKey(
  request: import('@playwright/test').APIRequestContext,
  staffToken: string,
  filters: {
    normalizedCompanyName?: string
    lowercasedContactEmail?: string
    status?: 'new' | 'qualified' | 'contacted' | 'won' | 'lost' | 'dormant'
    pageSize?: number
  },
): Promise<Array<{ id: string; status: string; statusChangedAt: string }>> {
  const params = new URLSearchParams()
  if (filters.normalizedCompanyName) params.set('normalizedCompanyName', filters.normalizedCompanyName)
  if (filters.lowercasedContactEmail) params.set('lowercasedContactEmail', filters.lowercasedContactEmail)
  if (filters.status) params.set('status', filters.status)
  params.set('pageSize', String(filters.pageSize ?? 50))
  const response = await apiRequest(
    request,
    'GET',
    `/api/prm/prospects?${params.toString()}`,
    { token: staffToken },
  )
  const body = await readJsonSafe<{
    ok?: boolean
    items?: Array<{ id: string; status: string; statusChangedAt: string }>
    error?: unknown
  }>(response)
  expect(
    response.status(),
    `GET /api/prm/prospects?${params.toString()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  return body?.items ?? []
}
