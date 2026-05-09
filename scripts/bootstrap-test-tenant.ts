#!/usr/bin/env tsx
/**
 * Bootstrap a fresh tenant for Playwright integration tests.
 *
 * SPEC-2026-05-09b Phase 1, Option B (interim local script).
 *
 * Wraps the upstream `setupInitialTenant` helper from compiled
 * `@open-mercato/core/dist/modules/auth/lib/setup-app.js` and exposes it as a
 * standalone Node CLI invoked once per Playwright worker by `tenantFixture`
 * via `child_process`. The subprocess boundary is essential: it keeps the
 * MikroORM entity-class loading (with stage-1 decorators) OUT of the
 * Playwright runner process, sidestepping microsoft/playwright#29646 — the
 * exact failure mode that abandoned the predecessor SPEC-2026-05-09.
 *
 * The CLI surface intentionally mirrors the future
 * `mercato test:bootstrap-tenant` subcommand (SPEC-2026-05-09d, upstream PR in
 * review). Once that subcommand merges + this app bumps `@open-mercato/core`,
 * the fixture can swap `node tsx scripts/bootstrap-test-tenant.ts ...` for
 * `mercato test:bootstrap-tenant ...` as a one-line change. Until then this
 * script is the supported path.
 *
 * USAGE:
 *   tsx scripts/bootstrap-test-tenant.ts \
 *     --slug=pw-abc123 \
 *     --admin-email=pw-w0-1700000000@acme.test \
 *     --org-name="Pw Tenant w0" \
 *     [--password=secret]
 *
 * STDOUT (success):
 *   {"tenantId":"...","organizationId":"...","adminEmail":"...","adminPassword":"..."}
 *
 * STDERR (failure):
 *   {"error":"<message>"}
 *
 * The script prints exactly ONE line of JSON to stdout on success, with no
 * other chatter — `setupInitialTenant`'s informational `console.log` calls are
 * suppressed by setting `NODE_ENV=test` for the lifetime of this process
 * (mirrors the convention that the upstream CLI helper itself uses at
 * `node_modules/@open-mercato/core/dist/modules/auth/cli.js:402`).
 */

import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Load env from .env at the app root (same convention as `mercato init`).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
loadDotenv({ path: path.join(appRoot, '.env') })

if (!process.env.DATABASE_URL) {
  process.stderr.write(
    JSON.stringify({
      error: 'DATABASE_URL is not set. Bootstrap-test-tenant requires a configured database (typically the ephemeral testcontainers DB started by `mercato test:integration`).',
    }) + '\n',
  )
  process.exit(1)
}

// Suppress `setupInitialTenant`'s informational console.log — the upstream
// helper at @open-mercato/core/dist/modules/auth/cli.js:402 uses the same
// gate. Cast to `Record<string,string>` because the @types/node augmentation
// declares `NODE_ENV` as readonly; we only mutate it in this child process.
if (!process.env.NODE_ENV) {
  ;(process.env as Record<string, string>).NODE_ENV = 'test'
}

type ParsedArgs = {
  slug: string
  adminEmail: string
  orgName: string
  password: string
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const map = new Map<string, string>()
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    if (eq === -1) {
      map.set(raw.slice(2), 'true')
    } else {
      map.set(raw.slice(2, eq), raw.slice(eq + 1))
    }
  }
  const slug = map.get('slug')
  const adminEmail = map.get('admin-email')
  const orgName = map.get('org-name')
  const password = map.get('password') ?? 'secret'
  if (!slug || !adminEmail || !orgName) {
    throw new Error(
      'Usage: tsx scripts/bootstrap-test-tenant.ts --slug=<slug> --admin-email=<email> --org-name=<name> [--password=<pw>]',
    )
  }
  return { slug, adminEmail, orgName, password }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Dynamic imports — keep the heavy MikroORM dependencies behind a lazy
  // boundary so a failed `--help` invocation (or a missing dependency) prints
  // the CLI usage message instead of a stack trace from container init.
  const { createRequestContainer } = await import(
    '@open-mercato/shared/lib/di/container'
  )
  const { setupInitialTenant } = await import(
    '@open-mercato/core/modules/auth/lib/setup-app'
  )
  const { getCliModules } = await import('@open-mercato/shared/modules/registry')

  const { resolve } = await createRequestContainer()
  const em = resolve('em') as import('@mikro-orm/postgresql').EntityManager

  // setupInitialTenant only enforces uniqueness on the primary user's email
  // (`findOneWithDecryption(em, User, { email: mainEmail }, ...)` at
  // `@open-mercato/core/src/modules/auth/lib/setup-app.ts:129`). The
  // `--admin-email` arg is the load-bearing uniqueness key — callers must
  // make it unique per worker (`pw-w<workerIndex>-<timestamp>@acme.test` is
  // the recommended shape). The `--slug` arg is informational/diagnostic for
  // log correlation; org names need not be unique at the DB level.
  const result = await setupInitialTenant(em, {
    orgName: args.orgName,
    primaryUser: {
      email: args.adminEmail,
      password: args.password,
      confirm: true,
    },
    // We do not want the derived admin@acme.com / employee@acme.com users —
    // those collide across workers and serve no purpose for per-worker
    // tenants. Each tenant gets exactly one admin, the one we name in
    // `--admin-email`.
    includeDerivedUsers: false,
    failIfUserExists: true,
    primaryUserRoles: ['admin', 'superadmin'],
    includeSuperadminRole: true,
    modules: getCliModules(),
  })

  // Single line of JSON to stdout — the parent process consumes this as the
  // fixture's source of truth. Anything else (errors, warnings) goes to
  // stderr.
  const payload = {
    tenantId: result.tenantId,
    organizationId: result.organizationId,
    adminEmail: args.adminEmail,
    adminPassword: args.password,
    orgSlug: args.slug,
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(JSON.stringify({ error: message }) + '\n')
  process.exit(1)
})
