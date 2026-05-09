/**
 * TC-PRM-T3-001 — WIC ingestion happy path (Spec #4 §3.3).
 *
 * STATUS: SCAFFOLDED + SKIPPED — see "Why skipped" below.
 *
 * Coverage shape (when unblocked):
 *   - Build WIC service-identity headers from env + builders.
 *   - Build a minimal valid envelope with one accepted row.
 *   - Real `POST /api/prm/service/wic/imports/{batchId}`.
 *   - Assert 200 with all rows in `accepted` status.
 *
 * Why skipped:
 *   The WIC service route's tenant resolution (Spec #4 §6.1) is env-first
 *   (`OM_PRM_WIC_TENANT_ID` + `OM_PRM_WIC_ORG_ID`) with a runtime fallback to
 *   the "first PRM Agency in DB" — and that fallback explicitly fail-closes
 *   when more than one Agency tenant exists (`serviceAuthMiddleware.ts:49`).
 *
 *   Under tenant-per-worker (Phase 5: `--workers=4`), every worker mints a
 *   separate tenant + seeds agencies in it. After the second worker's
 *   bootstrap, the WIC fallback sees N>1 tenants and fail-closes — there's
 *   no way for this spec to pick "its own" tenant short of either:
 *     (a) per-worker env vars on the APP server process (impossible: the
 *         app is a single shared process across all workers), or
 *     (b) a request-header tenant override on the service route (would be
 *         an upstream PRM API change — out of scope for this rebuild).
 *
 *   The clean unblock is option (b) as a v2 follow-up. Until then, WIC
 *   ingestion can only be exercised against a single-tenant ephemeral DB,
 *   which would need a separate `--workers=1` Playwright project — adding
 *   that infrastructure exceeds the scope of this rebuild.
 *
 *   The fixture surface (`buildWicServiceHeaders`, `buildWicImportEnvelope`,
 *   `postWicImportFixture`) is built and tested via composition in this
 *   skipped scaffold so the spec is one `test.skip → test` swap away from
 *   running once the upstream tenant-override lands.
 */

import { test, expect } from './fixtures/tenantFixture'
import {
  buildWicImportEnvelope,
  buildWicServiceHeaders,
  postWicImportFixture,
} from '../testing/integration'
import { randomUUID } from 'node:crypto'

test.skip('TC-PRM-T3-001 — WIC service-identity ingestion accepts a one-row batch', async ({ tenant }) => {
  const secret = process.env.OM_PRM_WIC_IMPORT_SECRET
  expect(
    secret,
    'OM_PRM_WIC_IMPORT_SECRET must be set in the test environment (see .env.example).',
  ).toBeTruthy()

  const headers = buildWicServiceHeaders({ secret: secret! })
  const envelope = buildWicImportEnvelope({
    month: '2026-04',
    rows: [
      {
        row_index: 0,
        github_profile: `pw-w${tenant.workerIndex}-${Date.now().toString(36)}`,
        contribution_month: '2026-04-01',
        wic_level: 'L1',
        wic_score: 5,
        contribution_count: 3,
      },
    ],
  })

  const result = await postWicImportFixture(tenant.request, headers, randomUUID(), envelope)

  expect(
    result.status,
    `POST /api/prm/service/wic/imports should return 200; got ${result.status} body=${JSON.stringify(result.body)}`,
  ).toBe(200)
})
