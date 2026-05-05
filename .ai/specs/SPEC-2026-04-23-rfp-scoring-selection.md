# SPEC-2026-04-23 — RFP Scoring, Selection, Lifecycle (WF4 · Phase 5b)

> **Persona:** Martin Fowler (architectural purity, domain-driven, append-only audit trail as first-class design).
> **Author:** Piotr (om-cto Spec Orchestrator), 2026-04-23.
> **Scope:** WF4 back-half — scoring, selection, challenge round, close, re-open. Spec #6 of 7.
> **Depends on:** SPEC-2026-04-23-rfp-broadcast-response.md (#5, owns RFP / RFPBroadcast / RFPResponse entities); SPEC-2026-04-23-attribution-loop.md (#3, owns `prm.license_deal.status_changed` subscriber that maintains the `is_path_b_locked` read-model field).
> **Open Questions gate:** SKIPPED — OQ-009 resolved 2026-04-23 (see `app-spec/decisions-log.md` row OQ-009). No remaining blockers.

---

## 1. Summary, Scope & Business Outcome

### 1.1 TLDR

Extends the PRM module with the back-half of the RFP workflow: scoring (manual + LLM-assisted), selection, challenge-round re-scoring, close, and client-driven re-open. Introduces one new entity — `RFPResponseScore` (append-only, version-per-re-score) — and a handful of aggregate transition methods on the Spec-#5-owned `RFP` aggregate. Ships the B7 scoring widget + selection action + close/reopen controls, and the B11 RFP-Broadcasts audit page. Wires selection fan-out notifications through the stock `notifications` module (one subscriber, two `NotificationTypeDefinition`s), and the LLM-assist through the `ai_assistant` adapter shipped by OM core (OQ-009 resolved).

### 1.2 Stories covered

| Story  | Title | Page / surface |
|---|---|---|
| US5.6  | OM PartnerOps scores an RFPResponse (manual + LLM-assisted draft) | B7 scoring widget |
| US5.7  | OM PartnerOps commits a selection, fan-out notifications | B7 selection action |
| US5.8  | AgencyAdmin updates submitted response (challenge round) — **backend subscriber side** | P10 (portal revise-CTA lives in Spec #5), this spec owns the re-open subscriber + RFPResponse state rewind |
| US5.9  | OM PartnerOps closes an RFP | B7 close action |
| US5.10 | OM PartnerOps re-opens a closed RFP (client-driven) + **hard guard invariant #17** | B7 reopen action |
| B11    | RFP Broadcasts audit page | B11 DataTable |

### 1.3 Business Outcome

> *"I score with a fair rubric, the decision is auditable, and the agency sees outcome fast."* — Mat.

Translates to:

- **Scoring latency:** median ≤ 24 h from last response to `prm.rfp.selection_made` (per Phase 5 acceptance, §7 of App Spec).
- **Auditability:** 100% of selections have `selection_reasoning` filled; 100% of submitted RFPResponses have ≥ 1 `RFPResponseScore`; all re-scores preserved (append-only — invariant #18).
- **Hard guard:** zero silent divergence between `RFP.selected_agency_id` and `LicenseDeal.attributed_agency_id` for any signed Path-B deal (invariant #17).
- **Notification delivery:** winner + non-winners informed within the same transaction batch as selection commit (no more Mat-BCC-emails).

### 1.4 Estimated commits

**4–5 atomic commits** (OQ-009 resolved):

| # | Commit | Story |
|---|---|---|
| 1 | `RFPResponseScore` entity + manual scoring widget (B7) + `prm.rfp_response.scored` event | US5.6 manual |
| 2 | LLM-assist button: `LlmProvider` wiring + prompt template + draft round-trip (no-save) | US5.6 LLM |
| 3 | Selection commit action + `prm.rfp.selection_made` / `prm.rfp.selection_changed` + notification subscriber + two `NotificationTypeDefinition` seeds | US5.7 |
| 4 | Close + Re-open actions + invariant #17 hard guard (read-model + live re-check) + `prm.rfp.closed` / `prm.rfp.reopened_for_scoring` / `prm.rfp_response.available_for_revision` subscriber | US5.8 + US5.9 + US5.10 |
| 5 | B11 RFP Broadcasts audit page + scheduled job for reopened-deadline expiry | B11 + deadline job |

Upper bound 5 matches the range allocated in `specs/README.md` row 6.

---

## 2. Technical Approach (Piotr)

> Embedded verbatim from the decomposition brief. This is the contract with the decomposer; the rest of the spec elaborates — it does not override.

- **Mode:** Extend PRM module (same module as Spec #5) with scoring + selection + lifecycle mechanisms. No core modifications. Scoring widget as custom on B7 CrudForm. Reuses `ai_assistant` adapter (OQ-009 resolved).
- **New entity (this spec owns):**
  - `RFPResponseScore` (append-only versioned; `rfp_response_id` FK, `version` integer auto-incrementing per response, `scored_by_user_id` FK, `tech_fit_score` integer 0–5, `domain_fit_score` integer 0–5, `optional_score` integer 0–5 nullable, `reasoning` text — required, `source` enum `manual` / `llm_assisted`, `llm_model_id` nullable string, `created_at` timestamp). **Invariant #18: append-only, never updated or deleted. Each re-score inserts a new row with incremented version.** Current score = max version per `rfp_response_id`.
- **Extends Spec #5:** writes `RFP.status` transitions `published → scoring`, `scoring → selected`, `selected → closed`, `selected → reopened`, `reopened → scoring`, `reopened → closed`. Enforced via Spec #5's state-machine invariant #16 — this spec invokes the aggregate transition methods.
- **US5.6 Score RFPResponse (B7 scoring widget, manual baseline = 3 commits):**
  - Custom widget on B7 CrudForm rendered per submitted RFPResponse in the RFP detail page.
  - Form: three score inputs (Tech Fit /5, Domain Fit /5, optional /5 with checkbox "include optional") + reasoning textarea (required).
  - On submit: inserts new `RFPResponseScore` row with incremented version. Emits `prm.rfp_response_score.recorded` with version number.
  - Re-score: submitting again inserts v+1. UI displays history (latest + prior versions collapsed).
  - RFP auto-transitions `published → scoring` on first score recorded.
- **US5.6 LLM-assist (OQ-009 resolved — +1 commit):**
  - "Draft score with AI" button on the scoring widget.
  - Reads `LlmProvider` from DI (`packages/shared/src/lib/ai/llm-provider.ts`), calls `createModel()` to get an AI SDK model instance.
  - Prompt template composed from RFP brief + RFPResponse markdown + rubric criteria (tech-fit definition, domain-fit definition, optional definition) — structured output schema returning `{ tech_fit_score, domain_fit_score, optional_score, reasoning }`.
  - User reviews + edits before saving — LLM never auto-saves. Saved score has `source = 'llm_assisted'` + `llm_model_id` captured.
  - Reuses `inbox_ops` integration pattern — this is not novel infra, just a new prompt template + one adapter call.
- **US5.7 Commit selection:**
  - Backend action on B7 "Select winner" → pops list of scored RFPResponses sorted by latest-version total descending.
  - OMPartnerOps picks one → required `selection_reasoning` textarea → transitions RFP `scoring → selected`, writes `RFPResponse.status = 'selected'` on the winner + `'not_selected'` on everyone else.
  - Emits `prm.rfp.selection_made` with `winner_agency_id`, `winner_rfp_response_id`, `selection_reasoning`.
  - **Notification fan-out (OQ-015):** seed two `NotificationTypeDefinition` rows: `prm.rfp.selected` (to winner PartnerAdmins) + `prm.rfp.not_selected` (to other respondent PartnerAdmins). ONE subscriber dispatching per-recipient via `buildBatchNotificationFromType`. 1 commit total per OQ-015.
  - Idempotent selection: if already selected, re-selection first unwinds prior winner (emits `prm.rfp.selection_changed` with prior+new) before committing — append-only event stream.
- **US5.8 Challenge-round update subscriber:**
  - On `prm.rfp.reopened_for_scoring` (emitted by US5.10), for each RFPResponse linked to the re-opened RFP, a subscriber resets `RFPResponse.status = 'submitted'` (from `selected` / `not_selected`) allowing the agency to revise. Emits `prm.rfp_response.available_for_revision`. Spec #5's P10 renders the revise CTA based on this state.
  - Time-bounded: new `reopened_deadline_at` on RFP; after deadline, RFP auto-transitions back to `scoring` (via scheduled job or on-read enforcement — pick scheduled job for correctness).
- **US5.9 Close RFP:** backend action → transition `selected → closed` OR `scoring → closed` (no selection) OR `reopened → closed`. Emits `prm.rfp.closed`. Terminal state.
- **US5.10 Re-open RFP (client-driven) + HARD GUARD invariant #17:**
  - Backend action; preconditions check:
    - RFP must be in `selected` or `closed` state.
    - **HARD GUARD:** query LicenseDeals where `attribution_path = 'B' AND rfp_id = this.id AND status >= 'signed'`. If any exist, block with error "This RFP has a signed LicenseDeal (Path B) — cannot re-open; use US4.4b status-reversal first."
    - This check reads the `is_path_b_locked` read-model field on RFP (maintained by Spec #3's subscriber on `prm.license_deal.status_changed`). Defence-in-depth: also re-query LicenseDeals live before committing the transition.
  - On success: transition `selected → reopened` (or `closed → reopened`); emits `prm.rfp.reopened_for_scoring`. Subscriber from US5.8 activates.
- **B11 RFP Broadcasts audit page:** standard `DataTable` per RFP showing RFPBroadcast rows with columns: Agency, Broadcast at, First opened at, Declined at + reason, Response status, Final outcome (selected / not_selected). Read-only.
- **Cross-spec invariants:**
  - Spec #3 owns the subscriber that maintains `RFP.is_path_b_locked`. This spec READS it + does live re-check. Contract documented both sides.
  - Spec #5 owns the RFP / RFPBroadcast / RFPResponse entities. This spec reads + writes those aggregates' state via exposed transition methods, does NOT duplicate the entity definitions.
- **Rationale:** Append-only score versioning (invariant #18) is the audit-trail backbone. `ai_assistant` adapter turns a hand-wavy "LLM-assist" into a 1-commit add. `notifications` module compresses 2 notify stories (selected / not_selected) into 1 commit via shared subscriber.

### 2.1 Fowler-lens commentary

Three architectural notes the embedded brief leaves implicit:

1. **Append-only versioning is an undo primitive, not a replacement for one.** Principle #8 (Undoability) asks: "how is the state reversed?" For scoring, the answer is **insert v+1 that supersedes** — not UPDATE, not DELETE. This preserves the audit trail invariant #18 demands while giving OM PartnerOps effective "undo" semantics ("I mis-scored; correct it by recording v+1 with the right numbers and a change-reason"). We document this explicitly in §10.1 because it is a deviation from the default Command-Pattern undo and the compliance reviewer should know we chose it deliberately.
2. **Selection is a coupled graph save.** Committing a selection simultaneously: (a) transitions `RFP.status`, (b) writes `RFP.selected_agency_id` + `selection_reasoning` + decided-at/by, (c) sets the winning `RFPResponse.status = 'selected'`, (d) sets all other responses' `status = 'not_selected'`, (e) emits `prm.rfp.selection_made`. This is **one transaction, one command, one aggregate boundary** — not five independent mutations. `SelectRFPWinnerCommand` owns this as a coupled graph save per the Command-Graph-vs-Independent-Ops rule.
3. **The hard-guard is defence-in-depth, not redundancy.** The `is_path_b_locked` read-model is eventually consistent — Spec #3's subscriber on `prm.license_deal.status_changed` may lag by 100ms-ish. Re-open is rare and dangerous; we pay the cost of a second live query before committing the `closed → reopened` transition. **Read-model for display + cheap guard; live query for correctness at commit.** This is standard CQRS hygiene, documented as a risk mitigation in §8.

---

## 3. API Contracts

All routes live under `/api/backend/prm/rfps/...` and require an authenticated `User` (OM PartnerOps) with the feature flag indicated in §6. Requests and responses are JSON. Zod schemas live at `packages/prm/src/modules/prm/api/schemas/` alongside the existing Spec #5 schemas.

### 3.1 Record a score (manual or LLM-assisted commit)

- **Method + path:** `POST /api/backend/prm/rfps/{rfp_id}/responses/{response_id}/score`
- **Auth:** User, feature `prm.rfp.score`.
- **Request body (Zod):**

  ```ts
  const RecordScoreRequest = z.object({
    tech_fit_score: z.number().int().min(0).max(5),
    domain_fit_score: z.number().int().min(0).max(5),
    optional_score: z.number().int().min(0).max(5).nullable(),
    include_optional: z.boolean(),
    reasoning: z.string().min(10).max(8000),
    source: z.enum(['manual', 'llm_assisted']),
    llm_model_id: z.string().max(256).nullable(),
    // Required when recording version > 1 (enforced server-side against existing rows)
    change_reason: z.string().min(5).max(2000).optional(),
  }).refine(
    (d) => d.source === 'manual' ? d.llm_model_id === null : d.llm_model_id !== null,
    { message: 'llm_model_id must be present iff source = llm_assisted' },
  );
  ```

- **Response 200:**

  ```ts
  {
    rfp_response_score_id: string,
    version: number,               // incremented per response
    total_score: number,           // tech + domain (+ optional if included)
    rfp_status: 'scoring',         // auto-transitions published → scoring on first score
  }
  ```

- **Failure modes:**
  - `400 VALIDATION_ERROR` — Zod failure, missing `reasoning`, etc.
  - `409 CHANGE_REASON_REQUIRED` — re-score (v > 1) without `change_reason`.
  - `409 RFP_NOT_ACCEPTING_SCORES` — RFP in `closed` state (or unexpected state machine position).
  - `404 RESPONSE_NOT_FOUND` — response doesn't belong to this RFP, or isn't `submitted`.

### 3.2 LLM draft (no save)

- **Method + path:** `POST /api/backend/prm/rfps/{rfp_id}/responses/{response_id}/score/draft-llm`
- **Auth:** User, feature `prm.rfp.score`.
- **Request body:** `{}` (empty; server composes the prompt from the RFP + RFPResponse).
- **Response 200:**

  ```ts
  {
    tech_fit_score: number,        // 0..5
    domain_fit_score: number,      // 0..5
    optional_score: number | null, // null if RFP has no optional dimension
    reasoning: string,
    llm_model_id: string,          // e.g. "anthropic:claude-sonnet-4"
  }
  ```

- **Side effects:** **none** — this endpoint is idempotent and does not write. The UI displays the draft and the OMPartnerOps user must separately call §3.1 to commit.
- **Failure modes:**
  - `503 LLM_UNAVAILABLE` — adapter threw; UI falls back to manual-only mode.
  - `429 LLM_RATE_LIMITED` — adapter rate limit; retry after `retry_after_seconds`.
  - `400 RESPONSE_NOT_SUBMITTED` — cannot draft for a `draft` / `withdrawn` response.

### 3.3 Commit selection

- **Method + path:** `POST /api/backend/prm/rfps/{rfp_id}/select`
- **Auth:** User, feature `prm.rfp.select`.
- **Request body:**

  ```ts
  const SelectWinnerRequest = z.object({
    winner_rfp_response_id: z.string().uuid(),
    selection_reasoning: z.string().min(10).max(8000),
  });
  ```

- **Response 200:**

  ```ts
  {
    rfp_id: string,
    winner_agency_id: string,
    winner_rfp_response_id: string,
    rfp_status: 'selected',
    runners_up_agency_ids: string[],
    is_reselection: boolean,       // true when prior winner existed
  }
  ```

- **Failure modes:**
  - `409 NO_SCORED_RESPONSES` — cannot select when zero RFPResponses have a score.
  - `409 WINNER_NOT_SCORED` — specified `winner_rfp_response_id` has no `RFPResponseScore` rows.
  - `409 PATH_B_SIGNED_DEAL_LOCK` — invariant #17: a signed Path-B LicenseDeal exists on this RFP, re-selection blocked.

### 3.4 Close RFP

- **Method + path:** `POST /api/backend/prm/rfps/{rfp_id}/close`
- **Auth:** User, feature `prm.rfp.close`.
- **Request body:**

  ```ts
  const CloseRequest = z.object({
    close_reason: z.string().min(5).max(2000).optional(), // required if RFP has no selection
  });
  ```

- **Response 200:** `{ rfp_id, rfp_status: 'closed', final_selected_agency_id: string | null }`.
- **Failure modes:**
  - `409 INVALID_STATE_TRANSITION` — RFP not in `scoring` / `selected` / `reopened`.
  - `400 CLOSE_REASON_REQUIRED` — closing without a selection requires a reason.

### 3.5 Re-open RFP (client-driven)

- **Method + path:** `POST /api/backend/prm/rfps/{rfp_id}/reopen`
- **Auth:** User, feature `prm.rfp.reopen`.
- **Request body:**

  ```ts
  const ReopenRequest = z.object({
    reopen_reason: z.string().min(10).max(2000),
    reopened_deadline_at: z.string().datetime(), // ISO-8601; must be in the future
  });
  ```

- **Response 200:** `{ rfp_id, rfp_status: 'reopened', reopened_deadline_at }`.
- **Failure modes:**
  - `409 INVALID_STATE_TRANSITION` — RFP not in `selected` / `closed`.
  - `409 PATH_B_SIGNED_DEAL_LOCK` — **hard guard** (invariant #17); message: `"Cannot reopen: LicenseDeal {license_deal_id} attributed to this RFP is already signed. Use US4.4b status-reversal first."`
  - `400 DEADLINE_IN_PAST` — `reopened_deadline_at` not in the future.

### 3.6 RFP Broadcasts audit (B11)

- **Method + path:** `GET /api/backend/prm/rfps/{rfp_id}/broadcasts`
- **Auth:** User, feature `prm.rfp.read` (existing, owned by Spec #5).
- **Query params:** `?page=1&pageSize=50&sort=broadcast_at.desc`.
- **Response 200:**

  ```ts
  {
    items: Array<{
      broadcast_id: string,
      agency_id: string,
      agency_name: string,             // joined
      broadcast_at: string,
      first_opened_at: string | null,
      declined_at: string | null,
      declined_reason: string | null,
      response_status: 'none' | 'draft' | 'submitted' | 'withdrawn' | 'selected' | 'not_selected',
      final_outcome: 'selected' | 'not_selected' | 'no_decision',
    }>,
    total: number,
    page: number,
    pageSize: number,
  }
  ```

- **No write endpoints on B11** — read-only audit.

---

## 4. Commands & Events

### 4.1 Commands (undoable per Principle #8)

| Command | Coupling | Undo contract |
|---|---|---|
| `RecordRFPResponseScoreCommand` | Independent (single aggregate, single insert) | **Append-only via v+1 insert** — no in-place undo. To correct a mis-score, OMPartnerOps submits a new score with the corrected numbers + `change_reason`. Rationale in §10.1. |
| `SelectRFPWinnerCommand` | **Graph save** (RFP + all RFPResponses + event) | Undo = `ReopenRFPCommand` (which sets winner response back to `submitted` via US5.8 subscriber) **plus** a compensating notification (`prm.rfp.selection_changed`) that tells both the prior winner and the now-winner of the change. |
| `CloseRFPCommand` | Independent (single RFP aggregate state change) | Undo = `ReopenRFPCommand` — **with the invariant #17 hard guard running on the reopen path, not the close path**. Rationale: closing is always safe; it's reopening that must check. |
| `ReopenRFPCommand` | Independent; carries read-model consultation + live Path-B guard | Undo = `CloseRFPCommand` (same RFP, state-machine bounce back). Note: the `reopened_deadline_at` is cleared on re-close. |

**Note on `SelectRFPWinnerCommand` graph save:** this command writes to the `RFP` aggregate AND to every `RFPResponse` row on that RFP in a single transaction. The responses live inside the RFP aggregate boundary for this transition — they are not independent siblings. This is documented to justify why §3.3 is one endpoint, not five.

### 4.2 Events emitted

All events under the `prm.*` namespace. Schemas stored at `packages/prm/src/modules/prm/data/events.ts`.

| Event | Payload | Emitted by |
|---|---|---|
| `prm.rfp_response_score.recorded` | `{ rfp_response_score_id, rfp_id, rfp_response_id, agency_id, version, tech_fit_score, domain_fit_score, optional_score, total_score, source, llm_model_id, scored_by_user_id, change_reason? }` | §3.1 success |
| `prm.rfp.selection_made` | `{ rfp_id, winner_agency_id, winner_rfp_response_id, runners_up_agency_ids: string[], selection_reasoning, decided_by_user_id }` | §3.3 first-time select |
| `prm.rfp.selection_changed` | `{ rfp_id, from_agency_id, to_agency_id, from_rfp_response_id, to_rfp_response_id, reason, changed_by_user_id }` | §3.3 re-select (replaces a prior winner) |
| `prm.rfp.closed` | `{ rfp_id, closed_by_user_id, final_selected_agency_id: string \| null, close_reason? }` | §3.4 |
| `prm.rfp.reopened_for_scoring` | `{ rfp_id, trigger: 'client_reopen' \| 'challenge_round', reopened_by_user_id?, reopened_deadline_at }` | §3.5 (and by challenge-round response-update path in Spec #5, not here) |
| `prm.rfp_response.available_for_revision` | `{ rfp_response_id, rfp_id, agency_id, prior_status: 'selected' \| 'not_selected', reopened_deadline_at }` | US5.8 subscriber (this spec) on each affected response |

**Naming reconciliation with App Spec §1.4.5:** the App Spec uses `prm.rfp_response.scored` (line 538) and `prm.rfp.reopened_for_scoring` (line 539). We adopt `prm.rfp_response_score.recorded` because the payload is a row on the `RFPResponseScore` aggregate, not on `RFPResponse`. This is a deliberate refinement — the App Spec name was written before the entity was split off. Both events are emitted on the same commit; we keep the App-Spec-named event as an alias in `events.ts` for the duration of v1 to avoid a breaking change should any subscriber already bind to the old name. **This is a cross-spec concern — flagged to Spec #5 authors.**

### 4.3 Subscribers in this spec

| Subscriber | Binds to | Action |
|---|---|---|
| `SelectionNotificationDispatcher` | `prm.rfp.selection_made`, `prm.rfp.selection_changed` | For each respondent agency, resolve `PartnerAdmin` recipients and call `buildBatchNotificationFromType('prm.rfp.selected' \| 'prm.rfp.not_selected', variables)`. **One subscriber, two type defs.** (OQ-015.) |
| `ChallengeRoundRevisionUnlocker` | `prm.rfp.reopened_for_scoring` | For each `RFPResponse` on the RFP, reset `status = 'submitted'`, emit `prm.rfp_response.available_for_revision`. |
| `ReopenedDeadlineExpiryJob` | scheduled (cron: every 15 min) | Finds RFPs where `status = 'reopened' AND reopened_deadline_at < now()`, transitions back to `scoring` (no selection change), emits `prm.rfp.reopened_deadline_expired`. |

---

## 5. Data Models

### 5.1 New table: `rfp_response_scores` (this spec owns)

```sql
CREATE TABLE rfp_response_scores (
  id                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID            NOT NULL,                   -- tenant isolation per Singularity Law
  rfp_response_id      UUID            NOT NULL REFERENCES rfp_responses(id) ON DELETE RESTRICT,
  version              INTEGER         NOT NULL,                   -- 1, 2, 3, ... per rfp_response_id
  scored_by_user_id    UUID            NOT NULL REFERENCES users(id),
  tech_fit_score       SMALLINT        NOT NULL CHECK (tech_fit_score BETWEEN 0 AND 5),
  domain_fit_score     SMALLINT        NOT NULL CHECK (domain_fit_score BETWEEN 0 AND 5),
  optional_score       SMALLINT            NULL CHECK (optional_score IS NULL OR optional_score BETWEEN 0 AND 5),
  include_optional     BOOLEAN         NOT NULL DEFAULT FALSE,
  reasoning            TEXT            NOT NULL CHECK (char_length(reasoning) >= 10),
  source               TEXT            NOT NULL CHECK (source IN ('manual', 'llm_assisted')),
  llm_model_id         TEXT                NULL,                   -- required iff source = 'llm_assisted'
  change_reason        TEXT                NULL,                   -- required iff version > 1 (enforced at command, not DB, to keep ORM-level append-only simple)
  created_at           TIMESTAMPTZ     NOT NULL DEFAULT now(),

  UNIQUE (rfp_response_id, version),
  CHECK ((source = 'manual' AND llm_model_id IS NULL) OR (source = 'llm_assisted' AND llm_model_id IS NOT NULL))
);

CREATE INDEX idx_rfp_response_scores_response     ON rfp_response_scores(rfp_response_id, version DESC);
CREATE INDEX idx_rfp_response_scores_organization ON rfp_response_scores(organization_id);
```

**Append-only enforcement (invariant #18):** no DB trigger. Enforced at the ORM layer:
- MikroORM `@Entity()` exposes `insert` only — no `update`, no `remove`.
- Repository exposes `insertNextVersion(rfpResponseId, payload)` as the only write path.
- A thin wrapper around MikroORM's `EntityManager` rejects any UPDATE / DELETE attempt on this table and logs a diagnostic `prm.audit.append_only_violation_attempted` event.

Rationale for ORM-level (not DB-trigger) enforcement: keeps the audit-log concern in the language the team lives in (TypeScript), avoids a divergent DB-permission model across local / staging / prod, and allows the spec author to add new fields (e.g., if v2 adds a 4th score dimension) without needing a DB migration to update the trigger. The tradeoff is a non-ORM caller (e.g., a future DB migration script) could technically violate the invariant — we accept this and document it in §7.

### 5.2 Additive column on `rfps` table (owned by Spec #5, ADDED here)

```sql
ALTER TABLE rfps
  ADD COLUMN reopened_deadline_at TIMESTAMPTZ NULL;
```

- **NULL** when RFP is not in `reopened` state.
- **Set** by §3.5 re-open commit.
- **Cleared** by the `ReopenedDeadlineExpiryJob` on auto-transition back to `scoring`, and by §3.4 re-close.

**Migration ownership decision (flagged explicitly):** this migration ships with **this spec**, not Spec #5. Reasons:
1. Spec #5 is already committed when Spec #6 starts (per implementation order).
2. The column is only used by US5.10 (this spec) — additive to Spec #5's entity but not referenced by any of Spec #5's code paths.
3. The Entity class is in Spec #5's package (`packages/prm/src/modules/prm/data/entities.ts`), so Spec #6's migration will add both the column AND the `@Property({ nullable: true }) reopenedDeadlineAt?: Date;` field declaration via the standard "follow-up spec can extend earlier spec's entity" pattern (non-breaking, additive, nullable).

This is called out again in §7 Backward Compatibility because it crosses a spec boundary.

### 5.3 New column on `rfps`: `is_path_b_locked` (owned by Spec #3)

Not owned by this spec — read-only here. Spec #3's attribution-saga subscriber on `prm.license_deal.status_changed` flips this boolean based on whether any LicenseDeal with `rfp_id = this.id AND status >= 'signed'` exists. This spec's re-open hard guard reads this field for a cheap check, then re-queries `license_deals` live before committing. Cross-spec contract documented in §8 risks.

### 5.4 Read-model views (optional, for B11 and scoring widget)

A SQL view `vw_rfp_response_latest_scores` exposes `(rfp_response_id, latest_version, total_score, source, scored_at)` — `SELECT DISTINCT ON (rfp_response_id) ...`. Used by B7 scoring widget's "ranking view" and by B11 for the `response_status` / `final_outcome` columns. Defined in the same migration as §5.1.

---

## 6. Access Control

### 6.1 New features (seeded in PRM `setup.ts`)

| Feature ID | Assignable to | Grants |
|---|---|---|
| `prm.rfp.score`  | `OM PartnerOps`, `OM Admin` | POST `/score`, POST `/score/draft-llm` |
| `prm.rfp.select` | `OM PartnerOps`, `OM Admin` | POST `/select` |
| `prm.rfp.close`  | `OM PartnerOps`, `OM Admin` | POST `/close` |
| `prm.rfp.reopen` | `OM PartnerOps`, `OM Admin` | POST `/reopen` (with hard-guard) |

### 6.2 Reads by PartnerAdmin / PartnerMember (agency-side)

- **RFPResponseScore:** PartnerAdmin of the owning agency can READ their own agency's score rows **once** `RFP.status ∈ {selected, closed, reopened}` — routed through Spec #5's existing `GET /api/portal/rfps/{id}/response` endpoint (which this spec extends the response-enricher for, not a new route).
- **B11 audit:** OM staff only. PartnerAdmins do NOT see other agencies' broadcast rows ever (invariant #15).

### 6.3 Cross-agency visibility rule

Enforced at ACL layer; tests in §9.4.

---

## 7. Backward Compatibility

### 7.1 Additive-only checklist

- **New table `rfp_response_scores`** — no existing code reads from it; additive.
- **New column `rfps.reopened_deadline_at`** — nullable, default NULL; existing Spec #5 code paths don't touch it; additive. **Cross-spec coordination: confirmed with Spec #5 authors that the `RFP` MikroORM entity gains the new `@Property({ nullable: true })` declaration in this spec's PR, not in Spec #5's.**
- **New events** (`prm.rfp_response_score.recorded`, `prm.rfp.selection_made`, `prm.rfp.selection_changed`, `prm.rfp.closed`, `prm.rfp.reopened_for_scoring`, `prm.rfp_response.available_for_revision`) — no prior subscribers; additive.
- **New API routes** — all under `/api/backend/prm/rfps/...` new sub-paths; no existing route changes.
- **Read-enricher extension** on Spec #5's `GET /api/portal/rfps/{id}/response` — adds a `scores: Array<{ version, total_score, source, ... }>` field to the response payload when `RFP.status ∈ {selected, closed, reopened}` and `userFeatures` includes `prm.rfp.read_own_score`. Adding a new nullable field to a JSON response is additive per our BC rules.

### 7.2 BC risks

- **Event-name alias for `prm.rfp_response.scored` vs `prm.rfp_response_score.recorded`** (see §4.2) — we ship both for v1; new subscribers should bind to `prm.rfp_response_score.recorded`; old name deprecated in v2.
- **Append-only ORM enforcement** (§5.1) — a non-ORM writer (e.g. raw SQL migration script) could violate invariant #18. Documented, accepted, CI integration test in §9 checks UPDATE is rejected at ORM level.

### 7.3 No breaking changes

Confirmed against:
- Spec #1 (agency foundation) — no intersection.
- Spec #5 (RFP broadcast + response) — intersection is the `RFP` entity (additive column) and the `RFPResponse.status` enum (we read-write existing values, add no new states; the `selected` / `not_selected` values already exist in Spec #5).

---

## 8. Risks & Impact Review

### 8.1 Critical risks

| Risk | Mitigation |
|---|---|
| **Invariant #17 live re-check is load-bearing.** The read-model `RFP.is_path_b_locked` maintained by Spec #3 may lag; a re-open committed between the subscriber's lag window and the true Path-B signing could silently diverge. | §3.5 re-open endpoint runs **both** the read-model check (cheap, fast-fail) **and** a live `SELECT EXISTS (... license_deals WHERE rfp_id = $1 AND status IN ('signed', 'active'))` inside the same transaction as the `closed → reopened` transition. Integration test in §9.3 forces a lagged read-model and verifies the live query catches it. |
| **Re-selection unwind correctness.** If `SelectRFPWinnerCommand` is re-fired with a different winner, the prior winner's `RFPResponse.status` must transition from `selected` back through `submitted`(?) or straight to `not_selected`. | Decision: prior winner goes **directly to `not_selected`** — they were in the response pool, they just aren't the winner anymore. We do NOT bounce through `submitted` (that would confuse the agency into thinking the round reopened). `prm.rfp.selection_changed` is emitted with from/to response IDs so the notification subscriber can send the right message. |
| **LLM cost bound.** Each `draft-llm` call consumes tokens. An OM PartnerOps could spam the button. | Per-request token cap enforced in the prompt template wrapper (`maxTokens: 4096` on the structured-output call). Per-user rate limit: 10 draft calls per minute, enforced at the route handler via the existing middleware pattern from `inbox_ops`. |
| **`ReopenedDeadlineExpiryJob` reliability.** If the cron runs but fails silently, RFPs could linger in `reopened` indefinitely. | Job emits `prm.rfp.reopened_deadline_expired` on success and logs to `opscope` on failure. Observability dashboard alert: "any RFP in `reopened` state with `reopened_deadline_at < now() - 1 hour`". |
| **Challenge-round UX timing in Spec #5.** Spec #5's P10 portal page renders a "revise response" CTA based on the `prm.rfp_response.available_for_revision` event. If Spec #5 ships before this spec, the CTA will never appear. | Acceptable: Spec #5 ships the CTA wired to the correct RFPResponse.status value (`submitted` when it was previously `selected` / `not_selected`), and Spec #6's subscriber flips the status. No cross-spec code dependency, just sequencing. |

### 8.2 Non-critical risks

- **LLM draft bias.** An LLM draft can anchor OM PartnerOps to a wrong score. Mitigation: UX requires explicit review + edit before commit; the `source` field telemeters `llm_assisted` vs `manual` for quality review per App Spec §3 WF4 step 6 and edge case 8.
- **`selection_reasoning` quality.** OM PartnerOps could type "because" and ship. Mitigation: min length 10 chars. Enforcement of "evidence-cited reasoning" quality is a PartnerOps discipline matter, not a technical constraint.
- **Score idempotency.** The `POST /score` endpoint is not idempotent-via-header (no `Idempotency-Key`) — double-submit will produce v and v+1 with identical contents. Accepted: the double-submit is itself audit-visible, and OMPartnerOps can re-score to the correct value. Future spec (v2) could add dedupe-by-content-hash.

### 8.3 Impact review

- **Phase 5 acceptance criteria (§7 of App Spec):** this spec closes invariants #17 and #18, the `selection_changed` idempotency requirement, and the state machine #16 coverage for the `scoring / selected / closed / reopened` transitions.
- **Impact on Spec #3 (attribution loop):** none — Spec #3 emits events this spec subscribes indirectly to (via Spec #3's read-model write). No code changes in Spec #3's package.
- **Impact on Spec #5:** one additive column + one entity-class field declaration (documented in §5.2 and §7.1).
- **Impact on Spec #7 (case studies):** none.

---

## 9. Integration Test Coverage

Tests live at `packages/prm/integration-tests/rfp-scoring/` and use Playwright + the API-test harness (per SPEC-053b pattern).

### 9.1 Scoring happy paths

- **IT-SCORE-01:** RFP in `published` with 3 submitted responses → OM PartnerOps scores response A → RFP auto-transitions to `scoring`; scores for B and C still absent. `prm.rfp_response_score.recorded` emitted with `version: 1`.
- **IT-SCORE-02:** Re-score response A → v2 inserted with `change_reason`. v1 still fetchable via the "history" collapsed view. `prm.rfp_response_score.recorded` emitted with `version: 2`.
- **IT-SCORE-03:** Re-score response A **without** `change_reason` → 409 `CHANGE_REASON_REQUIRED`; no row inserted.
- **IT-SCORE-04:** Append-only verification: ORM-level UPDATE attempt on an existing score row throws and logs `prm.audit.append_only_violation_attempted`.

### 9.2 LLM-assist

- **IT-LLM-01:** Mock `LlmProvider.createModel()` to return a deterministic structured-output `{ tech_fit_score: 4, domain_fit_score: 3, optional_score: null, reasoning: "…" }`. Call `POST /score/draft-llm` → returns the values; no row inserted. Then call `POST /score` with the same values + `source: 'llm_assisted'` + `llm_model_id: 'anthropic:claude-sonnet-4-test'` → row inserted, `source` and `llm_model_id` captured correctly.
- **IT-LLM-02:** Mock `LlmProvider.createModel()` to throw → `POST /score/draft-llm` returns 503; UI (Playwright) verifies the LLM button disables and a manual-fallback message shows.
- **IT-LLM-03:** Rate-limit test: 11 rapid draft calls from the same user → 11th returns 429 with `retry_after_seconds`.

### 9.3 Selection + hard guard

- **IT-SELECT-01:** 3 scored responses → `POST /select` with response A → RFP transitions `scoring → selected`; A becomes `selected`, B and C become `not_selected`. `prm.rfp.selection_made` emitted once. Two `buildBatchNotificationFromType` calls made (1x `prm.rfp.selected` to A's PartnerAdmins, 1x `prm.rfp.not_selected` to B + C PartnerAdmins).
- **IT-SELECT-02:** Re-selection: after IT-SELECT-01, `POST /select` with response B → `prm.rfp.selection_changed` emitted (NOT `prm.rfp.selection_made`); A becomes `not_selected`, B becomes `selected`. Notification dispatcher sends updated outcomes.
- **IT-SELECT-03:** `POST /select` with zero scored responses → 409 `NO_SCORED_RESPONSES`.
- **IT-GUARD-01:** **Critical — invariant #17.** Setup: create a LicenseDeal with `rfp_id = X AND status = 'signed'` via Spec #3 test harness. Ensure `RFP.is_path_b_locked = true` propagates via Spec #3's subscriber. `POST /rfps/X/reopen` → 409 `PATH_B_SIGNED_DEAL_LOCK` with the documented error message referencing the license deal ID.
- **IT-GUARD-02:** **Live re-check.** Setup: create LicenseDeal with `status = 'signed'` AND simultaneously mutate the `is_path_b_locked` read-model to `false` (simulating subscriber lag). `POST /rfps/X/reopen` → STILL 409 because the live `SELECT EXISTS` fires inside the transaction and catches it.

### 9.4 Close / reopen / challenge round

- **IT-CLOSE-01:** RFP in `selected` → `POST /close` → transitions to `closed`; `prm.rfp.closed` emitted with `final_selected_agency_id` set.
- **IT-CLOSE-02:** RFP in `scoring` with zero selections → `POST /close` with `close_reason` → transitions to `closed`; `final_selected_agency_id` is null.
- **IT-REOPEN-01:** RFP in `selected` → `POST /reopen` with `reopened_deadline_at = now() + 7d` → transitions to `reopened`. `ChallengeRoundRevisionUnlocker` subscriber fires → each RFPResponse.status flips from `selected` / `not_selected` back to `submitted`; `prm.rfp_response.available_for_revision` emitted once per response. Playwright: P10 portal shows the "revise response" CTA for the affected agency.
- **IT-REOPEN-02:** `ReopenedDeadlineExpiryJob` test: RFP in `reopened` with `reopened_deadline_at = now() - 1s` → run scheduled job → RFP transitions to `scoring`; `prm.rfp.reopened_deadline_expired` emitted.
- **IT-REOPEN-03:** `POST /reopen` with `reopened_deadline_at` in the past → 400 `DEADLINE_IN_PAST`.

### 9.5 B11 audit page

- **IT-B11-01:** Seed RFP with 5 broadcasts, 3 responses, 1 selection → `GET /rfps/{id}/broadcasts` returns all 5 rows with correct `response_status` + `final_outcome` enrichment. Playwright verifies B11 DataTable renders the columns correctly.

### 9.6 Cross-spec integration

- **IT-XSPEC-01:** Coordinated with Spec #3 author: run Spec #3's LicenseDeal attribution saga test suite with a Path-B signed deal, then attempt Spec #6's reopen — assert the hard guard blocks. Shared test fixture at `packages/prm/integration-tests/fixtures/path-b-signed-deal.ts`.
- **IT-XSPEC-02:** Coordinated with Spec #5 author: after IT-REOPEN-01, portal-side P10 Playwright test verifies the "revise response" CTA appears for each affected agency.

---

## 10. Final Compliance Report (Piotr Decision Library checklist)

| # | Principle | Status | Notes |
|---|---|---|---|
| 1 | **Command-Graph vs Independent Ops** | PASS | `SelectRFPWinnerCommand` is a graph save (RFP + all RFPResponses + event); documented in §2.1 and §4.1. Other three commands are Independent Ops. |
| 2 | **Architectural Diff** | PASS | Spec avoids re-documenting standard `CrudForm` / `DataTable` scaffolding for B11 — calls it out as "standard DataTable" in §1.2 and links to the App Spec table. Custom mechanisms (scoring widget, selection action, hard-guard, append-only, LLM-assist) get the ink. |
| 3 | **Singularity Law** | PASS | Table `rfp_response_scores` (plural table name, singular entity `RFPResponseScore`). Feature IDs singular (`prm.rfp.score`). Event names singular aggregate: `prm.rfp_response_score.recorded`. Commands singular (`RecordRFPResponseScoreCommand`). |
| 4 | **Organization / Tenant ID** | PASS | `rfp_response_scores.organization_id UUID NOT NULL` + index. Explicit in §5.1. |
| 5 | **FK IDs only for cross-module links** | PASS | `rfp_response_id`, `scored_by_user_id` are FK UUIDs. No cross-module ORM references. |
| 6 | **Zod validation for all API inputs** | PASS | Every endpoint in §3 has a Zod schema literal. |
| 7 | **Undo Contract** | PASS WITH DEVIATION | See §10.1 below. Documented deliberately. |
| 8 | **Event Bus for side effects** | PASS | Selection notification dispatch is a subscriber, not an inline mutation. Challenge-round revision unlock is a subscriber. No direct cross-module imports. |
| 9 | **Singular append-only audit trail for versioned domain state** | PASS | `RFPResponseScore` follows invariant #18 via ORM-level `insertNextVersion`-only repository. |
| 10 | **Backward compatibility: additive only** | PASS | §7 confirms: new table, nullable column, new events, new routes, new read-enricher output field. No breaking changes to Spec #5. |

### 10.1 Deviation note — Append-only versioning vs Command-Pattern undo (Principle #8)

The Piotr Decision Library defines undo as "how state is reversed." For most commands, this is implemented via the Command Pattern: the command's compensating action literally reverses the mutation. For `RecordRFPResponseScoreCommand`, **we deliberately chose append-only version-bumping over in-place reversal.**

Why this is a cleaner alternative:

1. **Invariant #18 requires it.** The App Spec mandates that score history never mutates. Any undo via UPDATE or DELETE would violate the invariant, so Command-Pattern undo is physically unavailable.
2. **"Undo" at the domain level is still achievable** — by inserting a new v+1 with corrected values and a `change_reason` that documents "undoing v_n because …". This gives the OMPartnerOps the effective undo experience while preserving the audit trail.
3. **The append-only pattern composes better with the challenge-round workflow.** Challenge round is semantically "we're going to re-score because the agency added new evidence," which IS exactly a v+1 insert with a change reason. Having the happy path and the undo path share mechanics is architectural economy.

We document this deviation here so the compliance reviewer sees it, agrees it's deliberate, and doesn't regress us in a future refactor toward UPDATE-based correction.

### 10.2 Compliance Gate conclusion

**All 10 principles satisfied; 1 documented deviation on Principle #8 with explicit rationale.** Spec is ready for implementation.

---

## Appendix A — File-level implementation map

| File | Purpose |
|---|---|
| `packages/prm/src/modules/prm/data/entities/rfp-response-score.ts` | New MikroORM entity |
| `packages/prm/src/modules/prm/data/migrations/NNNN-add-rfp-response-scores.ts` | Creates table + `reopened_deadline_at` column + `vw_rfp_response_latest_scores` view |
| `packages/prm/src/modules/prm/data/repositories/rfp-response-score-repo.ts` | Append-only repo with `insertNextVersion` |
| `packages/prm/src/modules/prm/domain/commands/record-rfp-response-score.ts` | `RecordRFPResponseScoreCommand` |
| `packages/prm/src/modules/prm/domain/commands/select-rfp-winner.ts` | `SelectRFPWinnerCommand` (graph save) |
| `packages/prm/src/modules/prm/domain/commands/close-rfp.ts` | `CloseRFPCommand` |
| `packages/prm/src/modules/prm/domain/commands/reopen-rfp.ts` | `ReopenRFPCommand` (with hard guard) |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/responses/[rid]/score.ts` | POST record-score route |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/responses/[rid]/score/draft-llm.ts` | POST LLM-draft route |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/select.ts` | POST select route |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/close.ts` | POST close route |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/reopen.ts` | POST reopen route |
| `packages/prm/src/modules/prm/api/backend/rfps/[id]/broadcasts.ts` | GET B11 audit route |
| `packages/prm/src/modules/prm/backend/pages/rfps/[id]/widgets/scoring-widget.tsx` | B7 scoring widget |
| `packages/prm/src/modules/prm/backend/pages/rfps/[id]/widgets/selection-action.tsx` | B7 select winner action |
| `packages/prm/src/modules/prm/backend/pages/rfps/[id]/broadcasts.tsx` | B11 DataTable |
| `packages/prm/src/modules/prm/lib/llm/scoring-prompt.ts` | Prompt template + structured-output schema |
| `packages/prm/src/modules/prm/subscribers/selection-notification-dispatcher.ts` | Subscriber for selection_made / selection_changed |
| `packages/prm/src/modules/prm/subscribers/challenge-round-revision-unlocker.ts` | Subscriber for reopened_for_scoring |
| `packages/prm/src/modules/prm/jobs/reopened-deadline-expiry.ts` | Scheduled job |
| `packages/prm/src/modules/prm/data/notification-type-definitions.ts` | Two seed rows: `prm.rfp.selected`, `prm.rfp.not_selected` |
| `packages/prm/integration-tests/rfp-scoring/*.spec.ts` | All IT-* tests from §9 |

---

*End of SPEC-2026-04-23 — RFP Scoring, Selection, Lifecycle.*
