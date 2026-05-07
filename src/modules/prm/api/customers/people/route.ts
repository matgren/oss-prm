// Stub for @open-mercato/cli integration-test readiness probe.
// See POST-MVP-FOLLOW-UPS.md "Drop customers core-module dependency from PRM standalone".
//
// The probe in `@open-mercato/cli/src/lib/testing/integration.ts` (function
// `probeAuthenticatedApi`) authenticates as admin@acme.com, then issues
// `GET /api/customers/people?pageSize=1` and waits for HTTP 200. The body is
// **not** inspected — only the status code matters. We still mirror the
// CRUD-factory paged-list response shape (`{ items, total, page, pageSize,
// totalPages }`) defensively so any downstream consumer that reads the body
// gets a well-formed empty page instead of `undefined`.
//
// TODO (shape-drift caveat): the response shape mirrors the
// @open-mercato/shared CRUD factory list payload as of @open-mercato/core 0.5.0.
// If a future core upgrade renames `total` / changes the pagination envelope,
// the probe stays green (it only checks status), but any consumer that imports
// from this stub by mistake will see drift. Re-verify on next core bump.
//
// SAFETY: this route MUST always return HTTP 200 for an authenticated principal.
// A 4xx/5xx here would block `mercato test:integration` from reaching ready.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'

const errorSchema = z.object({ ok: z.literal(false).optional(), error: z.string() })

const stubListResponseSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
})

/**
 * Auth gate: any authenticated principal is sufficient. The integration-test
 * probe logs in as `admin@acme.com` (which has `*` features) so feature gates
 * are not required here. We deliberately do NOT add `requireFeatures` so the
 * stub works even if the customers ACL feature catalogue is not loaded.
 *
 * Path override: `path` pins the registered route key to `/customers/people`
 * (the catch-all at `src/app/api/[...slug]/route.ts` strips the `/api/` prefix
 * before matching, so the manifest path uses the post-strip form). Without
 * this override, the module-registry generator
 * (`@open-mercato/cli` → generators/module-registry.ts → `reqSegs = [modId,
 * ...segs]`) would namespace the route under the PRM module id and register
 * it as `/prm/customers/people`, which the readiness probe (`GET /api/customers/people`)
 * never hits. `resolveApiPathFromMetadata` (same file) honors `metadata.path`
 * to override the module-prefix convention — the supported escape hatch.
 */
export const metadata = {
  path: '/customers/people',
  GET: { requireAuth: true },
}

/**
 * Mirrors the canonical probe URL `?pageSize=1`. We also accept `page` for
 * symmetry with the real customers route, even though the probe never sends it.
 */
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request) {
  // Defence-in-depth: the framework's catch-all route runs `requireAuth`
  // BEFORE invoking this handler, so unauthenticated calls never get here.
  // We still re-check so that direct invocation (e.g. unit tests calling the
  // exported `GET` directly) returns the expected 401 rather than fabricating
  // a 200.
  const auth = await getAuthFromRequest(req)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
  })
  // Even on a bad query, return 200 with a normalised empty page — the probe
  // contract is "any 200 with a list-shaped body". Throwing here would defeat
  // the purpose of the stub.
  const page = parsed.success ? parsed.data.page : 1
  const pageSize = parsed.success ? parsed.data.pageSize : 50

  return NextResponse.json({
    items: [],
    total: 0,
    page,
    pageSize,
    totalPages: 0,
  })
}

const getDoc: OpenApiMethodDoc = {
  summary: 'Customers people stub (integration-test readiness probe)',
  description:
    'PRM-owned stub of GET /api/customers/people that returns an empty paged list. Exists solely to satisfy the @open-mercato/cli `mercato test:integration` readiness probe without enabling the full @open-mercato/core/customers module. See POST-MVP-FOLLOW-UPS.md.',
  tags: ['PRM Internal'],
  responses: [
    {
      status: 200,
      description: 'Empty paged list (probe expects HTTP 200; body shape mirrors the CRUD-factory list envelope).',
      schema: stubListResponseSchema,
    },
  ],
  errors: [{ status: 401, description: 'Unauthenticated', schema: errorSchema }],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Customers people stub for integration-test readiness probe',
  description:
    'Stub route owned by PRM. Returns `{ items: [], total: 0, page, pageSize, totalPages: 0 }` for GET. Reads the canonical probe URL `?pageSize=1`. Replaces the dependency on `@open-mercato/core/customers` for the standalone PRM app.',
  methods: { GET: getDoc },
}
