import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Agency, ServiceIdempotencyKey } from '../data/entities'

let cachedSingletonContext: { tenantId: string; organizationId: string } | null = null

async function resolveSingletonTenantContext(
  em: EntityManager | undefined,
): Promise<{ tenantId: string; organizationId: string } | null> {
  if (cachedSingletonContext) return cachedSingletonContext
  if (!em) return null
  const first = await em.findOne(
    Agency,
    { deletedAt: null } as any,
    { orderBy: { createdAt: 'asc' } } as any,
  )
  if (!first) return null
  cachedSingletonContext = { tenantId: first.tenantId, organizationId: first.organizationId }
  return cachedSingletonContext
}

/** @internal Used only by tests that need to clear the cache between runs. */
export function _resetServiceAuthSingletonCache(): void {
  cachedSingletonContext = null
}

/**
 * Service-identity auth middleware for `/api/prm/service/wic/*` (Spec #4 §3.1).
 *
 * Adopts the SPEC-053b header contract verbatim (OQ-018 — no auth invented):
 *
 *   - `X-Om-Import-Secret`        — shared secret read from env. Required on GET + POST.
 *   - `X-Om-Request-Timestamp`    — RFC 3339 / ISO-8601 UTC. Must be within ±5min of server.
 *   - `X-Om-Idempotency-Key`      — UUIDv4 from caller. Required on POST only; ignored on GET.
 *
 * Decisions:
 *   - Middleware runs **before** Zod body validation so malformed auth is always 4xx auth
 *     (not 422). Spec §3.1 explicit.
 *   - Rotation overlap: env may set `OM_PRM_WIC_IMPORT_SECRET` AND `OM_PRM_WIC_IMPORT_SECRET_NEXT`;
 *     either being a timing-safe match passes auth.
 *   - Service identity is NOT a user. Returns a `ServiceIdentity` shape with `clientId`,
 *     `requestId`, `idempotencyKey?` — downstream handlers never see a `User`/`CustomerUser`.
 *   - Idempotency replay: on POST, the middleware looks up `(endpoint, idempotencyKey)` in
 *     `prm_service_idempotency_key`; same payload-hash → return cached response with
 *     `Idempotent-Replay: true` header (route handler is bypassed). Different hash → 409.
 *   - Tenant resolution for the idempotency row: spec §6.1 states the middleware resolves
 *     the singleton PRM tenant from config. v1 reads `OM_PRM_WIC_TENANT_ID` and
 *     `OM_PRM_WIC_ORG_ID` from env. Absence on POST blocks with 503; GET does not need
 *     tenant context (no idempotency persistence) so the values are optional for GET.
 */

export type ServiceIdentity = {
  clientId: 'n8n-wic'
  requestId: string
  idempotencyKey: string | null
  /** Resolved by middleware (env first, runtime fallback to first PRM Agency). Routes should use
   *  this rather than re-reading env so the singleton-tenant contract stays in one place. */
  tenantId: string | null
  organizationId: string | null
}

export type ServiceAuthOk = {
  ok: true
  identity: ServiceIdentity
  /** When the middleware needs to persist idempotency on the way out (POST only). */
  persistIdempotency:
    | null
    | ((args: {
        em: EntityManager
        responseStatus: number
        responseBody: unknown
      }) => Promise<void>)
}

export type ServiceAuthErr = {
  ok: false
  response: Response
}

export type ServiceAuthResult = ServiceAuthOk | ServiceAuthErr

const TIMESTAMP_SKEW_MS = 5 * 60 * 1000

const TIMESTAMP_HEADER = 'x-om-request-timestamp'
const SECRET_HEADER = 'x-om-import-secret'
const IDEMPOTENCY_HEADER = 'x-om-idempotency-key'

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status })
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

function readSecrets(): string[] {
  const primary = process.env.OM_PRM_WIC_IMPORT_SECRET
  const next = process.env.OM_PRM_WIC_IMPORT_SECRET_NEXT
  return [primary, next].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function parseTimestamp(raw: string): { ok: true; date: Date } | { ok: false; reason: string } {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return { ok: false, reason: 'invalid_format' }
  }
  return { ok: true, date }
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function canonicalizeBodyForHash(body: string): string {
  // For now, hash the raw body. JSON canonicalization (sorted keys) is overkill for the
  // n8n caller, which always sends the same serialized shape per request. If a caller
  // ever resends the same payload with different key ordering we will accept the 409;
  // the practical contract is "byte-identical retry succeeds."
  return body
}

export function hashPayload(body: string): string {
  return createHash('sha256').update(canonicalizeBodyForHash(body), 'utf8').digest('hex')
}

export type ServiceAuthOptions = {
  /** Stable label for the endpoint, used as the idempotency-row key. e.g. 'POST /api/prm/service/wic/imports'. */
  endpoint: string
  /** Caller-provided EntityManager for idempotency lookup. Required on POST. */
  em?: EntityManager
  /**
   * Pre-read request body string. Required on POST so the same body that's about to be
   * deserialized is also the one whose hash we compare. Caller is responsible for reading
   * via `req.text()` and passing it here AND to JSON.parse downstream.
   */
  bodyText?: string
  /** Override clock for tests. */
  now?: () => Date
}

/**
 * Authenticate a service request. Returns `ok: true` with the resolved identity on success
 * (and an idempotency-persist callback for POST requests when no replay matches), or
 * `ok: false` with a pre-formed `Response` on failure.
 *
 * Caller responsibility on POST:
 *   - Pass `em` and `bodyText`.
 *   - When the route handler completes, call `result.persistIdempotency!({ em, responseStatus, responseBody })`
 *     with the final response so retries replay verbatim.
 */
export async function authenticateServiceRequest(
  req: Request,
  options: ServiceAuthOptions,
): Promise<ServiceAuthResult> {
  const headers = req.headers
  const method = req.method.toUpperCase()
  const isPost = method === 'POST'
  const now = (options.now ?? (() => new Date()))()

  const secret = headers.get(SECRET_HEADER)
  if (!secret) {
    return { ok: false, response: jsonResponse(401, { ok: false, error: 'Missing X-Om-Import-Secret' }) }
  }

  const expectedSecrets = readSecrets()
  if (expectedSecrets.length === 0) {
    return {
      ok: false,
      response: jsonResponse(503, { ok: false, error: 'WIC import secret not configured' }),
    }
  }
  const secretMatches = expectedSecrets.some((candidate) => timingSafeStringEqual(secret, candidate))
  if (!secretMatches) {
    return { ok: false, response: jsonResponse(401, { ok: false, error: 'Invalid X-Om-Import-Secret' }) }
  }

  const timestampRaw = headers.get(TIMESTAMP_HEADER)
  if (!timestampRaw) {
    return {
      ok: false,
      response: jsonResponse(400, { ok: false, error: 'Missing X-Om-Request-Timestamp' }),
    }
  }
  const ts = parseTimestamp(timestampRaw)
  if (!ts.ok) {
    return {
      ok: false,
      response: jsonResponse(400, { ok: false, error: 'Invalid X-Om-Request-Timestamp format' }),
    }
  }
  const skew = Math.abs(now.getTime() - ts.date.getTime())
  if (skew > TIMESTAMP_SKEW_MS) {
    return {
      ok: false,
      response: jsonResponse(408, {
        ok: false,
        error: 'X-Om-Request-Timestamp outside ±5min window',
        skew_ms: skew,
      }),
    }
  }

  let idempotencyKey: string | null = null
  if (isPost) {
    const raw = headers.get(IDEMPOTENCY_HEADER)
    if (!raw) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: 'Missing X-Om-Idempotency-Key (required on POST)',
        }),
      }
    }
    if (!isUuidV4(raw)) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: 'X-Om-Idempotency-Key must be a UUIDv4',
        }),
      }
    }
    idempotencyKey = raw
  }
  // GET: header is ignored if present.

  const requestId = headers.get('x-om-request-id') ?? crypto.randomUUID()
  // Resolve tenant context up-front so both GET and POST routes can read it from `identity`
  // without re-implementing the env-vs-fallback fork. For POST it's also used for the
  // idempotency persist below.
  let tenantId = process.env.OM_PRM_WIC_TENANT_ID ?? null
  let organizationId = process.env.OM_PRM_WIC_ORG_ID ?? null
  if ((!tenantId || !organizationId) && options.em) {
    const fallback = await resolveSingletonTenantContext(options.em)
    if (fallback) {
      tenantId = fallback.tenantId
      organizationId = fallback.organizationId
    }
  }

  const identity: ServiceIdentity = {
    clientId: 'n8n-wic',
    requestId,
    idempotencyKey,
    tenantId,
    organizationId,
  }

  // POST: idempotency lookup
  if (isPost && idempotencyKey) {
    if (!options.em) {
      return {
        ok: false,
        response: jsonResponse(500, {
          ok: false,
          error: 'Server config: EntityManager required for POST idempotency lookup',
        }),
      }
    }
    if (typeof options.bodyText !== 'string') {
      return {
        ok: false,
        response: jsonResponse(500, {
          ok: false,
          error: 'Server config: body required for POST idempotency hash',
        }),
      }
    }
    if (!tenantId || !organizationId) {
      return {
        ok: false,
        response: jsonResponse(503, {
          ok: false,
          error:
            'WIC tenant context not configured (set OM_PRM_WIC_TENANT_ID + OM_PRM_WIC_ORG_ID, or seed at least one PRM Agency)',
        }),
      }
    }

    const payloadHash = hashPayload(options.bodyText)

    const existing = await options.em.findOne(ServiceIdempotencyKey, {
      endpoint: options.endpoint,
      idempotencyKey,
    })
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return {
          ok: false,
          response: jsonResponse(409, {
            ok: false,
            error: 'Idempotency-Key reused with a different payload',
            original: {
              created_at: existing.createdAt,
            },
          }),
        }
      }
      // Same key, same payload → replay verbatim.
      const replay = NextResponse.json(existing.responseBody, { status: existing.responseStatus })
      replay.headers.set('Idempotent-Replay', 'true')
      return { ok: false, response: replay }
    }

    const persistIdempotency: ServiceAuthOk['persistIdempotency'] = async ({
      em,
      responseStatus,
      responseBody,
    }) => {
      // Idempotency rows are write-once at first commit. Re-runs that hit this path mean
      // a parallel POST won the race; the second writer's INSERT will collide on the PK
      // and the route can fall back to a re-read. We rely on the unique PK constraint to
      // serialize, so a swallowed conflict here is correct (the replay path on the next
      // retry will return the winning response).
      try {
        const responseHash = hashPayload(JSON.stringify(responseBody))
        const row = em.create(ServiceIdempotencyKey, {
          endpoint: options.endpoint,
          idempotencyKey,
          tenantId,
          organizationId,
          payloadHash,
          responseHash,
          responseStatus,
          responseBody: responseBody as Record<string, unknown>,
          createdAt: new Date(),
        } as any)
        em.persist(row)
        await em.flush()
      } catch {
        // Conflict on (endpoint, idempotencyKey) PK — another writer beat us. The retry
        // will see their row and replay. Acceptable.
      }
    }

    return { ok: true, identity, persistIdempotency }
  }

  return { ok: true, identity, persistIdempotency: null }
}
