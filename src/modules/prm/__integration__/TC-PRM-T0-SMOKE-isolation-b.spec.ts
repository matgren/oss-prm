/**
 * Sibling spec to `TC-PRM-T0-SMOKE-isolation.spec.ts` — see that file for
 * full rationale. The only differences are the slug prefix (`iso-b-`) and
 * the cross-leak detection regex (`iso-a-`), so when both run on different
 * Playwright workers under `--workers=2`, neither file's agency listing
 * should observe the other file's slug shape.
 */

import { test, expect } from './fixtures/tenantFixture'
import { createAgencyFixture } from '../testing/integration'

test('TC-PRM-T0-SMOKE-isolation [b] — created agency is visible only inside its own tenant', async ({ tenant }) => {
  const slug = `iso-b-${tenant.workerIndex}-${Date.now().toString(36)}`
  const agencyName = `Isolation Smoke B w${tenant.workerIndex}`

  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: agencyName,
    slug,
  })
  expect(agencyId, 'createAgencyFixture should return the new agency id').toBeTruthy()

  const listResponse = await tenant.request.get('/api/prm/agency?pageSize=200')
  expect(
    listResponse.ok(),
    `GET /api/prm/agency should be 200; got ${listResponse.status()}`,
  ).toBeTruthy()
  const body = (await listResponse.json()) as { items?: Array<{ id?: string; slug?: string }> }
  const items = Array.isArray(body.items) ? body.items : []

  expect(items.some((item) => item?.id === agencyId)).toBe(true)

  const leakage = items.find((item) => typeof item?.slug === 'string' && /^iso-a-\d+/.test(item.slug))
  expect(
    leakage,
    `Found cross-tenant leak from sibling worker: slug=${String(leakage?.slug)}`,
  ).toBeUndefined()
})
