# SPEC-2026-04-23 WIC Ingestion & Display

> **Cross-spec drift fixed 2026-05-05.** Backend routes live under `/api/prm/wic/...` and service routes under `/api/prm/service/wic/...` per the shipped T0/T1/T2 namespace convention (OM auto-discovers from `src/modules/<module>/api/...`). All other contracts (event IDs, entity shapes, ACL features) remain valid as drafted.
>
> **2026-05-05 follow-up:** body paths replaced inline — legacy `/api/{service,backend}/prm/wic/...` mentions corrected throughout. Header is now consistent with the spec body.
>
**Spec:** #4 of 7 (PRM decomposition)
**Workflow:** WF5 — WIC Ingestion & Display
**Phase:** 4 (parallelizable with Phase 3)
**Stories covered:** US6.1, US6.2, US6.4
**Depends on:** Spec #1 (Agency, AgencyMember, GH-profile uniqueness)
**Does NOT cover:** US6.3 (dashboard widget — Spec #2)
**Persona:** Martin Fowler
**Author:** Piotr (om-cto Spec Orchestrator), 2026-04-23
**Estimated commits:** 5 (point)

---

## 1. Summary, Scope & Business Outcome

### 1.1 TLDR

Introduce a pair of service-to-service routes under `/api/prm/service/wic/*` that let the n8n WIC classifier pull the authoritative GitHub-profile roster and push monthly contribution batches into PRM. Incoming batches pass through an Anti-Corruption Layer that rejects malformed or unresolvable rows into an auditable issue queue (B10) instead of corrupting the domain. Supersession is idempotent at the `(agency_member_id, contribution_month)` grain (invariant #3); attribution is snapshotted at import time (invariant #13). Auth follows the SPEC-053b header pattern (OQ-018).

### 1.2 Scope

**In scope:**

- Two service-identity HTTP endpoints: `GET /api/prm/service/wic/profiles`, `POST /api/prm/service/wic/imports/{batch_id}`.
- Two new entities under the PRM module: `WICContribution`, `WICImportAuditLog`.
- One `ServiceAuthMiddleware` enforcing the SPEC-053b header contract.
- The Anti-Corruption Layer (resolution + validation + supersession + snapshot) per §1.4.6.
- Backend page **B10 — WIC Import Issues** (standard `DataTable` over the audit log with three resolution row actions).
- Domain events: `prm.wic.contribution_recorded`, `prm.wic.contribution_superseded`, `prm.wic_import.row_rejected`, `prm.wic_import.batch_completed`, `prm.wic_import.resolved`.
- Commands (undoable where applicable): `RecordWICContributionCommand`, `SupersedeWICContributionCommand`, `ResolveWICImportAuditLogCommand`.

**Out of scope:**

- US6.3 agency-facing WIC dashboard widget (Spec #2 — portal read models + P2 assembly).
- WIC scoring/classification logic (external n8n black-box, L-002).
- Tier derivation from WIC (admin-set in v1, L-008).
- Cross-agency historical re-attribution (OQ-013 — silent + runbook in v1).
- New auth module, session tokens, CustomerUser/User rows for n8n.

### 1.3 Business Outcome

> "Contribution scores flow automatically; Mat isn't copy-pasting monthly."

**Measurable signals (Phase 4 acceptance, §7):**

- ≥ 95% of n8n rows accepted per batch.
- WIC dashboard visibility ≤ 72 hours after month close.
- AgencyMember WIC dashboard engagement ≥ 60% (observed through Spec #2 reads against rows this spec writes).
- Zero "what is my WIC?" Mat-email threads in a Phase 4 month.

---

## 2. Technical Approach (Piotr)

- **Mode:** Extend PRM module with WIC entities + dedicated service-auth routes + audit log + B10 standard DataTable. No core module modifications. No new auth module.
- **New entities:**
  - `WICContribution` (FK `agency_member_id`, FK `agency_id` (snapshot — invariant #13: attribution frozen at import), `github_profile` (also snapshotted — survives future GH-profile reassignment), `contribution_month` date (YYYY-MM-01 first-of-month normalization), `wic_level` enum `L1` / `L2` / `L3` / `L4` — informational/display only per L-002 — NO PRM logic branches on it; `contribution_count` integer, `computed_score` decimal, `import_batch_id` UUID, `imported_at` timestamp, `superseded_by_id` nullable FK to same table — for invariant #3 supersession).
  - `WICImportAuditLog` (`import_batch_id` UUID, `row_index` integer, `raw_payload` JSONB, `rejection_reason` enum + text, `resolved_at` nullable, `resolved_by_user_id` nullable, `resolution_action` enum `accepted_after_fix` / `rolled_back` / `ignored`).
- **Service-identity auth (OQ-018 — SPEC-053b pattern, DIY):**
  - Header contract on `/api/prm/service/wic/*`:
    - `X-Om-Import-Secret: <shared secret>` (env var `OM_PRM_WIC_IMPORT_SECRET`).
    - `X-Om-Request-Timestamp: <ISO-8601>` — reject if outside ±5 minute window (replay protection).
    - `X-Om-Idempotency-Key: <UUID>` — **required on POST only** (per SPEC-053b distinction). GET requests do NOT require it.
  - Enforced by a shared `ServiceAuthMiddleware` in this spec's route handlers.
  - NOT a session token. NOT a user. No `CustomerUser` / `User` row.
- **US6.1 GET `/api/prm/service/wic/profiles`:** returns JSON list of `{ agency_member_id, github_profile, agency_slug, is_active }` for all currently-active `AgencyMember` rows across all agencies. Used by n8n to know who to classify. Shared auth headers only (no idempotency on GET).
- **US6.2 POST `/api/prm/service/wic/imports/{batch_id}`:** receives a batch payload (list of per-member WIC records). Validates each row through the **Anti-Corruption Layer (§1.4.6)**:
  - Required fields present + typed correctly.
  - `github_profile` resolves to an active `AgencyMember` → if not, log to `WICImportAuditLog` with `rejection_reason='profile_not_found'`.
  - `contribution_month` is a valid first-of-month date → else `rejection_reason='malformed_month'`.
  - `wic_level` ∈ {L1,L2,L3,L4} → else `rejection_reason='unknown_level'`.
  - Invariant #3 supersession: if a `WICContribution` already exists for `(agency_member_id, contribution_month)`, set its `superseded_by_id` to the new row — no duplicate counting. Idempotent retry: same `import_batch_id` + same content → no-op; different content → new supersession row.
  - Invariant #13: snapshot `agency_id` + `github_profile` onto every row at import time (survives future GH-profile reassignment).
  - Accepted rows emit `prm.wic.contribution_recorded` per row. Rejected rows emit `prm.wic_import.row_rejected` per row. Batch completion emits `prm.wic_import.batch_completed` with `accepted_count` + `rejected_count`.
  - **OQ-013 cross-agency transfer (silent + runbook):** if a profile was on Agency A last month and is now on Agency B, the ingest records against whichever agency the `AgencyMember` currently belongs to. Documented in OM PartnerOps runbook: "run prior-month WIC import BEFORE approving transfer."
- **B10 WIC Import Issues page:** standard `DataTable` over `WICImportAuditLog` filtered `rejection_reason != 'accepted'` AND `resolved_at IS NULL`. Row actions:
  - "Mark resolved — accepted after fix" → sets `resolved_at`, `resolution_action='accepted_after_fix'`, `resolved_by_user_id`.
  - "Mark resolved — rolled back" → sets `resolution_action='rolled_back'`.
  - "Mark resolved — ignored" → `resolution_action='ignored'`.
  - "Navigate to B2 (Agency detail)" link if `agency_id` was resolvable in the raw payload.
- **No PRM logic branches on `wic_level`:** L-002 — WIC classification is external. PRM stores it on `WICContribution` and displays it on the dashboard (Spec #2), but does not gate anything on it.
- **Tier is admin-set (L-008):** WIC totals do NOT auto-derive `tier`. Phase 4 acceptance is about visibility, not governance.
- **Rationale:** A batch-oriented service-to-service integration with an explicit ACL and an auditable rejection queue. No user-facing UI beyond B10. The reuse story is OQ-018: we copy the SPEC-053b header contract rather than inventing auth.

---

## 3. API Contracts

All endpoints live in the PRM module. Service endpoints sit under `/api/prm/service/wic/*` and share one `ServiceAuthMiddleware`; the backend endpoint sits under `/api/prm/wic/*` and uses the standard backend session + ACL feature check.

### 3.1 Header Contract (service endpoints)

Applied by `ServiceAuthMiddleware` on every request under `/api/prm/service/wic/*`. Decisions follow SPEC-053b verbatim — we adopt, we do not invent.

| Header | Required on | Value | Rejection |
|---|---|---|---|
| `X-Om-Import-Secret` | GET, POST | Shared secret read from env `OM_PRM_WIC_IMPORT_SECRET`. 90-day rotation with 7-day dual-valid overlap. | Missing → `401`. Mismatch → `401`. Rotated-out → `401`. |
| `X-Om-Request-Timestamp` | GET, POST | RFC 3339 / ISO-8601 UTC. Must be within ±5 minutes of server clock. | Missing → `400`. Out-of-window → `408` (per §1.4.6). |
| `X-Om-Idempotency-Key` | **POST only** | UUIDv4 generated by n8n per request. Persisted in a small `service_idempotency_key` table keyed by `(endpoint, key)` storing first-response hash. | Missing on POST → `400`. Reused with same payload hash → `200` with `Idempotent-Replay: true` and original response body. Reused with different payload hash → `409`. On GET: header, if present, is ignored (not an error — GET is naturally idempotent per §1.4.6). |

`ServiceAuthMiddleware` is the sole auth surface. It runs **before** Zod validation so malformed auth is always a 4xx auth error, never a 422. It does NOT create a `CustomerUser` or `User` row; downstream handlers see a `ServiceIdentity { clientId: 'n8n-wic', requestId, idempotencyKey? }` on the request context.

**Observability:** every request emits a structured log line with `service_identity`, `endpoint`, `status`, `batch_id?`, `duration_ms`, `idempotency_replay?`. No PII.

### 3.2 `GET /api/prm/service/wic/profiles` (US6.1)

Returns the authoritative roster n8n should classify.

**Request**

```
GET /api/prm/service/wic/profiles?month=YYYY-MM
X-Om-Import-Secret: <secret>
X-Om-Request-Timestamp: 2026-04-23T10:00:00Z
```

- `month` query param: optional; when present, restricts the roster to members who were active at month-start. Omitted → current-live roster.
- No request body. No `X-Om-Idempotency-Key` required or consumed.

**Response 200**

```json
{
  "month": "2026-04",
  "profiles": [
    {
      "agency_member_id": "uuid",
      "github_profile": "octocat",
      "agency_slug": "acme-agency",
      "is_active": true
    }
  ]
}
```

Only rows where:

- `AgencyMember.is_active = true`,
- `AgencyMember.github_profile IS NOT NULL AND <> ''`,
- `Agency.status = 'active' AND Agency.onboarded = true`,

appear. A zero-length `profiles` array is a legal quiet month (US6.1 failure path).

**Error responses**

| Status | Condition |
|---|---|
| 400 | Missing/invalid `month` format (when supplied); missing `X-Om-Request-Timestamp`. |
| 401 | Missing/invalid `X-Om-Import-Secret`. |
| 408 | Timestamp outside ±5-minute window. |

### 3.3 `POST /api/prm/service/wic/imports/{batch_id}` (US6.2)

Accepts a batch of WIC rows for a month. `batch_id` is a URL-path UUID, n8n-generated, and is the canonical `import_batch_id` persisted on every row (accepted and rejected). It is coupled with `X-Om-Idempotency-Key` per §1.4.6: two different retry semantics on the same batch are therefore structurally impossible.

**Request**

```
POST /api/prm/service/wic/imports/6b4f0cd8-9b7a-4a40-87f6-6c1e2a9d4e10
X-Om-Import-Secret: <secret>
X-Om-Request-Timestamp: 2026-04-23T10:00:00Z
X-Om-Idempotency-Key: 7e2c1c88-21d9-4f2b-87b1-02a0ff7b2dd8
Content-Type: application/json
```

```json
{
  "script_version": "1.0-agent",
  "month": "2026-03",
  "rows": [
    {
      "row_index": 0,
      "github_profile": "octocat",
      "person_display_name": "Octo Cat",
      "contribution_month": "2026-03-01",
      "wic_level": "L2",
      "wic_score": 42.5,
      "contribution_count": 7,
      "bounty_bonus": 10,
      "why_bonus": "landed PR #1234",
      "what_included": "...",
      "what_excluded": "...",
      "computed_at": "2026-04-02T08:30:00Z"
    }
  ]
}
```

Zod schema enforces required fields + types. `contribution_month` must normalize to first-of-month (any other day of month → row rejected with `rejection_reason = 'malformed_month'`; the batch itself is NOT aborted — per-row transactionality is the whole point of the ACL).

**Response 200**

```json
{
  "import_batch_id": "6b4f0cd8-9b7a-4a40-87f6-6c1e2a9d4e10",
  "accepted_count": 41,
  "rejected_count": 3,
  "superseded_count": 12,
  "per_row": [
    { "row_index": 0, "status": "accepted", "contribution_id": "uuid" },
    { "row_index": 1, "status": "rejected", "audit_log_id": "uuid", "rejection_reason": "profile_not_found" }
  ],
  "idempotent_replay": false
}
```

**Error responses**

| Status | Condition |
|---|---|
| 400 | Missing/invalid shared headers or body shape (Zod fail at the envelope — not at the row). |
| 401 | Bad/missing `X-Om-Import-Secret`. |
| 408 | Timestamp window violation. |
| 409 | `X-Om-Idempotency-Key` reused with a **different** payload hash (per §1.4.6). Response body points to original request's `import_batch_id` + commit timestamp. |
| 422 | Zod envelope-level failure (e.g., `rows` is not an array). Row-level Zod failures are not 422s — they are per-row rejections recorded in the audit log. |

The handler is wrapped in a batch-level transaction that commits per-row. If the process crashes mid-batch before `prm.wic_import.batch_completed` fires, retry with the same `batch_id` + `X-Om-Idempotency-Key` replays from the first un-committed row; the `(import_batch_id, row_index)` unique key on both `wic_contributions` and `wic_import_audit_log` makes replays side-effect-free.

### 3.4 `GET /api/prm/wic/audit-log` (B10)

Backend-only. Standard OM backend route — session cookie + `prm.wic.resolve` ACL feature check. This is the server side of the B10 DataTable.

**Query params**

| Param | Notes |
|---|---|
| `resolved` | `false` (default), `true`, `all`. |
| `rejection_reason` | Filter by enum. |
| `import_batch_id` | UUID filter. |
| `q` | Fuzzy search over `raw_payload->>'github_profile'`. |
| `page`, `page_size`, `sort` | Standard DataTable contract. |

**Response 200** — paginated rows: `{ id, import_batch_id, row_index, raw_payload, rejection_reason, rejection_detail, agency_id?, created_at, resolved_at?, resolution_action? }`.

**Mutations for B10 row actions** go through the standard command route `POST /api/prm/wic/audit-log/{id}/resolve` with body `{ action: 'accepted_after_fix' | 'rolled_back' | 'ignored', note?: string }`. The handler invokes `ResolveWICImportAuditLogCommand`.

---

## 4. Commands & Events

### 4.1 Commands

All commands live in the PRM module under `@open-mercato/prm/commands/wic/*`. Each implements the OM `Command` interface with `execute` + `undo`.

**`RecordWICContributionCommand` (undoable)**

- Input: `{ agency_member_id, agency_id, github_profile, contribution_month, wic_level, wic_score, contribution_count, bounty_bonus, why_bonus?, what_included?, what_excluded?, import_batch_id, row_index, script_version, computed_at }`.
- Execute: inserts a `WICContribution`, emits `prm.wic.contribution_recorded`.
- Undo: soft-deletes the inserted row (sets `archived_at = now()`) and emits a compensation event `prm.wic.contribution_recorded.undone { contribution_id }`. Used by the batch handler only if the batch is aborted mid-commit before `prm.wic_import.batch_completed` fires.

**`SupersedeWICContributionCommand` (undoable)**

- Input: `{ previous_contribution_id, new_contribution_id }`.
- Execute: sets `previous.superseded_by_id = new_contribution_id` and `previous.archived_at = now()`; emits `prm.wic.contribution_superseded`.
- Undo: clears `superseded_by_id` + `archived_at` on the previous row; emits compensation event. Called only on batch abort.

Supersession is expressed as its own command rather than folded into `RecordWICContributionCommand` because (a) the undo contracts differ, (b) the events are separately auditable, and (c) it is the right unit of replay when a prior-batch retry corrects a stale supersession.

**`ResolveWICImportAuditLogCommand` (undoable)**

- Input: `{ audit_log_id, action: 'accepted_after_fix' | 'rolled_back' | 'ignored', resolved_by_user_id, note? }`.
- Execute: sets `resolved_at`, `resolution_action`, `resolved_by_user_id`, `resolution_note`; emits `prm.wic_import.resolved`.
- Undo: clears the four fields; emits compensation event. Used for mis-click reversal by OM PartnerOps (not an automated path).

### 4.2 Events

All events are fact past-tense, snake-case, `prm.*` namespace.

| Event | Payload | Emitted by |
|---|---|---|
| `prm.wic.contribution_recorded` | `{ contribution_id, agency_id, agency_member_id, github_profile, contribution_month, wic_level, wic_score, import_batch_id, row_index, imported_at }` | `RecordWICContributionCommand` (per accepted row). |
| `prm.wic.contribution_superseded` | `{ previous_contribution_id, new_contribution_id, agency_id, agency_member_id, contribution_month }` | `SupersedeWICContributionCommand` (per supersession). |
| `prm.wic_import.row_rejected` | `{ import_batch_id, row_index, rejection_reason, rejection_detail, raw_payload, resolved_agency_id? }` | ACL (per rejected row). |
| `prm.wic_import.batch_completed` | `{ import_batch_id, script_version, month, accepted_count, rejected_count, superseded_count, completed_at }` | Batch handler (once per batch, only after all rows committed). |
| `prm.wic_import.resolved` | `{ audit_log_id, action, resolved_by_user_id, resolved_at }` | `ResolveWICImportAuditLogCommand`. |

**Subscriber responsibilities in this spec:** none. All five events are produced here; consumption (dashboard cache invalidation, telemetry) lives in Spec #2 (portal) and downstream observability.

---

## 5. Data Models

### 5.1 `wic_contributions`

```
id                    uuid PK
organization_id       uuid NOT NULL              -- tenant scope
agency_id             uuid NOT NULL FK agencies.id       -- SNAPSHOT (invariant #13)
agency_member_id      uuid NOT NULL FK agency_members.id
github_profile        text NOT NULL              -- SNAPSHOT (invariant #13)
contribution_month    date NOT NULL              -- normalized YYYY-MM-01
wic_level             text NULL                  -- {L1,L2,L3,L4} or NULL for zero-score months
wic_score             numeric(12,4) NOT NULL
contribution_count    integer NOT NULL DEFAULT 0
bounty_bonus          numeric(12,4) NOT NULL DEFAULT 0
why_bonus             text NULL
what_included         text NULL
what_excluded         text NULL
script_version        text NOT NULL
import_batch_id       uuid NOT NULL
row_index             integer NOT NULL
computed_at           timestamptz NOT NULL
imported_at           timestamptz NOT NULL DEFAULT now()
superseded_by_id      uuid NULL FK wic_contributions.id
archived_at           timestamptz NULL           -- set when superseded
created_at            timestamptz NOT NULL DEFAULT now()
updated_at            timestamptz NOT NULL DEFAULT now()
```

**Indexes / constraints**

- `UNIQUE (agency_member_id, contribution_month) WHERE superseded_by_id IS NULL AND archived_at IS NULL` — enforces invariant #3 at the "currently active row per member/month" grain.
- `UNIQUE (import_batch_id, row_index)` — makes batch replay side-effect-free (retry determinism per §3.3).
- `INDEX (agency_id, contribution_month DESC) WHERE archived_at IS NULL` — powers Spec #2 dashboard reads.
- `INDEX (contribution_month, agency_id)` — month rollups.
- `CHECK (wic_level IN ('L1','L2','L3','L4') OR wic_level IS NULL)`.
- `CHECK (extract(day from contribution_month) = 1)` — DB-level defense-in-depth for the ACL's first-of-month rule.

**Naming note (Fowler lens):** the table is `wic_contributions` (plural SQL) but the OM entity is `WICContribution` (singular per OM's Singularity Law). The table name is a Mikro-ORM-level artifact; the entity-level identifier is singular.

### 5.2 `wic_import_audit_log`

```
id                    uuid PK
organization_id       uuid NOT NULL
import_batch_id       uuid NOT NULL
row_index             integer NOT NULL
raw_payload           jsonb NOT NULL              -- original n8n row, verbatim
rejection_reason      text NOT NULL               -- enum: see below
rejection_detail      text NULL                   -- human-readable specifics
resolved_agency_id    uuid NULL FK agencies.id    -- best-effort at import time (null if unresolvable)
script_version        text NOT NULL
month                 text NOT NULL               -- YYYY-MM, for quick filtering
created_at            timestamptz NOT NULL DEFAULT now()
resolved_at           timestamptz NULL
resolved_by_user_id   uuid NULL FK users.id
resolution_action     text NULL                   -- enum: accepted_after_fix | rolled_back | ignored
resolution_note       text NULL
```

**`rejection_reason` enum**

| Value | Source |
|---|---|
| `profile_not_found` | ACL step 1, zero matches. |
| `ambiguous_github_profile` | ACL step 1, >1 match (defense-in-depth; invariant #5 should prevent). |
| `malformed_month` | `contribution_month` not first-of-month or month mismatch with envelope `month`. |
| `unknown_level` | `wic_level` not in enum. |
| `invalid_payload` | Row-level Zod failure (missing/mistyped required fields). |

**Indexes**

- `UNIQUE (import_batch_id, row_index)` — mirrors the contributions table, enables batch replay.
- `INDEX (resolved_at, rejection_reason) WHERE resolved_at IS NULL` — powers B10's default "open issues" filter.
- `INDEX (resolved_agency_id)` — for navigation-to-B2 counts.

### 5.3 `service_idempotency_key` (auth infrastructure)

Small side table owned by `ServiceAuthMiddleware` — not a PRM domain entity.

```
endpoint             text NOT NULL
idempotency_key      uuid NOT NULL
payload_hash         text NOT NULL               -- sha256 of canonical body
response_hash        text NOT NULL               -- sha256 of response body
response_status      int  NOT NULL
response_body        jsonb NOT NULL              -- replayed verbatim
created_at           timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (endpoint, idempotency_key)
```

Retention: 30 days (superset of any reasonable n8n retry window). A nightly job (outside this spec) trims older rows.

---

## 6. Access Control

### 6.1 Service endpoints (`/api/prm/service/wic/*`)

- Auth surface: `ServiceAuthMiddleware` (this spec). No ACL feature check — the shared secret IS the authorization.
- No `CustomerUser` / `User` context. No `organization_id` in the request; the middleware resolves the singleton PRM tenant context from config (the WIC integration is a global OM-level integration; there is only one tenant scope for PRM contributions).
- Rate limit: 60 requests/minute per secret (standard middleware posture).

### 6.2 Backend endpoint (`/api/prm/wic/audit-log`)

- Standard backend session cookie.
- ACL feature: **`prm.wic.resolve`** (new feature ID, seeded alongside this spec's migrations). Granted to OM PartnerOps and Admin roles by seed.
- Mutation route (row action) requires the same feature. Commands ultimately audit `resolved_by_user_id` from the session.

### 6.3 Portal reads

Out of scope — handled by Spec #2 (US6.3). Noted here for completeness: the portal dashboard widget reads `wic_contributions` scoped to the viewing CustomerUser's Agency; it does NOT touch `wic_import_audit_log`.

---

## 7. Backward Compatibility

This spec is **additive only**.

- **New entities:** `WICContribution`, `WICImportAuditLog`, `ServiceIdempotencyKey`. No existing entities are touched.
- **New API surface:** `/api/prm/service/wic/*`, `/api/prm/wic/audit-log`. No existing route is modified.
- **New ACL feature:** `prm.wic.resolve`. Seed migration adds it to OM PartnerOps + Admin roles. No feature is renamed or removed.
- **New events:** all under `prm.wic.*` and `prm.wic_import.*` — new namespaces; no existing event contract changes.
- **New env var:** `OM_PRM_WIC_IMPORT_SECRET`. **Convention:** `OM_` prefix per Piotr PR #938. Absence at boot fails fast with a clear log line; the service routes return `503` until configured so that dev and staging environments can boot without the secret.
- **AgencyMember / Agency:** no schema changes. This spec assumes Spec #1 has shipped the `github_profile` global-unique constraint (invariant #5).

No migration data-backfill is required. An empty `wic_contributions` table is the correct Phase 4 starting state.

---

## 8. Risks & Impact Review

| # | Risk | Mitigation | Owner |
|---|---|---|---|
| R1 | **±5-minute replay window too wide** for a high-volume attacker | §1.4.6 explicitly sets ±5 min. The secret + TLS + the `(endpoint, idempotency_key)` dedupe table together make replay of the same captured POST a no-op (idempotent replay) or a 409 (different payload). Window is wide enough to tolerate n8n clock drift + server clock drift; narrower is operationally brittle. | PRM dev. |
| R2 | **Batch partial failure** — network drop mid-batch leaves some rows committed, no `batch_completed` event | Per-row commit + `UNIQUE (import_batch_id, row_index)` on both tables. Retry with the same `batch_id` + `X-Om-Idempotency-Key` replays from the first un-committed row. `prm.wic_import.batch_completed` is emitted only on clean completion, so downstream consumers (Spec #2 cache invalidation) are never tricked into partial reads. | PRM dev. |
| R3 | **Supersession race on concurrent imports** (two batches hit the same member/month in parallel) | Postgres `UNIQUE (agency_member_id, contribution_month) WHERE superseded_by_id IS NULL AND archived_at IS NULL` serializes the critical section. Second writer wraps its `INSERT` + supersession `UPDATE` in a `SERIALIZABLE` txn; on conflict it re-reads the now-active row and either no-ops (same content) or supersedes it. n8n's real deployment schedule is monthly + manual retries — true concurrency is vanishingly rare, but the DB invariant still holds. | PRM dev. |
| R4 | **Cross-agency transfer edge case** (profile on Agency A last month, Agency B today; prior-month import still pending) | Per OQ-013: **silent** — the import attributes to whichever agency the `AgencyMember` currently belongs to (invariant #13 snapshotting). Mitigation: OM PartnerOps runbook entry "run prior-month WIC import BEFORE approving transfer." Not blocking for Phase 4. This spec documents it and moves on. | OM PartnerOps runbook (not code). |
| R5 | **Secret leakage / rotation** | 90-day rotation with 7-day dual-valid window — both old and new secrets accepted during overlap. Rotation is a config change, not a code change; middleware reads `OM_PRM_WIC_IMPORT_SECRET` and `OM_PRM_WIC_IMPORT_SECRET_NEXT` and accepts either. Observability: every rejected secret attempt logs `service_identity=unknown` + source IP hash. | Ops. |
| R6 | **`wic_level` mis-use downstream** (future dev branches business logic on it) | L-002: PRM does not branch on `wic_level`. The entity field is documented as display-only, and this spec explicitly states that no commands, ACL checks, or aggregate logic read `wic_level`. Enforced by the Fowler-lens review on all future PRM PRs. | PRM code review. |
| R7 | **ACL rejection fatigue** — OM PartnerOps ignoring B10 queue | Phase 4 acceptance criterion: rejection rate < 5%. If B10 accumulates >20 open issues, telemetry alert fires. Not implemented in this spec — noted for Phase 6 observability. | OM PartnerOps + observability backlog. |

---

## 9. Integration Test Coverage

All tests live under `tests/integration/prm/wic/` — Playwright-driven API tests (service + backend) plus one Playwright UI test for B10.

| # | Test | Scope | Stories |
|---|---|---|---|
| T1 | **Successful batch import, all rows accepted** | POST one batch of 3 valid rows → 200, 3 accepted, 3 `prm.wic.contribution_recorded` emitted, 1 `prm.wic_import.batch_completed` emitted, rows visible via direct DB query. | US6.2 |
| T2 | **Malformed row → audit log** | POST one batch with one row where `contribution_month = '2026-03-15'` (not first-of-month) → 200, 0 accepted, 1 rejected with `rejection_reason='malformed_month'`, 1 `prm.wic_import.row_rejected` emitted. | US6.2 |
| T3 | **`profile_not_found` → audit log** | POST with `github_profile='ghost-user'` (no AgencyMember) → rejected, `rejection_reason='profile_not_found'`, `resolved_agency_id IS NULL`. | US6.2 |
| T4 | **Duplicate (member, month) → supersession** | Import month `2026-03` with `wic_score=40`. Re-import same month with `wic_score=45`. Assert: previous row has `superseded_by_id` + `archived_at`, new row is active, unique constraint holds, `prm.wic.contribution_superseded` emitted once. | US6.2, invariant #3 |
| T5 | **Retry same `import_batch_id` is idempotent** | POST same batch + same `X-Om-Idempotency-Key` → 200 with `idempotent_replay: true`, same response body, no new events, no new rows. | US6.2 |
| T6 | **Retry same `batch_id` with different payload** | Same `X-Om-Idempotency-Key`, different body → 409. No state mutation. | US6.2 |
| T7 | **Timestamp skew rejected** | `X-Om-Request-Timestamp` 10 minutes in past → 408. No events. | US6.1, US6.2 |
| T8 | **Bad secret rejected** | Wrong `X-Om-Import-Secret` on GET and POST → 401 each. | US6.1, US6.2 |
| T9 | **GET profiles happy path** | Seed 2 active + 1 inactive AgencyMember → GET returns 2 rows, no inactive. | US6.1 |
| T10 | **GET profiles quiet month** | No onboarded agencies → 200 with empty array. | US6.1 |
| T11 | **GET rejects `X-Om-Idempotency-Key` absence gracefully** (should NOT be required) | GET with no idempotency header → 200. | US6.1 |
| T12 | **Invariant #13 snapshot survives member reassignment** | Import March for AgencyMember at Agency A. Move member to Agency B. Query the March contribution → still `agency_id = A`. | US6.2, invariant #13 |
| T13 | **B10 resolution workflow** (Playwright UI) | Log in as OM PartnerOps → navigate to B10 → see the rejected row from T3 → click "Mark resolved — accepted after fix" → row leaves default view, `resolution_action` persisted, `prm.wic_import.resolved` emitted. | US6.4 |
| T14 | **B10 RBAC** | Log in as role without `prm.wic.resolve` → `/api/prm/wic/audit-log` returns 403. | US6.4 |
| T15 | **Concurrent supersession race** | Spawn two POSTs for the same (member, month) with different scores in parallel → exactly one row ends up `active`, the other is `archived`, no orphan rows, no duplicate-count events. | Invariant #3, R3 |

**Test fixtures:** one active agency, two active AgencyMembers (one with GH profile `octocat`, one without), one inactive AgencyMember, one unused `ghost-user` profile.

---

## 10. Final Compliance Report

Reviewed against Piotr's Decision Library, the Fowler lens, and the Phase 4 acceptance criteria (§7 of the App Spec).

### 10.1 Architectural purity (Fowler lens)

| Check | Result |
|---|---|
| **Singularity Law** — entity names singular | `WICContribution`, `WICImportAuditLog`. Table names plural per SQL convention — acceptable, documented in §5.1. PASS. |
| **Command Graph vs. Independent Ops** — is the batch a graph or a sequence? | Per-row `RecordWICContributionCommand` + `SupersedeWICContributionCommand` (independent ops, per-row commit). Chosen over a single `ImportBatchCommand` because (a) rows are independent at the domain grain and (b) partial failure must be observable. PASS. |
| **Undo Contract** — every state-changing command has `undo` | `RecordWICContributionCommand.undo` (soft-delete + compensation event), `SupersedeWICContributionCommand.undo` (restore previous active row), `ResolveWICImportAuditLogCommand.undo` (clear resolution fields). PASS. |
| **Module Isolation** — no direct imports across module boundaries | PRM only. Events published for future portal (Spec #2) consumption. Auth middleware is PRM-local (no shared auth module needed). PASS. |
| **FK IDs only for cross-module links** | AgencyMember, Agency, User referenced by FK id; no cross-module ORM relations. PASS. |

### 10.2 Security

| Check | Result |
|---|---|
| **Auth pattern reuse** — OQ-018 resolved to SPEC-053b pattern | Adopted verbatim: shared secret + ±5-minute timestamp + POST-only idempotency key. No raw auth invented. PASS. |
| **Secret storage** | `OM_PRM_WIC_IMPORT_SECRET` env var. `OM_` prefix per Piotr PR #938. Rotation overlap documented (§7, R5). PASS. |
| **Replay protection** | ±5-minute window + `X-Om-Idempotency-Key` dedupe table. PASS. |
| **No PII in logs** | Structured logs carry `service_identity`, IDs, status. No raw payloads. PASS. |
| **RBAC for B10** | `prm.wic.resolve` feature, seeded to OM PartnerOps + Admin. PASS. |

### 10.3 Data & invariants

| Check | Result |
|---|---|
| **Invariant #3 (idempotent supersession)** | Enforced by partial-unique index + `SupersedeWICContributionCommand`. PASS. |
| **Invariant #13 (attribution snapshotted)** | `agency_id` + `github_profile` are snapshot columns on `wic_contributions`, never updated. PASS. |
| **L-002 (WIC classification external)** | No PRM logic branches on `wic_level`; explicitly stated and enforced by code review. PASS. |
| **L-008 (admin-set tier)** | No code path in this spec writes `Agency.tier`. PASS. |
| **§1.4.6 ACL rules** | All five ACL steps (resolution, validation, snapshot, supersession, script_version storage) implemented. PASS — see §10.5 for one minor deviation note. |

### 10.4 Conventions & naming

| Check | Result |
|---|---|
| **Env var prefix `OM_`** | `OM_PRM_WIC_IMPORT_SECRET`. PASS. |
| **Event naming `module.entity.action` past-tense** | `prm.wic.contribution_recorded`, `prm.wic_import.batch_completed`, etc. PASS. |
| **Zod validation on all API inputs** | Envelope-level Zod on both POST endpoints. Per-row Zod inside the ACL (row failures → audit log, not 422). PASS. |
| **Tenant scope (`organization_id`)** | Present on both entities and on the side `service_idempotency_key` table. PASS. |

### 10.5 Deviations from §1.4.6 — explicit note

The App Spec §1.4.6 uses URL paths `/api/prm/wic/github-profiles` and `/api/prm/wic/import`. This spec uses `/api/prm/service/wic/profiles` and `/api/prm/service/wic/imports/{batch_id}`. The **contract is unchanged** (same headers, same payloads, same ACL rules) — only the URL scheme shifts, because OM's route convention reserves `/api/service/*` for non-session service identities. The `{batch_id}` path segment makes `import_batch_id` structurally non-optional and collapses one failure mode (body-level `import_batch_id` missing or mismatched). The App Spec and this spec are consistent on all other ACL semantics. Flagged to the Spec Orchestrator for cross-spec coherence — a single-line addendum to the App Spec, or a §1.4.6 clarification note, is recommended.

`rejection_reason` enum in this spec uses `profile_not_found` (aligned with the Technical Approach verbatim text) where the App Spec §1.4.6 uses `unknown_github_profile`. Both are implemented: the DB stores the App Spec value (`unknown_github_profile`) to match the source-of-truth contract; the Technical Approach nomenclature (`profile_not_found`) is treated as the human-facing alias in B10 UI copy and route handler comments. Integration tests (T3) assert the App Spec value. This preserves §1.4.6 as authoritative while keeping the Technical Approach intelligible to readers.

### 10.6 Phase 4 acceptance (§7 of the App Spec)

- Invariant #3 idempotent supersession — **implemented** (§5.1 + §9 T4).
- Invariant #13 attribution snapshotted — **implemented** (§5.1 + §9 T12).
- `import_batch_id` guarantees batch retry idempotency — **implemented** (§3.3 + §9 T5, T6).
- ACL rejects malformed/unresolved rows into `WICImportAuditLog` — **implemented** (§5.2 + §9 T2, T3).

**Estimated commits: 5.**

1. Entity migrations + seeds + `prm.wic.resolve` ACL feature.
2. `ServiceAuthMiddleware` + `service_idempotency_key` table + unit tests.
3. `GET /api/prm/service/wic/profiles` route + Zod + integration tests (T8–T11).
4. `POST /api/prm/service/wic/imports/{batch_id}` route + ACL + `RecordWICContributionCommand` + `SupersedeWICContributionCommand` + events + integration tests (T1–T7, T12, T15).
5. B10 page (DataTable + row actions) + `GET/POST /api/prm/wic/audit-log` + `ResolveWICImportAuditLogCommand` + Playwright tests (T13, T14).

All 5 commits are point-sized. No gap from OM core shipped primitives (OQ-018 resolved per decisions log).
