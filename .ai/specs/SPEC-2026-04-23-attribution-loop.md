# SPEC-2026-04-23 — PRM Attribution Loop (WF3b · Phase 3)

**Spec #3 of 7** · Author: Piotr (om-cto Spec Orchestrator) · Date: 2026-04-23
**Persona:** Martin Fowler (architectural-purity lens)
**Depends on:** SPEC-2026-04-23-agency-foundation (#1), SPEC-2026-04-23-wip-scoreboard (#2)
**Est. commits:** 4–5 (OQ-017 resolved — `workflows` ships full saga)

---

## 1. Summary + Scope + Business Outcome

### TLDR
Phase 3 closes the revenue loop. `LicenseDeal` becomes a first-class aggregate with three mutually-exclusive attribution paths (Prospect / RFP / Direct). A single JSON `WorkflowDefinition` on the `workflows` module orchestrates the downstream Prospect transitions idempotently. OM PartnerOps sees an auditable decision record for every deal; Agencies see their MIN number update on their portal dashboard within ten minutes.

### Scope (in)
- **US4.1** — Path A (Prospect) attribution with Golden Rule picker.
- **US4.2** — Path B (RFP) placeholder attribution (full RFP flow is Spec #5/#6).
- **US4.3** — Path C (Direct) — unattributed OM sale.
- **US4.4** — Reverse / reassign attribution (pre-`active`, or post-unwind via US4.4b).
- **US4.4b** — Reverse LicenseDeal status (`active → signed` or `signed → pending`), scoped bypass of invariant #7 for legitimate corrections.
- **US4.5** — Portal MIN widget on P2 (yearly view per L-011).
- Saga as JSON `WorkflowDefinition` with `correlationKey` idempotency, LIFO compensation, wildcard event trigger.
- Read-model subscriber that maintains `is_path_b_locked` on the RFP aggregate (owner = Spec #5; **this spec owns only the subscriber that writes to it** — see Risks §8.4).

### Scope (out — explicit)
- RFP entity definition, broadcast, scoring, selection (Specs #5, #6).
- Hard-guard *enforcement* of invariant #17 on the RFP state machine — lives in Spec #6 (`rfp-scoring-selection`). This spec emits the state; Spec #6 reads it.
- Full notification surface for MIN changes (toast / digest) — the widget is pull-based in v1.
- Commission calculation, renewal attribution inheritance beyond a default (v1 simplification, §1.4.1 WF3b edge case 6).
- Snapshot table for historical MIN (§1.4.3 — v1 recomputes on read; v2 concern).

### Business outcome
> *"Attribution is a decision with a timestamp, not a conversation. Agencies see MIN update within minutes."*

- 100 % of LicenseDeal attributions emit `prm.license_deal.attributed` (Cagan business criterion).
- Median saga latency ≤ 10 minutes from B5 save → P2 MIN widget update.
- Every non-default Golden Rule pick carries a captured `attribution_reasoning` and emits `prm.license_deal.attribution_overridden`.
- ≥ 3 MIN-attributed LicenseDeals within first 6 months post-v1 launch.

---

## 2. Technical Approach (Piotr)

- **Mode:** Extend PRM module with LicenseDeal aggregate + **`workflows` saga as JSON `WorkflowDefinition`**. No core module modifications. No custom saga orchestrator.
- **New entities:**
  - `LicenseDeal` (aggregate; FK `client_id` nullable or `client_name` string; `status` enum `pending` / `active` / `signed` / `invalidated`; `attribution_path` enum `A` / `B` / `C` / `none`; **path-A:** FK `prospect_id` + denormalized FK `agency_id` (snapshot); **path-B:** FK `rfp_id` + FK `selected_agency_id` (snapshot); **path-C:** FK `agency_id` direct; `attribution_reasoning` text — required when override Golden Rule (US4.1) or Path C; `attributed_at` timestamp — **frozen when `status >= active` per invariant #7**; `signed_at` nullable; `monthly_license_amount` decimal).
- **Saga as JSON `WorkflowDefinition` (OQ-017 — NO custom dedupe table):**
  - Trigger: `WorkflowEventTrigger` on `prm.license_deal.attributed`.
  - Idempotency: `correlationKey = license_deal_id + attribution_path` — platform provides deduplication.
  - Activity handlers (2 for Path A, 1 for Path B/C):
    1. **Path A snapshot Prospect:** read Prospect by `prospect_id`, snapshot `agency_id` onto LicenseDeal, then mark Prospect `won` (emits `prm.prospect.status_changed` with `by_actor_type = 'system'` per Vernon C2). Competing Prospects matching same client (normalized) stay `new` / `qualified` (OQ-004: attribution-time resolution, no lifecycle signalling) — OM staff may separately mark them `lost` via B5 bulk-action.
    2. **Path B snapshot RFP winner:** snapshot `selected_agency_id` onto LicenseDeal.
    3. **Path C direct:** no saga activity beyond the aggregate write — `agency_id` already set.
  - Compensation (LIFO — `workflows` provides): on `prm.license_deal.reversed`, compensation handlers undo the snapshot writes + Prospect `won → qualified` transition (emits `prm.prospect.status_changed` with `by_actor_type = 'system'`).
  - `maxConcurrentInstances` = 1 per license_deal_id (platform provides).
- **Reverse-saga (US4.4):** JSON variant of the same `WorkflowDefinition` triggered on `prm.license_deal.reversal_started`. Reuses 95% of saga infrastructure — counted as 1 commit.
- **Reverse-status (US4.4b):** explicit separate story for `active → signed` UNWIND (without full reassignment). Backend action on B5 emits `prm.license_deal.status_unreversed` + updates aggregate. Kept as its own commit because invariant #7's active-freeze needs a scoped bypass for this legitimate correction path.
- **Golden Rule (invariant #14) in B5 picker:**
  - Attribution-picker custom widget on B5 `LicenseDeals` CrudForm.
  - Query candidate Prospects via `ProspectCandidateIndex` (from Spec #2) joined on `normalized_company_name` = normalize(client_name).
  - **Always includes Prospects with status `lost` (W12 requirement)** — flag with red "LOST" badge in picker.
  - Default selection = oldest `registered_at` among non-lost candidates.
  - Override: OM staff picks different Prospect → free-text `attribution_reasoning` required → emits `prm.license_deal.attribution_overridden` with reasoning captured.
- **Hard guard invariant #17 (C5):** when LicenseDeal `attribution_path = 'B'` AND `status >= signed`, block RFP re-open / re-selection on the linked RFP. Enforced in **Spec #6 (rfp-scoring-selection)** — this spec only emits the state; cross-spec invariant contract documented in both specs. For THIS spec: write a subscriber on `prm.license_deal.status_changed` that maintains a `is_path_b_locked` read-model field on the RFP aggregate (in Spec #5's entity — this spec owns only the subscriber, not the RFP entity).
- **MIN widget (US4.5):** portal P2 aggregate query on LicenseDeals where `selected_agency_id = current_agency_id` AND `status IN ('active', 'signed')`. Yearly view per L-011. Sums `monthly_license_amount × 12` for MIN contribution.
- **Saga latency target:** ≤ 10 minutes from B5 save → MIN widget update (§7 Phase 3 Cagan criteria). Saga is async — `workflows` handles retries + failure state.
- **Rationale:** `workflows` module ships every saga primitive. PRM owns only the JSON definition + activity handlers + picker UX. No orchestration code, no dedupe table, no retry wrapper. This is the largest OQ-win in the app.

> **Reconciliation note (Piotr):** The Technical Approach above refers in one place to a `client_id` FK and in another to `client_company_name` text (the App Spec §1.4.1 field). The authoritative choice for v1 is the **text `client_company_name`** per the App Spec. The `client_id` mention is forward-looking (v2 Client aggregate) and MUST NOT appear in the v1 migration. The `status` enum `pending / active / signed / invalidated` differs from the App Spec §1.4.1 enum `pending / signed / active / churned`: **the App Spec wins** — `churned` is the v1 terminal state for contract termination; `invalidated` is an alias for what US4.4 reversals produce and is realised as `status = pending` + an audit event, NOT a distinct status value. Data model §5 reflects the resolved schema.

---

## 3. API Contracts

All backend routes require `om.backend.session` + feature `prm.license_deal.write`. Portal route requires `customer.session` + Agency-scope check.

### 3.1 Backend — `/api/backend/prm/license-deal`

Plural-URL / singular-entity convention per root naming law.

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/backend/prm/license-deals` | — (query: `status`, `attribution_path`, `agency_id`, `q`) | paged list | B5 list |
| `POST` | `/api/backend/prm/license-deals` | `CreateLicenseDealInput` (Zod) | `LicenseDealDTO` | Creates in `pending`, never auto-attributes |
| `GET` | `/api/backend/prm/license-deals/:id` | — | `LicenseDealDTO` | B5 detail |
| `PUT` | `/api/backend/prm/license-deals/:id` | `UpdateLicenseDealInput` | `LicenseDealDTO` | Rejects attribution fields — use `/attribute` |
| `DELETE` | `/api/backend/prm/license-deals/:id` | — | `204` | Soft-delete only while `status = pending` |

#### 3.1.1 `POST /api/backend/prm/license-deals/:id/attribute`

The single attribution commit; transitions aggregate to `active` if invariant #17 holds, fires the saga.

**Zod input (discriminated union on `attribution_path`):**

```ts
const AttributeInput = z.discriminatedUnion('attribution_path', [
  z.object({
    attribution_path: z.literal('A'),
    prospect_id: z.string().uuid(),
    competing_prospect_ids_to_retire: z.array(z.string().uuid()).default([]),
    attribution_reasoning: z.string().min(1).optional(), // required iff non-default pick
    golden_rule_default_prospect_id: z.string().uuid(), // echoed back for server-side override detection
  }),
  z.object({
    attribution_path: z.literal('B'),
    rfp_id: z.string().uuid(),
    // selected_agency_id resolved server-side from RFP
  }),
  z.object({
    attribution_path: z.literal('C'),
    attribution_reasoning: z.string().min(1), // required for Path C audit
  }),
]);
```

**Returns:** `202 Accepted` with `{ license_deal_id, saga_correlation_key, emitted_events: [...] }`. The saga runs async; UI polls the aggregate or subscribes to server-sent `prm.license_deal.*` events if the portal-events channel is live.

**Errors:**
- `409 InvariantViolation` — aggregate version mismatch (optimistic concurrency, WF3b edge case 3).
- `409 AttributionFrozen` — invariant #7: `status >= active` without preceding `/unreverse-status`.
- `409 PathBLockedRfp` — invariant #17: RFP already locked by another signed Path-B deal (defensive; primary enforcement lives in Spec #6).
- `422 ValidationError` — Zod failure; Path A missing reasoning when override detected.

#### 3.1.2 `POST /api/backend/prm/license-deals/:id/reverse`

Reassigns or unattributes. Requires `status < active` (precondition — call `/unreverse-status` first otherwise).

```ts
const ReverseInput = z.object({
  reason: z.string().min(10),
  new_attribution: AttributeInput.optional(), // if omitted => unattribute (Path C with 'reversed' reason)
});
```

Emits `prm.license_deal.reversal_started` then (after reverse-saga completes) `prm.license_deal.reversed` + the standard `prm.license_deal.attributed` for the new state.

#### 3.1.3 `POST /api/backend/prm/license-deals/:id/unreverse-status`

The scoped bypass of invariant #7 for US4.4b.

```ts
const UnreverseStatusInput = z.object({
  to_status: z.enum(['signed', 'pending']), // never allowed: 'churned' -> anything
  reason: z.string().min(10),
});
```

Guard: rejects when `status = churned` (terminal). Emits `prm.license_deal.status_unreversed` and `prm.license_deal.status_changed`.

### 3.2 Portal — `/api/portal/min`

Read-only aggregate for the caller's Agency; mounted under tenant-scoped `/{slug}/api/portal/...` per SPEC-060 customer-account routing.

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/api/portal/min` | `year` (default = current) | `{ year, tier_target, own_count, own_deals: LicenseDealPublicDTO[] }` |

`LicenseDealPublicDTO` exposes only fields the Agency may see per §1.4.4: `license_identifier`, `client_industry`, `closed_at`, bucketed `annual_value_usd`, `status`. Never exposes competing Prospects, other Agencies, or `attribution_reasoning`.

---

## 4. Commands & Events

### 4.1 Commands

All commands are undoable per the root Undoability law; undo implementations are the **compensation handlers** registered on the `WorkflowDefinition`.

| Command | Trigger | Undoable? | Compensation |
|---|---|---|---|
| `CreateLicenseDealCommand` | `POST /license-deals` | Yes (soft-delete while `pending`) | Restores soft-deleted row |
| `AttributeLicenseDealCommand` | `POST /:id/attribute` | **Yes** (via `ReverseLicenseDealAttributionCommand`) | Reverse saga (LIFO) |
| `ReverseLicenseDealAttributionCommand` | `POST /:id/reverse` | Yes (by re-running `AttributeLicenseDealCommand` with prior snapshot) | Prior attribution snapshot replay |
| `ReverseLicenseDealStatusCommand` | `POST /:id/unreverse-status` | Yes (forward status transition via normal pending→signed→active path) | Re-advance status |

The attribute / reverse pair is the canonical **Command Graph** in this spec — two steps coupled by the aggregate invariant #7. Not a Compound Command: the reversal MUST consult the aggregate state before firing (it is a calculation, not an independent op).

### 4.2 Events emitted

All events follow the `prm.license_deal.*` naming convention (App Spec §1.4.5).

| Event | Payload | Purpose |
|---|---|---|
| `prm.license_deal.created` | `{ license_deal_id, status: 'pending', client_company_name, is_renewal, previous_license_deal_id? }` | Audit trail starts here |
| `prm.license_deal.attributed` | `{ license_deal_id, attribution_source, attributed_agency_id?, prospect_id?, rfp_id?, competing_prospect_ids? }` | **Drives the saga**. `correlationKey = license_deal_id + attribution_path` |
| `prm.license_deal.attribution_overridden` | `{ license_deal_id, default_prospect_id, selected_prospect_id, from_agency_id, to_agency_id, reason, by_user_id }` | Non-default Golden Rule pick; required text `reason` |
| `prm.license_deal.status_changed` | `{ license_deal_id, from_status, to_status, by_user_id, reason? }` | Standard lifecycle; also fires on US4.4b |
| `prm.license_deal.reversal_started` | `{ license_deal_id, from_agency_id, reason, by_user_id }` | Drives reverse-saga |
| `prm.license_deal.reversed` | `{ license_deal_id, from_agency_id, to_agency_id?, reason, by_user_id }` | Emitted by reverse-saga on completion |
| `prm.license_deal.status_unreversed` | `{ license_deal_id, from_status, to_status, by_user_id, reason }` | US4.4b explicit audit event, paired with `status_changed` |

### 4.3 Events consumed (subscribers this spec owns)

| Event | Subscriber | Action |
|---|---|---|
| `prm.license_deal.attributed` | **Attribution saga** (`WorkflowDefinition`) | Path A: snapshot + Prospect→won. Path B: snapshot. Path C: noop |
| `prm.license_deal.reversal_started` | **Reverse saga** | LIFO compensation: Prospect→qualified, unsnapshot |
| `prm.license_deal.status_changed` | `RfpPathBLockSubscriber` | Maintains `is_path_b_locked` on the RFP read-model owned by Spec #5 (see §8.4) |

---

## 5. Data Models

### 5.1 `license_deal` table (new — owned by this spec)

```sql
CREATE TABLE license_deal (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organization(id),
  license_identifier       TEXT NOT NULL UNIQUE,

  -- client (v1: free text; v2: FK to Client aggregate)
  client_company_name      TEXT NOT NULL,
  client_industry          TEXT,  -- dictionary key

  -- lifecycle
  type                     TEXT NOT NULL DEFAULT 'enterprise',
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','signed','active','churned')),
  is_renewal               BOOLEAN NOT NULL DEFAULT FALSE,
  previous_license_deal_id UUID REFERENCES license_deal(id),
  closed_at                TIMESTAMPTZ,
  signed_at                TIMESTAMPTZ,

  -- financials
  annual_value_usd         NUMERIC(12,2),
  monthly_license_amount   NUMERIC(12,2),

  -- attribution (mutually exclusive at application layer; CHECK constraint below)
  attribution_path         TEXT NOT NULL DEFAULT 'none'
                             CHECK (attribution_path IN ('A','B','C','none')),
  attribution_source       TEXT NOT NULL DEFAULT 'direct'
                             CHECK (attribution_source IN ('prospect','rfp','direct')),
  prospect_id              UUID REFERENCES prospect(id),
  rfp_id                   UUID, -- FK added in Spec #5 migration; deferrable
  attributed_agency_id     UUID REFERENCES agency(id),  -- denormalized snapshot
  attribution_reasoning    TEXT,  -- required when override detected or Path C
  attributed_at            TIMESTAMPTZ,

  -- audit
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ,
  version                  INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency

  CONSTRAINT chk_attribution_exclusive
    CHECK (
      (prospect_id IS NOT NULL)::INT + (rfp_id IS NOT NULL)::INT <= 1
    ),
  CONSTRAINT chk_reasoning_required_on_path_c
    CHECK (attribution_path <> 'C' OR attribution_reasoning IS NOT NULL),
  CONSTRAINT chk_frozen_when_active  -- invariant #7 — DB-level safety net; primary enforcement is application-layer
    CHECK (TRUE) -- placeholder; enforced via trigger (see §5.3)
);

CREATE INDEX idx_license_deal_agency    ON license_deal (attributed_agency_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_license_deal_prospect  ON license_deal (prospect_id) WHERE prospect_id IS NOT NULL;
CREATE INDEX idx_license_deal_rfp       ON license_deal (rfp_id) WHERE rfp_id IS NOT NULL;
CREATE INDEX idx_license_deal_client    ON license_deal (LOWER(client_company_name));
```

### 5.2 Invariant #7 trigger

Application layer is the primary enforcement. A PostgreSQL trigger provides defence-in-depth:

```sql
CREATE FUNCTION prm_guard_license_deal_attribution_freeze() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('active','signed','churned')
     AND (NEW.attributed_agency_id IS DISTINCT FROM OLD.attributed_agency_id
       OR NEW.prospect_id IS DISTINCT FROM OLD.prospect_id
       OR NEW.rfp_id IS DISTINCT FROM OLD.rfp_id
       OR NEW.attribution_path IS DISTINCT FROM OLD.attribution_path)
  THEN
    RAISE EXCEPTION 'Invariant #7: LicenseDeal attribution frozen once status >= active. Use US4.4b first.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 5.3 Saga state — **no new table**

Per OQ-017 resolution, the `workflows` module owns `WorkflowInstance` storage (correlationKey-keyed). **This spec MUST NOT create a `license_deal_saga_state` table.** Previous drafts were rewritten when OQ-017 resolved.

### 5.4 `WorkflowDefinition` JSON shape (declarative)

Single definition, three paths via conditional activity handlers:

```jsonc
{
  "id": "prm.license_deal.attribution_saga",
  "version": 1,
  "trigger": {
    "kind": "event",
    "eventId": "prm.license_deal.attributed",
    "correlationKey": "{{ event.license_deal_id }}:{{ event.attribution_source }}",
    "maxConcurrentInstances": 1
  },
  "activities": [
    {
      "id": "snapshotProspect",
      "when": "{{ event.attribution_source == 'prospect' }}",
      "handler": "prm.saga.snapshotProspect",
      "compensate": "prm.saga.unsnapshotProspect"
    },
    {
      "id": "markProspectWon",
      "when": "{{ event.attribution_source == 'prospect' }}",
      "handler": "prm.saga.markProspectWon",
      "compensate": "prm.saga.markProspectQualified"
    },
    {
      "id": "snapshotRfpWinner",
      "when": "{{ event.attribution_source == 'rfp' }}",
      "handler": "prm.saga.snapshotRfpWinner",
      "compensate": "prm.saga.unsnapshotRfpWinner"
    }
    // Path C: no activity needed — aggregate write already committed
  ],
  "reverse": {
    "triggerEventId": "prm.license_deal.reversal_started",
    "order": "LIFO"
  }
}
```

Activity handlers are plain TS functions registered on the PRM module's workflow-handler registry. Each handler is idempotent: read-state → if-already-applied-return → write-state → emit-event.

### 5.5 Cross-spec read-model field

`rfp.is_path_b_locked BOOLEAN NOT NULL DEFAULT FALSE` — **column lives on the `rfp` table owned by Spec #5.** This spec owns only the subscriber (`RfpPathBLockSubscriber`) that writes to it. The migration that adds the column lives in Spec #5. See §8.4 for the cross-spec contract.

---

## 6. Access Control

### 6.1 Backend (OM staff)

| Feature flag | Who | Grants |
|---|---|---|
| `prm.license_deal.read` | OM PartnerOps, OM Admin | GET endpoints, B5 list/detail |
| `prm.license_deal.write` | OM PartnerOps, OM Admin | POST/PUT, `/attribute`, `/reverse` |
| `prm.license_deal.reassign` | OM PartnerOps, OM Admin | `/unreverse-status` (US4.4b) — secondary confirm required in UI |

Portal writes on LicenseDeal are **unconditionally rejected at the API boundary** per invariant #6 (admin-only field gate). No CustomerUser role grants any write.

### 6.2 Portal (CustomerUser)

| Persona | P2 MIN widget | `/api/portal/min` |
|---|---|---|
| PartnerAdmin | Read (own Agency) | 200 |
| PartnerMember | Read (own Agency) | 200 |
| Other Agency | Never | 403 |

Enforcement: `/api/portal/min` computes from `req.auth.organization_id → agency_id` resolution; no client-supplied `agency_id` is honoured (tenant-isolation law).

---

## 7. Backward Compatibility

**Additive only.** Checklist:

| Change | BC impact |
|---|---|
| New table `license_deal` | None — net new |
| New events under `prm.license_deal.*` | None — additive to event catalog |
| New subscriber `RfpPathBLockSubscriber` | None — writes to a new column on `rfp` (introduced in Spec #5; this spec's migration only adds the subscriber wiring) |
| New feature flags `prm.license_deal.*` | Seeded in `setup.ts`; no existing roles are modified — OM PartnerOps role gains them via seed patch |
| New backend page B5 | Net new route |
| Portal P2 — MIN widget added alongside existing WIC/WIP widgets from Spec #2 | Additive; P2 layout accommodates new widget slot per UX spec |
| `ProspectCandidateIndex` query | Read-only consumer of read-model introduced in Spec #2 |

No existing APIs, events, or schemas are renamed, re-typed, or narrowed. The `LicenseDeal` entity block in App Spec §1.4.1 pre-declares the column set — this spec is the implementation of that declaration.

---

## 8. Risks & Impact Review

### 8.1 Saga failure recovery
Risk: a partial saga (snapshot succeeded, Prospect-won failed) leaves the aggregate in an internally-consistent-but-externally-incomplete state.
Mitigation: `workflows` retries with exponential backoff; after N retries the instance lands in `failed` state, observable on a backend dashboard. A B5 "Retry saga" action re-fires the instance. Each activity handler is read-before-write idempotent — replay is safe.

### 8.2 Golden Rule false positives
Risk: two Agencies independently registered Prospects for genuinely-different clients whose company names normalise identically (e.g. two "Acme" entities in different industries).
Mitigation: picker also joins on `lowercased_contact_email`, not just company name; UI surfaces industry + contact email for disambiguation; a non-default pick with `attribution_reasoning` is always the escape hatch. Telemetry: count of `attribution_overridden` events per quarter — if >40 %, escalate to Mat for a policy review.

### 8.3 Reverse-saga ordering
Risk: LIFO compensation must unwind in the correct order — Prospect-won transition must be undone **before** the snapshot is cleared, otherwise the Prospect transition handler cannot find its target agency.
Mitigation: `workflows` LIFO compensation is a platform guarantee (OQ-017). Unit tests assert the ordering via a mock platform that records handler invocation sequence.

### 8.4 Cross-spec invariant #17 contract — **PRIMARY RISK**

**The `is_path_b_locked` read-model field must live in the spec that owns the `rfp` entity — which is Spec #5 (`rfp-broadcast-response`).** This spec owns only the subscriber that writes to it.

**Contract (must appear verbatim in both specs):**
1. Spec #5 migration adds `rfp.is_path_b_locked BOOLEAN NOT NULL DEFAULT FALSE`.
2. Spec #3 (this spec) ships `RfpPathBLockSubscriber` on `prm.license_deal.status_changed`, setting the flag to `TRUE` when `attribution_path = 'B'` AND `to_status IN ('signed','active')`, and setting it to `FALSE` on `status_unreversed → pending`.
3. Spec #6 (`rfp-scoring-selection`) reads the flag and **enforces** the hard guard on RFP state transitions (`closed → scoring`, `selection_made → scoring`, `selection_made → selection_made` with different `selected_agency_id`). Spec #3 does NOT enforce on the RFP side.
4. An integration test coordinated between Specs #3 and #6 verifies the round trip (see §9.4).

**Rationale:** the RFP aggregate owns its own state transitions; only Spec #6 can correctly gate them. The read-model column is a Spec #5 concern (it belongs with the entity that owns it). But the *signal* — when the flag must flip — is a LicenseDeal event, so the subscriber belongs with the entity that emits the event. This respects module isolation (events over direct imports) and the Singularity Law (one writer per read-model field).

### 8.5 Optimistic concurrency on B5
Risk: two OM PartnerOps users attempt attribution on the same deal simultaneously (WF3b edge case 3).
Mitigation: `license_deal.version` column + `UPDATE … WHERE version = $expected`; on miss, API returns `409`. UI refreshes and prompts the loser to retry.

### 8.6 Path-B lock flip during US4.4b
Risk: OM staff unreverses a Path-B LicenseDeal status `active → signed`. If the lock is keyed only on `status >= signed`, it stays locked — but if on `>= active`, it flips open. The spec MUST pick one.
**Decision (Piotr):** lock is active when `status IN ('signed','active')`. US4.4b `active → signed` keeps the lock. US4.4b `signed → pending` **releases** it, because `pending` is exactly the state where reassignment is legal (invariant #7). Subscriber logic in §4.3 reflects this.

---

## 9. Integration Test Coverage (Playwright)

### 9.1 Path A happy path → MIN update
- Seed: Agency A + PartnerAdmin, Prospect P (status `qualified`), OM PartnerOps user.
- OM PartnerOps creates LicenseDeal, picks Path A, selects P (default Golden Rule).
- Assert: saga completes within 10 minutes (test harness fast-forwards). Prospect P has `status = won`. Agency A's `/api/portal/min` returns `own_count = 1`.
- Assert emitted events: `prm.license_deal.created`, `prm.license_deal.attributed`, `prm.prospect.status_changed { by_actor_type: 'system' }`.

### 9.2 Golden Rule override with reasoning
- Seed: Agency A Prospect P1 (oldest), Agency B Prospect P2 (younger).
- Picker default = P1. OM PartnerOps picks P2, enters reasoning.
- Assert: `prm.license_deal.attribution_overridden` fired with `default_prospect_id = P1.id`, `selected_prospect_id = P2.id`, `reason` field populated.
- Assert: P2 = `won`, P1 unchanged (`qualified` — not auto-lost unless explicitly flagged).

### 9.3 Reverse attribution round trip
- Setup: Path A LicenseDeal in `pending` with Prospect P won.
- OM PartnerOps calls `/reverse` with new Path A target Prospect Q.
- Assert: P → `qualified` (compensation), Q → `won`, saga visible in `workflows` dashboard with LIFO compensation log.
- Assert emitted: `reversal_started`, `reversed`, `attributed` (new), `prospect.status_changed` × 2.

### 9.4 Path-B hard guard (coordinates with Spec #6)
- Setup: RFP X with `selected_agency_id = A`, status `selection_made`. LicenseDeal Y with `attribution_path = 'B'`, `rfp_id = X`, transitioned through `signed`.
- Spec #6's test (linked by correlation ID) attempts `POST /api/backend/prm/rfps/X/reopen` — asserts `409 PathBLockedRfp`.
- Spec #3's test (this spec): `RfpPathBLockSubscriber` set `rfp.is_path_b_locked = TRUE` on `prm.license_deal.status_changed { to_status: 'signed' }`. Direct DB read asserts the flag value.
- Both tests share seed fixtures and a shared correlation file at `.ai/test-fixtures/spec3-spec6-handshake.json`.

### 9.5 Idempotent saga re-fire
- Setup: Path A attribution committed.
- Manually emit `prm.license_deal.attributed` a second time with the same payload.
- Assert: `workflows` deduplicates via `correlationKey`; no second `prm.prospect.status_changed` fires; no DB-row duplication.

### 9.6 US4.4b status unreverse gate
- Setup: LicenseDeal in `active`.
- Without `/unreverse-status`: call `/reverse` → `409 AttributionFrozen`.
- Call `/unreverse-status { to_status: 'pending', reason: '...' }`.
- Retry `/reverse` — succeeds.
- Assert: `prm.license_deal.status_unreversed` + `status_changed` fired.

### 9.7 Churned is terminal
- Setup: LicenseDeal in `churned`.
- Call `/unreverse-status` → `409` (churned is terminal, WF3b edge case: must create new deal).

---

## 10. Final Compliance Report — Piotr Decision Library Checklist

| Rule | Status | Evidence |
|---|---|---|
| **Singularity law** — singular entity / command / event names | PASS | `license_deal`, `AttributeLicenseDealCommand`, `prm.license_deal.attributed`. URLs are plural (`/license-deals`) per routing convention |
| **FK IDs only** across modules | PASS | `attributed_agency_id`, `prospect_id`, `rfp_id` are FK IDs; no entity imports from `directory` / `rfp` modules |
| **`organization_id` mandatory on scoped entities** | PASS | `license_deal.organization_id NOT NULL` |
| **Undoability by default** | PASS | Every state-mutating command has a paired compensation (saga reverse) or explicit undo path (US4.4b) |
| **Zod validation on all API inputs** | PASS | §3 inputs are Zod discriminated unions / objects |
| **Events over direct imports** | PASS | Cross-module side effects go through events only (`prm.license_deal.status_changed` → `RfpPathBLockSubscriber`) |
| **Tenant isolation** | PASS | `/api/portal/min` resolves `agency_id` from session, never client-supplied |
| **Command Graph vs Compound Command** | PASS — Command Graph | Attribute + reverse are coupled by aggregate invariant #7; correctly modelled as a single orchestrated saga, not two independent ops |
| **Architectural Diff — no CRUD noise** | PASS | §3 documents only the two custom actions (`/attribute`, `/reverse`, `/unreverse-status`); CRUD is a one-line table |
| **Undo Contract as detailed as Execute** | PASS | §4.1 + §5.4 `WorkflowDefinition.activities[*].compensate` specified per activity |
| **Module Isolation** | PASS | Spec #6 owns RFP state transitions; this spec owns only the subscriber writing a read-model field in Spec #5's table. Cross-spec contract documented §8.4 |
| **Additive BC** | PASS | §7 table — no renames, no narrowing |
| **Domain invariants preserved** | PASS | #7 (§5.2 trigger + application), #14 (Golden Rule picker), #17 (subscriber + Spec #6 enforcement), #12 system-actor fast-forward (saga handler) |
| **Cagan business criteria bound to tests** | PASS | §9.1 (latency), §9.2 (override reasoning), §9.5 (idempotency) |
| **No custom dedupe table (OQ-017)** | PASS | §5.3 explicit — `workflows` owns saga state |

**Spec verdict: READY FOR IMPLEMENTATION**. Est. 4–5 commits:
1. `license_deal` entity + migration + CrudForm + B5 page.
2. Attribution picker widget (Golden Rule + Path A/B/C switch).
3. `WorkflowDefinition` JSON + activity handlers (forward saga) — US4.1, US4.2, US4.3.
4. Reverse saga + `/reverse` + `/unreverse-status` endpoints — US4.4, US4.4b.
5. P2 MIN widget + `/api/portal/min` + `RfpPathBLockSubscriber` — US4.5 + cross-spec contract.
