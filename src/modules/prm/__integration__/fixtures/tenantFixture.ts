/**
 * Worker-scoped Playwright fixture that bootstraps a fresh tenant per worker.
 *
 * SPEC-2026-05-09b Phase 1, Option B (interim local script).
 *
 * Each Playwright worker gets:
 * - A new Tenant + Organization + admin User (provisioned by
 *   `scripts/bootstrap-test-tenant.ts`, which wraps `setupInitialTenant` from
 *   compiled `@open-mercato/core` in a clean Node subprocess).
 * - A JWT token for that admin (acquired via real `POST /api/auth/login`).
 * - An `APIRequestContext` pre-authenticated as that admin (`Authorization:
 *   Bearer <token>` header set on every request).
 *
 * Tenant rows are minted once per worker (`scope: 'worker'`) and reused
 * across all specs that worker runs. Teardown is intentionally a no-op:
 * `mercato test:integration` drops the entire ephemeral DB at suite end, so
 * per-tenant cleanup adds latency without benefit.
 *
 * Cross-spec isolation is structural — different `tenant_id` values in every
 * row mean specs in worker N literally cannot see data from worker M. This
 * removes the pressure for any inter-spec cleanup seam (the failure mode of
 * the predecessor SPEC-2026-05-09 + the deleted `OM_PRM_TEST_FIXTURES_ENABLED`
 * routes).
 *
 * Imports allowlist (per discipline rule §1):
 * - `@playwright/test`
 * - `@open-mercato/core/helpers/integration/*`
 * - `node:*` built-ins
 *
 * Spec usage:
 *   import { test, expect } from './fixtures/tenantFixture'
 *   test('TC-PRM-T0-001', async ({ tenant }) => {
 *     // tenant.request, tenant.staffToken, tenant.tenantId, tenant.organizationId
 *   })
 *
 * The fixture deliberately does NOT import from "@/modules/<m>/lib/*",
 * "@/modules/<m>/data/*", or any production internal — those carry MikroORM
 * decorators that Playwright's loader rejects (microsoft/playwright#29646).
 * The bootstrap script + HTTP routes are the only allowed channels into
 * production behavior.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  test as base,
  type APIRequestContext,
  type WorkerInfo,
} from '@playwright/test'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

// Locate the bootstrap script relative to this file. Going up six segments
// from `src/modules/prm/__integration__/fixtures/tenantFixture.ts` lands on
// the app root; appending `scripts/bootstrap-test-tenant.ts` is the canonical
// path. We hardcode the relative offset because `process.cwd()` under
// Playwright varies depending on whether tests are invoked from the app root
// or from `mercato test:integration`.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = path.join(APP_ROOT, 'scripts', 'bootstrap-test-tenant.ts')

export type PrmTenant = {
  tenantId: string
  organizationId: string
  adminEmail: string
  adminPassword: string
  orgSlug: string
  staffToken: string
  /** APIRequestContext pre-authenticated as the tenant's admin user. */
  request: APIRequestContext
  /** The Playwright worker index that minted this tenant — useful for log correlation. */
  workerIndex: number
}

type BootstrapPayload = {
  tenantId: string
  organizationId: string
  adminEmail: string
  adminPassword: string
  orgSlug: string
}

function randomSuffix(): string {
  // 8 base36 chars ≈ 41 bits of entropy — enough to avoid collisions across
  // workers within a single ephemeral test run.
  return Math.random().toString(36).slice(2, 10)
}

function buildBootstrapArgs(workerIndex: number): {
  slug: string
  adminEmail: string
  orgName: string
  password: string
} {
  const stamp = Date.now().toString(36)
  const suffix = randomSuffix()
  // Use only digits, lowercase letters, and hyphens — keeps values safe to
  // pass as CLI args without quoting and recognizable in logs.
  const slug = `pw-w${workerIndex}-${stamp}-${suffix}`
  // The admin email is the load-bearing uniqueness key inside
  // `setupInitialTenant`. Anything that would let two workers collide here
  // — like reusing `superadmin@acme.com` — would degrade the fixture into
  // shared-tenant mode (the failure pattern this whole spec exists to fix).
  const adminEmail = `${slug}-admin@pw.test`
  const orgName = `PW Tenant w${workerIndex}-${stamp}`
  return { slug, adminEmail, orgName, password: 'secret' }
}

async function spawnBootstrap(args: ReturnType<typeof buildBootstrapArgs>): Promise<BootstrapPayload> {
  return new Promise<BootstrapPayload>((resolve, reject) => {
    // `tsx` is in devDependencies — invoke via the local node_modules .bin.
    // We use absolute paths everywhere so the subprocess is independent of
    // whatever cwd Playwright is running from.
    const tsxBin = path.join(APP_ROOT, 'node_modules', '.bin', 'tsx')
    const child = spawn(
      tsxBin,
      [
        BOOTSTRAP_SCRIPT,
        `--slug=${args.slug}`,
        `--admin-email=${args.adminEmail}`,
        `--org-name=${args.orgName}`,
        `--password=${args.password}`,
      ],
      {
        cwd: APP_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `bootstrap-test-tenant.ts exited with code ${code}. stderr=${stderr.trim() || '<empty>'} stdout=${stdout.trim() || '<empty>'}`,
          ),
        )
        return
      }
      // The script prints exactly one JSON line to stdout. Other lines (if
      // any leak through, e.g. esbuild warnings) are ignored — pick the last
      // non-empty line that parses as JSON.
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]) as BootstrapPayload & { error?: string }
          if (parsed.error) {
            reject(new Error(`bootstrap-test-tenant.ts reported error: ${parsed.error}`))
            return
          }
          if (parsed.tenantId && parsed.organizationId && parsed.adminEmail) {
            resolve({
              tenantId: parsed.tenantId,
              organizationId: parsed.organizationId,
              adminEmail: parsed.adminEmail,
              adminPassword: parsed.adminPassword,
              orgSlug: parsed.orgSlug,
            })
            return
          }
        } catch {
          // not JSON — keep scanning
        }
      }
      reject(
        new Error(
          `bootstrap-test-tenant.ts exited 0 but produced no parseable JSON. stdout=${stdout.trim() || '<empty>'} stderr=${stderr.trim() || '<empty>'}`,
        ),
      )
    })
  })
}

async function loginAsTenantAdmin(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const form = new URLSearchParams()
  form.set('email', email)
  form.set('password', password)
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: form.toString(),
  })
  if (!response.ok()) {
    const body = await response.text().catch(() => '<unreadable>')
    throw new Error(
      `Tenant admin login failed (${response.status()}) for ${email}: ${body}`,
    )
  }
  const json = (await response.json().catch(() => ({}))) as { token?: unknown }
  if (typeof json.token !== 'string' || !json.token) {
    throw new Error(`Tenant admin login response missing token for ${email}`)
  }
  return json.token
}

async function provisionTenant(
  playwright: typeof import('@playwright/test').test.info extends () => infer _ ? unknown : unknown,
  workerInfo: WorkerInfo,
): Promise<PrmTenant> {
  // Defensive: explicit type, since the playwright fixture-arg type widens
  // through generics. The .request factory is the supported public surface.
  const pw = playwright as unknown as {
    request: { newContext(opts?: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }): Promise<APIRequestContext> }
  }
  const args = buildBootstrapArgs(workerInfo.workerIndex)
  const payload = await spawnBootstrap(args)

  // First, login as the new tenant admin using a bare (unauthenticated)
  // request context.
  const loginContext = await pw.request.newContext({ baseURL: BASE_URL })
  let token: string
  try {
    token = await loginAsTenantAdmin(loginContext, payload.adminEmail, payload.adminPassword)
  } finally {
    await loginContext.dispose()
  }

  // Then build a long-lived authenticated context for the spec body.
  const tenantRequest = await pw.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
    },
  })

  return {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    adminEmail: payload.adminEmail,
    adminPassword: payload.adminPassword,
    orgSlug: payload.orgSlug,
    staffToken: token,
    request: tenantRequest,
    workerIndex: workerInfo.workerIndex,
  }
}

export const test = base.extend<{}, { tenant: PrmTenant }>({
  tenant: [
    async ({ playwright }, use, workerInfo) => {
      const tenant = await provisionTenant(playwright, workerInfo)
      try {
        await use(tenant)
      } finally {
        // Teardown: dispose the request context. The DB rows are NOT cleaned
        // up here — `mercato test:integration` drops the ephemeral DB at
        // suite end, which is faster than per-tenant cleanup and avoids any
        // inter-spec cleanup discipline.
        await tenant.request.dispose().catch(() => {})
      }
    },
    { scope: 'worker' },
  ],
})

export { expect } from '@playwright/test'
