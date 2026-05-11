/**
 * TC-PRM-OPEN-VOCAB-TAGS-001 — open-vocabulary tag fields (SPEC-2026-05-11).
 *
 * Covers the three new tag-suggestion endpoints + the validator changes that
 * ship with the spec:
 *
 * Live blocks (staff auth — run on the current bootstrap-test-tenant fixture):
 *   3. tenant-wide RFP suggestions union (AC-INV-6)
 *   5. first-write-wins casing on per-agency endpoint (AC-INV-8, M5)
 *   6. legacy UUID filter on per-agency endpoint (AC-INV-9, M4)
 *   7. max-array cap rejected at validator (AC-INV-7, M1) — exercised via
 *      backend agency PATCH which hits `updateAgencyBackendSchema`.
 *   8. RFP `required_capabilities` tightening (AC-VAL-3, M6) — exercised via
 *      backend RFP POST which hits `createRfpDraftSchema`.
 *
 * Skipped blocks (partner_admin auth — blocked on upstream
 * bootstrap-test-tenant.ts seeding bug; un-skip when the fixture seeds PRM
 * customer roles; matches the existing TC-PRM-PORTAL-* skip pattern):
 *   1. per-agency union via portal endpoint
 *   2. cross-agency 404 via portal endpoint (AC-INV-1)
 *   4. cross-pollination via portal case-study save (AC-INV-2 portal path)
 */

import { test, expect } from './fixtures/tenantFixture'
import { apiRequest } from '@open-mercato/core/testing/integration'
import { createAgencyFixture, setAgencyOnboardedFixture } from '../testing/integration'

const LEGACY_UUID = '7a4b8c9d-1234-5678-9abc-def012345678'

/**
 * Block 3 — tenant-wide RFP tag suggestions endpoint.
 *
 * Asserts:
 *   - GET /api/prm/tag-suggestions?field=technologies (staff, `prm.rfp.create`)
 *     returns the union of all active agencies' `techCapabilities` in the tenant.
 *   - UUID-shaped legacy values are filtered out (smoke for the shared helper).
 *   - The route enforces `field=technologies` only (services 400s in v1).
 */
test('TC-PRM-OPEN-VOCAB-TAGS-001 — block 3: tenant-wide RFP tag-suggestion union', async ({
  tenant,
}) => {
  const stamp = Date.now().toString(36)

  // Seed two agencies with different techCapabilities.
  const agencyAId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `OpenVocab Block3 A w${tenant.workerIndex}`,
    slug: `openvocab-b3-a-${tenant.workerIndex}-${stamp}`,
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyAId, {
    onboarded: true,
    status: 'active',
  })
  const patchAResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyAId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: ['React', 'PyTorch'] },
  })
  expect(patchAResp.status(), `PATCH agency A should 200; got ${patchAResp.status()}`).toBe(200)

  const agencyBId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `OpenVocab Block3 B w${tenant.workerIndex}`,
    slug: `openvocab-b3-b-${tenant.workerIndex}-${stamp}`,
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyBId, {
    onboarded: true,
    status: 'active',
  })
  const patchBResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyBId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: ['Vue'] },
  })
  expect(patchBResp.status(), `PATCH agency B should 200; got ${patchBResp.status()}`).toBe(200)

  // Hit the tenant-wide endpoint.
  const resp = await apiRequest(
    tenant.request,
    'GET',
    '/api/prm/tag-suggestions?field=technologies',
    { token: tenant.staffToken },
  )
  expect(
    resp.ok(),
    `GET /api/prm/tag-suggestions should 200; got ${resp.status()}`,
  ).toBeTruthy()
  const body = (await resp.json()) as {
    ok: true
    items: Array<{ value: string; label: string }>
  }
  const values = body.items.map((i) => i.value)
  // Items are alphabetical case-insensitive. Verify all four agency-side tags appear.
  expect(values).toEqual(expect.arrayContaining(['PyTorch', 'React', 'Vue']))
  // Defensive: every item has matching `value === label` per the shared helper.
  for (const item of body.items) {
    expect(item.label).toBe(item.value)
  }

  // The route only exposes `field=technologies` in v1; `services` rejects.
  const wrongFieldResp = await apiRequest(
    tenant.request,
    'GET',
    '/api/prm/tag-suggestions?field=services',
    { token: tenant.staffToken },
  )
  expect(
    wrongFieldResp.status(),
    `GET ...?field=services should 400; got ${wrongFieldResp.status()}`,
  ).toBe(400)
})

/**
 * Block 5 — first-write-wins casing (AC-INV-8, M5).
 *
 * Agency A holds `['React', 'react']` in techCapabilities. The backend per-agency
 * suggestion endpoint collapses them to a single `'React'` entry (earliest
 * casing wins per `unique-preserving-first-casing`).
 */
test('TC-PRM-OPEN-VOCAB-TAGS-001 — block 5: first-write-wins casing on per-agency endpoint', async ({
  tenant,
}) => {
  const stamp = Date.now().toString(36)
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `OpenVocab Block5 w${tenant.workerIndex}`,
    slug: `openvocab-b5-${tenant.workerIndex}-${stamp}`,
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    onboarded: true,
    status: 'active',
  })
  // Save both casings (the validator now trims+min(1)+max(80) per element but does NOT case-fold).
  const patchResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: ['React', 'react'] },
  })
  expect(patchResp.status(), `PATCH should 200; got ${patchResp.status()}`).toBe(200)

  const resp = await apiRequest(
    tenant.request,
    'GET',
    `/api/prm/agency/${agencyId}/tag-suggestions?field=technologies`,
    { token: tenant.staffToken },
  )
  expect(resp.ok(), `GET should 200; got ${resp.status()}`).toBeTruthy()
  const body = (await resp.json()) as { ok: true; items: Array<{ value: string; label: string }> }
  const values = body.items.map((i) => i.value)
  expect(values).toEqual(['React'])
})

/**
 * Block 6 — legacy UUID filter (AC-INV-9, M4).
 *
 * Saves a UUID-shaped value into techCapabilities alongside a free-form slug.
 * The suggestion endpoint filters the UUID out via the shared helper's
 * `UUID_RE.test()` guard, leaving only `'GoLang'`.
 */
test('TC-PRM-OPEN-VOCAB-TAGS-001 — block 6: legacy UUID values filtered from suggestions', async ({
  tenant,
}) => {
  const stamp = Date.now().toString(36)
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `OpenVocab Block6 w${tenant.workerIndex}`,
    slug: `openvocab-b6-${tenant.workerIndex}-${stamp}`,
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    onboarded: true,
    status: 'active',
  })
  // After the validator relaxation, UUID strings are still valid trimmed-≤80-char
  // strings — they round-trip into storage without rejection.
  const patchResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: [LEGACY_UUID, 'GoLang'] },
  })
  expect(patchResp.status(), `PATCH should 200; got ${patchResp.status()}`).toBe(200)

  const resp = await apiRequest(
    tenant.request,
    'GET',
    `/api/prm/agency/${agencyId}/tag-suggestions?field=technologies`,
    { token: tenant.staffToken },
  )
  expect(resp.ok(), `GET should 200; got ${resp.status()}`).toBeTruthy()
  const body = (await resp.json()) as { ok: true; items: Array<{ value: string; label: string }> }
  const values = body.items.map((i) => i.value)
  // UUID dropped; only the free-form slug remains.
  expect(values).toEqual(['GoLang'])
})

/**
 * Block 7 — max-array cap (AC-INV-7, M1).
 *
 * `openTagSlugArray.max(50, 'prm.errors.tagArrayTooLarge')` rejects payloads
 * with >50 elements; the i18n key surfaces in the validator error so the
 * UI flash can translate it.
 */
test('TC-PRM-OPEN-VOCAB-TAGS-001 — block 7: array .max(50) rejected by backend agency PATCH', async ({
  tenant,
}) => {
  const stamp = Date.now().toString(36)
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `OpenVocab Block7 w${tenant.workerIndex}`,
    slug: `openvocab-b7-${tenant.workerIndex}-${stamp}`,
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    onboarded: true,
    status: 'active',
  })

  // 51 elements — should fail validation.
  const tooMany = Array.from({ length: 51 }, (_, i) => `cap-${i}`)
  const patchResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: tooMany },
  })
  expect(
    patchResp.status(),
    `PATCH with 51 elements should 400; got ${patchResp.status()}`,
  ).toBe(400)
  const errBody = (await patchResp.json()) as Record<string, unknown>
  // The i18n key surfaces somewhere in the error payload; we serialise the body
  // and grep rather than asserting exact shape (which is route-handler-specific).
  expect(JSON.stringify(errBody)).toMatch(/prm\.errors\.tagArrayTooLarge/)

  // 50 elements should pass.
  const exactlyFifty = Array.from({ length: 50 }, (_, i) => `cap-${i}`)
  const okResp = await apiRequest(tenant.request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token: tenant.staffToken,
    data: { techCapabilities: exactlyFifty },
  })
  expect(
    okResp.status(),
    `PATCH with 50 elements should 200; got ${okResp.status()}`,
  ).toBe(200)
})

/**
 * Block 8 — RFP capabilities tightening (AC-VAL-3, M6).
 *
 * `rfpDraftBase.required_capabilities` now uses `openTagSlugArray` end-to-end.
 * Whitespace-only and oversized arrays are rejected; valid trimmed slugs pass.
 */
test('TC-PRM-OPEN-VOCAB-TAGS-001 — block 8: RFP required_capabilities tightened to openTagSlugArray', async ({
  tenant,
}) => {
  // Common valid RFP payload — we only vary `required_capabilities`.
  const baseRfp = {
    title: `Open-vocab RFP w${tenant.workerIndex}`,
    received_from: 'Acme Corp',
    received_at: '2026-05-11',
    description: 'desc body',
    tech_requirements: 'tech body',
    domain_requirements: 'domain body',
    eligibility_filter: 'all_active' as const,
  }

  // Whitespace-only element → reject.
  const whitespaceResp = await apiRequest(tenant.request, 'POST', '/api/prm/rfp', {
    token: tenant.staffToken,
    data: { ...baseRfp, required_capabilities: ['   '] },
  })
  expect(
    whitespaceResp.status(),
    `whitespace-only capability should 400; got ${whitespaceResp.status()}`,
  ).toBe(400)

  // Empty element → reject.
  const emptyResp = await apiRequest(tenant.request, 'POST', '/api/prm/rfp', {
    token: tenant.staffToken,
    data: { ...baseRfp, required_capabilities: [''] },
  })
  expect(emptyResp.status(), `empty capability should 400; got ${emptyResp.status()}`).toBe(400)

  // > 50 elements → reject.
  const tooMany = Array.from({ length: 51 }, (_, i) => `cap-${i}`)
  const overCapResp = await apiRequest(tenant.request, 'POST', '/api/prm/rfp', {
    token: tenant.staffToken,
    data: { ...baseRfp, required_capabilities: tooMany },
  })
  expect(
    overCapResp.status(),
    `51-element required_capabilities should 400; got ${overCapResp.status()}`,
  ).toBe(400)

  // Valid trimmed slugs → accept (201).
  const goodResp = await apiRequest(tenant.request, 'POST', '/api/prm/rfp', {
    token: tenant.staffToken,
    data: { ...baseRfp, required_capabilities: ['LangGraph', 'PyTorch'] },
  })
  expect(
    [200, 201].includes(goodResp.status()),
    `valid required_capabilities should 200/201; got ${goodResp.status()}`,
  ).toBeTruthy()
})

// ---------------------------------------------------------------------------
// Skipped blocks (NB2 — bootstrap-test-tenant.ts seeding bug).
//
// These three blocks exercise the PORTAL surface (partner_admin / partner_member
// auth via /api/prm/portal/...). The current fixture cannot seed PRM customer
// roles inside worker tenants — same root cause as TC-PRM-PORTAL-AGENCY-001 and
// siblings. Un-skip in one commit when the upstream fixture seeding fix lands.
// ---------------------------------------------------------------------------

const SKIP_REASON =
  // Keep this comment template identical to the existing TC-PRM-PORTAL-* skips so
  // the bulk un-skip (Search → Replace) lands in one diff.
  'bootstrap-test-tenant.ts does not seed PRM customer roles (partner_admin/partner_member). ' +
  'Un-skip when the upstream fixture fix lands.'

test.skip(
  `TC-PRM-OPEN-VOCAB-TAGS-001 — block 1: per-agency portal union [SKIPPED: ${SKIP_REASON}]`,
  async () => {
    // When un-skipped: as `partner_admin` of agency A with techCapabilities = ['React']
    // + a case study with technologiesUsed = ['LangGraph'], assert
    // GET /api/prm/portal/agency/A/tag-suggestions?field=technologies returns
    // items containing both 'LangGraph' and 'React'.
  },
)

test.skip(
  `TC-PRM-OPEN-VOCAB-TAGS-001 — block 2: cross-agency 404 via portal [SKIPPED: ${SKIP_REASON}]`,
  async () => {
    // When un-skipped: as `partner_admin` of agency B targeting the portal
    // suggestion endpoint for agency A's id, assert the response is 404
    // (matches the existing portal agency GET scope-guard discipline).
  },
)

test.skip(
  `TC-PRM-OPEN-VOCAB-TAGS-001 — block 4: portal cross-pollination via case-study save [SKIPPED: ${SKIP_REASON}]`,
  async () => {
    // When un-skipped: as `partner_admin` of agency A, POST a case study with
    // technologiesUsed = ['MLflow'] via the portal route. Then re-GET the per-
    // agency portal suggestion endpoint and assert items contain 'MLflow'.
  },
)
