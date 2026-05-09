/**
 * WIC ingestion test fixtures (T3 — Spec #4 §3.3).
 *
 * The WIC ingestion endpoint (`POST /api/prm/service/wic/imports/{batchId}`)
 * uses **service-identity auth** — not staff JWT — and requires three custom
 * headers per the SPEC-053b contract verbatim:
 *
 *   - `X-Om-Import-Secret`        — shared secret (env: `OM_PRM_WIC_IMPORT_SECRET`)
 *   - `X-Om-Request-Timestamp`    — RFC 3339 / ISO-8601 UTC, ±5min tolerance
 *   - `X-Om-Idempotency-Key`      — UUIDv4 from caller (POST only)
 *
 * Tenant resolution is env-first (`OM_PRM_WIC_TENANT_ID` /
 * `OM_PRM_WIC_ORG_ID`), with a fallback to the first PRM Agency's tenant in
 * DB. Under tenant-per-worker the env vars are the cleanest path — set them
 * BEFORE invoking the helper, scoped to the spec body.
 *
 * Helpers are header/body builders, not transport — the spec composes them
 * with the tenant-fixture's `request` to keep parity with the rest of the
 * helper surface (`(request, headers, batchId, body)` shape).
 */

import { randomUUID } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/testing/integration'

const BASE_URL = process.env.BASE_URL?.trim() || null

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

export type WicImportRowInput = {
  row_index: number
  github_profile: string
  person_display_name?: string | null
  /** YYYY-MM-DD; must be the first day of the month per `isFirstOfMonth`. */
  contribution_month: string
  wic_level: string
  wic_score: number
  contribution_count?: number
  bounty_bonus?: number
  why_bonus?: string | null
  what_included?: string | null
  what_excluded?: string | null
  /** ISO-8601 with offset; default = now. */
  computed_at?: string
}

export type WicImportEnvelopeInput = {
  /** YYYY-MM, must match each row's `contribution_month` first-of-month rule. */
  month: string
  script_version?: string
  rows: WicImportRowInput[]
}

export type WicServiceHeaders = {
  'X-Om-Import-Secret': string
  'X-Om-Request-Timestamp': string
  'X-Om-Idempotency-Key': string
  'Content-Type': string
}

/**
 * Build the canonical WIC service-identity header set for a POST.
 *
 * `secret` is required — pass the value from `process.env.OM_PRM_WIC_IMPORT_SECRET`
 * or whatever the spec read from env. Returning a typed object (not just an
 * empty stub) keeps the failure mode obvious if the env wasn't set.
 *
 * `idempotencyKey` defaults to a fresh UUIDv4. Pass an explicit one to drive
 * idempotent-replay tests (same key + same body → cached response).
 */
export function buildWicServiceHeaders(input: {
  secret: string
  idempotencyKey?: string
  /** Defaults to `new Date().toISOString()`. */
  timestamp?: string
}): WicServiceHeaders {
  if (!input.secret || input.secret.length === 0) {
    throw new Error(
      'buildWicServiceHeaders: secret is required (set OM_PRM_WIC_IMPORT_SECRET in your test env)',
    )
  }
  return {
    'X-Om-Import-Secret': input.secret,
    'X-Om-Request-Timestamp': input.timestamp ?? new Date().toISOString(),
    'X-Om-Idempotency-Key': input.idempotencyKey ?? randomUUID(),
    'Content-Type': 'application/json',
  }
}

/**
 * Build a minimal valid WIC import envelope. Defaults `script_version` and
 * fills `computed_at` per row — keeps spec bodies focused on the variation
 * they're testing (level, score, etc.).
 */
export function buildWicImportEnvelope(input: WicImportEnvelopeInput): {
  script_version: string
  month: string
  rows: WicImportRowInput[]
} {
  const nowIso = new Date().toISOString()
  return {
    script_version: input.script_version ?? 'pw-test-1.0.0',
    month: input.month,
    rows: input.rows.map((row, index) => ({
      contribution_count: 0,
      bounty_bonus: 0,
      ...row,
      row_index: row.row_index ?? index,
      computed_at: row.computed_at ?? nowIso,
    })),
  }
}

/**
 * POST a WIC import batch via the real production route. Returns the
 * response status + parsed body so callers can assert per-row outcomes.
 *
 * `batchId` MUST be a UUIDv4. The handler enforces this at the path level
 * (400 otherwise).
 */
export async function postWicImportFixture(
  request: APIRequestContext,
  headers: WicServiceHeaders,
  batchId: string,
  body: ReturnType<typeof buildWicImportEnvelope>,
): Promise<{ status: number; body: unknown; response: APIResponse }> {
  const response = await request.fetch(
    resolveUrl(`/api/prm/service/wic/imports/${batchId}`),
    {
      method: 'POST',
      headers,
      data: body,
    },
  )
  const json = await readJsonSafe<unknown>(response)
  return { status: response.status(), body: json, response }
}
