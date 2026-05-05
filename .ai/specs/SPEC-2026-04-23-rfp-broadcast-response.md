# SPEC-2026-04-23: RFP Broadcast & Response (Portal-side cluster)

> **Cross-spec drift fixed 2026-05-05.** When this spec is implemented, routes MUST live under `/api/prm/rfp/...` (backend) and `/api/prm/portal/rfp/...` (portal) to match the shipped T0/T1/T2 namespace convention — NOT `/api/backend/prm/rfp/...` and `/api/portal/rfp/...` as currently drafted. Tables must use the `prm_` table-prefix convention (e.g. `prm_rfps`, `prm_rfp_responses`). The cross-spec `prm_rfps.is_path_b_locked` column called out in Spec #3 §8.4 is owned here. All other contracts (event IDs, entity shapes, ACL features) remain valid as drafted.
>
> **Spec #5 of 7** decomposing `app-spec/app-spec.md` (Piotr, om-cto Spec Orchestrator, 2026-04-23).
> **Workflow:** WF4 (RFP) — portal-side story cluster.
> **Phase:** 5a.
> **Stories covered:** US5.1, US5.2, US5.3, US5.4, US5.5.
> **Depends on:** Spec #1 (Agency identity) — requires `Agency`, `AgencyMember`, `CustomerUser`, `CustomerUserRole`. NOT dependent on Spec #3 (Attribution).
> **Paired with:** Spec #6 (`rfp-scoring-selection`) — same WF4, same entity cluster. Seam at "submitted `RFPResponse` → scoring." Spec #6 owns `RFPResponseScore` and the `scoring → selected → reopened → closed` transitions.
> **Estimated commits:** 3–5.

---

## 1. Summary, Scope, Business Outcome

### 1.1 Summary
This spec delivers the OM-side authoring of RFPs and the agency-side response + decline UX. OM PartnerOps can draft and publish an RFP; eligible Agencies receive it in a portal inbox; AgencyAdmins (or authoring AgencyMembers) draft and submit an `RFPResponse` with three markdown sections + attached CaseStudies, or explicitly decline. The spec stops at **`RFPResponse.status = submitted`** — scoring, selection, challenge-round re-opens, and close are all Spec #6.

### 1.2 Scope

**In scope:**
- Backend RFP create/edit/publish (B7 CrudForm + custom `Publish` action).
- `RFPBroadcast` fan-out via eligibility evaluator.
- One `NotificationTypeDefinition` + one subscriber for the broadcast invitation (OQ-015 resolution).
- Portal P9 (RFP inbox — custom list, no DataTable per OQ-010).
- Portal P10 (RFP detail + response form — the LARGEST portal page in PRM).
- Decline flow on P10.
- Audit / observability events: `prm.rfp_broadcast.first_opened`, `prm.rfp_broadcast.declined`.

**Explicitly out of scope (owned by Spec #6):**
- `RFPResponseScore` entity and versioning (invariant #18).
- B7 scoring widget + LLM-assist integration (US5.6).
- Selection action + outcome notifications (US5.7).
- Challenge-round re-open subscriber (US5.8).
- Close + re-open (US5.9, US5.10).
- B11 audit page (reads from events this spec emits, but the page itself ships with Spec #6).

**Cross-spec contract (load-bearing):**
- This spec **OWNS** entities `RFP`, `RFPBroadcast`, `RFPResponse`.
- Spec #6 **OWNS** `RFPResponseScore` and state transitions `scoring → selected → reopened → closed`.
- `RFP.is_path_b_locked` is a **read-model field** on `RFP` — **WRITTEN by Spec #3's subscriber** on `prm.license_deal.status_changed` (when a Path-B LicenseDeal with `rfp_id = X` reaches `status >= signed`) and **READ by Spec #6's re-open guard** (invariant #17, C5). This spec defines the column and its NULL-safe default; Spec #3 writes it; Spec #6 reads it.

### 1.3 Business Outcome
> *"Incoming RFPs go to every eligible partner, they make their case, none of it uses my inbox."* — Mat.

Measurable targets (derived from §7 Phase 5 acceptance criteria):
- ≥ 50 % of broadcast agencies respond or decline before the deadline (WF4 ROI).
- Zero Mat-inbox BCCs for RFP dispatch (replaces email-based broadcast).
- 100 % of broadcasts show correct eligibility filter application (verifiable via `prm.rfp.published` payload).

---

## 2. Technical Approach (Piotr)

*Embedded verbatim from the decomposition brief.*

- **Mode:** Extend PRM module with RFP entity cluster + custom portal pages + `notifications` integration. No core modifications.
- **New entities (this spec owns):**
  - `RFP` (aggregate; OM-owned; `title`, `brief` rich-text/markdown, `client_name`, `deadline` datetime, `status` per invariant #16 state machine: `draft` / `published` / `scoring` / `selected` / `closed` / `reopened`, `eligibility_filter` JSONB ({min_tier, required_industries[], required_technologies[], required_services[], countries[]}), `created_by_user_id`, `created_at`, `published_at`, `deadline_at`, `closed_at`, `is_path_b_locked` boolean default false — **read-model maintained by Spec #3 subscriber** on `prm.license_deal.status_changed`).
  - `RFPBroadcast` (unique `(rfp_id, agency_id)`; `rfp_id` FK, `agency_id` FK, `broadcast_at` timestamp, `first_opened_at` nullable, `declined_at` nullable, `decline_reason` text nullable).
  - `RFPResponse` (aggregate; unique `(rfp_id, agency_id)` — one response per agency per RFP; `rfp_id` FK, `agency_id` FK, `authored_by_agency_member_id` FK, `approach_markdown`, `team_markdown`, `timeline_markdown`, `attached_case_study_ids` array of FK, `status` enum `draft` / `submitted` / `scored` / `selected` / `not_selected`, `submitted_at` nullable, `updated_at`).
- **State machine (invariant #16):** enforced in RFP aggregate. `draft → published → scoring → (selected | closed)`; `selected → reopened → scoring` (Spec #6 handles reopen; this spec only defines the transition). Terminal: `closed`.
- **Visibility enforcement (invariant #15):** portal routes for US5.3 + US5.4 + US5.5 filter RFPs through `RFPBroadcast` join scoped to current Agency, AND check RFP `status IN ('published', 'scoring', 'selected', 'reopened')`. Direct RFP lookup without RFPBroadcast row returns 404 (not 403 — do not reveal existence).
- **US5.1 Create RFP draft (B7 CrudForm):** standard backend CrudForm with conditional fields on `eligibility_filter`. Uses `dictionaries` module for industries/technologies/services/countries (shipped production-ready per OQ-012).
- **US5.2 Publish + broadcast:**
  - Publish handler: transitions `draft → published` on RFP, sets `published_at`, runs **eligibility evaluator** (pure function: loops agencies, filters by `eligibility_filter`), creates one `RFPBroadcast` row per eligible Agency.
  - Emits `prm.rfp.published` with `broadcast_count`.
  - Seeds ONE `NotificationTypeDefinition` (OQ-015): `prm.rfp.broadcast_invitation` with `titleKey`, `bodyKey`, variables `{rfp_title, client_name, deadline}`.
  - ONE subscriber on `prm.rfp.published` calls `buildBatchNotificationFromType('prm.rfp.broadcast_invitation', recipients, variables)` — `recipients` = all PartnerAdmin + PartnerMember CustomerUsers of the broadcast agencies. 1 commit total per OQ-015.
  - Emits per-agency `prm.rfp_broadcast.created` events (for B11 audit in Spec #6).
- **US5.3 RFP inbox (P9 portal custom list):**
  - Custom React list — no DataTable (OQ-010).
  - Query: `RFPBroadcast` join `RFP` where `agency_id = current_agency_id` AND `RFP.status IN ('published', 'scoring', 'selected', 'reopened')`.
  - Filter tabs: Unread (first_opened_at IS NULL), Responded (join RFPResponse where status = 'submitted'), Declined (declined_at IS NOT NULL), All.
  - On row click → sets `first_opened_at` if null → navigates to P10.
  - Outcome badges (after selection): "You were selected" / "Not selected this time" — requires Spec #6 events (`prm.rfp.selection_made`).
- **US5.4 Draft/submit RFPResponse (P10 — LARGEST portal page):**
  - Custom React form. Three markdown editors: `approach_markdown`, `team_markdown`, `timeline_markdown` (reuse `packages/ui` markdown editor if it ships, else a thin wrapper). Size estimate: ~3 commits worth of UI assembly alone.
  - CaseStudy picker: select own-Agency CaseStudies (from Spec #7) — checkbox list, filtered to Agency.
  - Auto-save draft (debounced POST to `/api/portal/rfps/{id}/response/draft`).
  - Submit button: only enabled if required fields populated; transitions RFPResponse `draft → submitted`; sets `submitted_at`; emits `prm.rfp_response.submitted`.
  - Status-aware CTAs: after submit, form becomes read-only unless RFP `status = 'reopened'` (challenge round — Spec #6).
  - View own score once RFP `status = 'selected'` (reads `RFPResponseScore` from Spec #6 via read-only projection).
- **US5.5 Decline (P10 action):** button "Decline this RFP" with optional reason textarea. Sets `RFPBroadcast.declined_at` + `decline_reason`. Emits `prm.rfp_broadcast.declined`. UI transitions to a "You declined" state; no RFPResponse is created.
- **Cross-spec contract with Spec #6:** this spec OWNS entities `RFP`, `RFPBroadcast`, `RFPResponse`. Spec #6 owns `RFPResponseScore` + the state transitions `scoring → selected → reopened → closed`. The `is_path_b_locked` read-model field on `RFP` is WRITTEN by Spec #3's subscriber and READ by Spec #6's re-open guard — documented cross-spec invariant.
- **Rationale:** Visibility is load-bearing (invariant #15 silent 404). Portal page P10 is the largest single piece of UX in the entire PRM. `notifications` module saves ~4 commits across Phase 5 per OQ-015.

### 2.1 Reconciliation notes (Martin Fowler lens)

The Technical Approach above is the authoritative plan. Two minor reconciliations vs. the App Spec §1.4.1 wording are captured here so implementers can act on a single source of truth:

| Technical Approach (Piotr) | App Spec §1.4.1 | Implementer decision |
|---|---|---|
| `RFP.status` values: `draft / published / scoring / selected / closed / reopened` | `draft / published / scoring / selection_made / closed` | **Use `selection_made` (App Spec), not `selected`**, to match emitted event name `prm.rfp.selection_made` and invariant #16. `reopened` is not a persisted status; it is a semantic term for `closed → scoring` (edge case 6, Spec #6). This spec treats the Technical Approach's "`selected`" and "`reopened`" as aliases mapping onto `selection_made` and the re-entry into `scoring`. |
| `RFPResponse.status` values: `draft / submitted / scored / selected / not_selected` | `draft / submitted / withdrawn` | This spec persists only `draft` and `submitted`. The values `scored / selected / not_selected` are **derived views** computed at query time from `RFPResponseScore` (Spec #6) + `RFP.selected_agency_id`. Not a column. `withdrawn` is out of scope for v1. |
| `RFP.brief` (Technical Approach) | `RFP.description` (App Spec) | Use `description` to match App Spec. Aliased as `brief` in portal UX copy only. |
| `RFP.deadline_at` / `RFP.closed_at` / `RFP.published_at` | `RFP.deadline_to_respond` + system timestamps | Keep App Spec column names. `published_at` and `closed_at` are added by this spec (system-written on transitions). |
| `RFPResponse.approach_markdown / team_markdown / timeline_markdown` | `RFPResponse.tech_experience / domain_experience / differentiators` | **Use App Spec column names** — they are load-bearing for invariant "named-client evidence > generic claims" (the scoring rubric is phrased in those terms). The Technical Approach's tri-field shape is preserved; only the column names differ. |
| `RFPResponse.authored_by_agency_member_id` | `RFPResponse.submitted_by_member_id` | Keep `submitted_by_member_id` (App Spec); stamped on first draft save with the creating AgencyMember, repurposed at submit time. |
| `eligibility_filter` JSONB `{min_tier, required_industries[], ...}` | `eligibility_filter` enum `all_active / by_min_tier / explicit` + companion columns | **Use App Spec shape** (enum + companion columns `min_tier`, `explicit_agency_ids`). The richer JSONB shape is deferred to v2. Eligibility evaluator takes the enum + companions as input. |

**Rationale for reconciling toward the App Spec:** the App Spec is the product-level contract with Mat and downstream systems (events, notifications, attribution saga). The Technical Approach's deltas were shorthand, not overrides. Everything else in Piotr's Technical Approach applies verbatim.

---

## 3. API Contracts

> **Convention:** singular module + singular entity in URL path (`prm/rfp/...`) per the Singularity Law. All request/response bodies validated by Zod on both sides.

### 3.1 Backend (`/api/backend/prm/rfp/*`) — User / OM PartnerOps

| Method | Path | Purpose | Body / Params | Response |
|---|---|---|---|---|
| `GET` | `/api/backend/prm/rfp` | List RFPs (B6) | Query: `status?`, `q?`, `page`, `pageSize` | `{ items: RFP[], total }` |
| `GET` | `/api/backend/prm/rfp/{id}` | Detail (B7) | — | `RFP` (incl. broadcast counts) |
| `POST` | `/api/backend/prm/rfp` | Create draft (US5.1) | `CreateRFPDraftCommand` | `{ id }` + `prm.rfp.created` |
| `PATCH` | `/api/backend/prm/rfp/{id}` | Update draft | `UpdateRFPDraftCommand` | `{ id }` + `prm.rfp.updated` |
| `POST` | `/api/backend/prm/rfp/{id}/publish` | Publish + broadcast (US5.2) | `{ confirmedAgencyIds?: string[] }` (optional idempotency guard — UI pre-shows the list) | `{ id, status: 'published', broadcastAgencyIds: string[] }` + `prm.rfp.published` + N × `prm.rfp_broadcast.created` |
| `POST` | `/api/backend/prm/rfp/{id}/unpublish` | Undo publish (undoability — §7 invariant) | `{ reason: string }` | `{ id, status: 'draft' }` + `prm.rfp.unpublished` |

**ACL:** all routes require `prm.rfp.create` or `prm.rfp.publish` features (see §6).

**Zod contract example — `CreateRFPDraftCommand`:**
```ts
z.object({
  title: z.string().min(1).max(200),
  received_from: z.string().min(1).max(200),
  received_at: z.coerce.date(),
  description: z.string().min(1), // markdown
  tech_requirements: z.string().min(1),
  domain_requirements: z.string().min(1),
  industry: z.string().nullable().optional(), // dictionary slug
  budget_bucket: z.enum(['<50k', '50k-250k', '250k-1m', '1m+', 'unknown']).optional(),
  timeline_bucket: z.enum(['0-3m', '3-6m', '6-12m', '12m+', 'unknown']).optional(),
  required_capabilities: z.array(z.string()).default([]), // dictionary slugs (tech)
  additional_criterion_name: z.string().max(120).nullable().optional(),
  deadline_to_respond: z.coerce.date().nullable().optional(),
  eligibility_filter: z.enum(['all_active', 'by_min_tier', 'explicit']),
  min_tier: z.enum(['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core']).nullable().optional(),
  explicit_agency_ids: z.array(z.string().uuid()).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.eligibility_filter === 'by_min_tier' && !v.min_tier) ctx.addIssue({ ... });
  if (v.eligibility_filter === 'explicit' && (!v.explicit_agency_ids || v.explicit_agency_ids.length === 0)) ctx.addIssue({ ... });
});
```

### 3.2 Portal (`/api/portal/rfp/*`) — CustomerUser (AgencyAdmin / AgencyMember)

All portal routes resolve `current_agency_id` from the session's CustomerUser → AgencyMember → Agency and apply the **visibility gate** (invariant #15) before any other logic: a JOIN on `RFPBroadcast (rfp_id, agency_id)` must return a row, **AND** `RFP.status IN ('published', 'scoring', 'selection_made')`. Missing row → **404** (never 403, never 200-empty).

| Method | Path | Purpose | Body / Params | Response |
|---|---|---|---|---|
| `GET` | `/api/portal/rfp` | Inbox list (P9 / US5.3) | Query: `tab?: 'unread' \| 'responded' \| 'declined' \| 'all'`, `page`, `pageSize` | `{ items: InboxRow[], total }` |
| `GET` | `/api/portal/rfp/{id}` | RFP detail + own broadcast/response (P10) | — | `{ rfp, broadcast, response? }` — stamps `first_opened_at` side-effect on first call |
| `POST` | `/api/portal/rfp/{id}/response/draft` | Save/auto-save draft (US5.4) | `DraftRFPResponseCommand` | `{ id, updated_at }` + `prm.rfp_response.draft_saved` |
| `POST` | `/api/portal/rfp/{id}/response/submit` | Submit (US5.4) | `{}` (idempotent) | `{ id, status: 'submitted', submitted_at }` + `prm.rfp_response.submitted` |
| `POST` | `/api/portal/rfp/{id}/response/unsubmit` | Undo submit (undoability; only before `deadline_to_respond`) | `{ reason?: string }` | `{ id, status: 'draft' }` + `prm.rfp_response.unsubmitted` |
| `POST` | `/api/portal/rfp/{id}/decline` | Decline broadcast (US5.5) | `{ decline_reason?: string }` | `{ declined_at }` + `prm.rfp_broadcast.declined` |
| `POST` | `/api/portal/rfp/{id}/undecline` | Reverse decline (pre-deadline) | `{}` | `{ declined_at: null }` + `prm.rfp_broadcast.undeclined` |

**Inbox row shape (derived view):**
```ts
type InboxRow = {
  rfp_id: string;
  broadcast_id: string;
  title: string;
  client_public_name: string; // from received_from or a computed alias
  deadline_to_respond: Date | null;
  rfp_status: 'published' | 'scoring' | 'selection_made' | 'closed';
  broadcast_state: 'unread' | 'opened';
  response_state: 'none' | 'draft' | 'submitted';
  decline_state: 'none' | 'declined';
  outcome?: 'selected' | 'not_selected'; // only after RFP status = selection_made (Spec #6)
};
```

**`DraftRFPResponseCommand` Zod:**
```ts
z.object({
  tech_experience: z.string().optional(),
  domain_experience: z.string().optional(),
  differentiators: z.string().optional(),
  attached_case_study_ids: z.array(z.string().uuid()).default([]),
  // All optional on draft; submit enforces required set.
});
```

**Server-side draft validation on submit:**
- `tech_experience` required, non-empty.
- `domain_experience` required, non-empty.
- `differentiators` optional.
- `attached_case_study_ids`: every id must resolve to a CaseStudy with `agency_id = current_agency_id`; cross-Agency attachment is a 400 (invariant #6 + US5.4 failure path).
- `RFP.status` must be `published` (fresh submit) **or** `scoring`/`selection_made` (challenge-round re-submit — Spec #6 territory; this spec rejects).

### 3.3 Side-effect semantics

| Route | Idempotency key | Undoability |
|---|---|---|
| `POST /rfp/{id}/publish` | `rfp_id` (DB unique on `RFP.status = 'published' AND id = X`) | `POST /rfp/{id}/unpublish` — restores `draft`, deletes `RFPBroadcast` rows where `first_opened_at IS NULL AND declined_at IS NULL` (opened/declined rows are preserved + tombstoned with `RFP.status = 'draft'` implying they no longer render; portal inbox filters them out via status gate). Requires `reason`. |
| `POST /rfp/{id}/response/submit` | `(rfp_id, agency_id, 'submitted')` | `POST /rfp/{id}/response/unsubmit` — only before `RFP.deadline_to_respond`; returns to `draft`. |
| `POST /rfp/{id}/decline` | `(rfp_id, agency_id, 'declined')` | `POST /rfp/{id}/undecline` — only while `RFP.status = 'published'`. |
| `POST /rfp/{id}/response/draft` | request hash (auto-save debounced) | N/A (drafts are mutable) |

---

## 4. Commands & Events

### 4.1 Commands (CQRS)

| Command | Actor | Target | Undoable? | Notes |
|---|---|---|---|---|
| `CreateRFPDraftCommand` | OM PartnerOps | RFP (new) | Yes — delete-draft action on B7 | Validates eligibility-filter companion fields. |
| `UpdateRFPDraftCommand` | OM PartnerOps | RFP in `draft` | Yes — revert via update history | Rejects if `status != 'draft'`. |
| `PublishRFPCommand` | OM PartnerOps | RFP in `draft` | Yes — `UnpublishRFPCommand` | Transitions `draft → published`, runs eligibility evaluator, writes N `RFPBroadcast` rows in one tx. Fails if 0 eligible agencies. |
| `UnpublishRFPCommand` | OM PartnerOps | RFP in `published` with zero opens/responses/declines | No (terminal undo) | Reverts `published → draft`, deletes untouched broadcasts, preserves audit event. |
| `DraftRFPResponseCommand` | PartnerAdmin / authoring PartnerMember | RFPResponse (upsert by `(rfp_id, agency_id)`) | N/A | Creates-or-updates. Sets `submitted_by_member_id` on first draft. |
| `SubmitRFPResponseCommand` | PartnerAdmin / authoring PartnerMember | RFPResponse in `draft` | Yes — `UnsubmitRFPResponseCommand` within deadline | Transitions `draft → submitted`, stamps `first_submitted_at`, `last_updated_at`. |
| `UnsubmitRFPResponseCommand` | PartnerAdmin / authoring PartnerMember | RFPResponse in `submitted` | No (terminal undo) | Allowed only while `RFP.status = 'published'` AND before `RFP.deadline_to_respond`. |
| `DeclineRFPBroadcastCommand` | PartnerAdmin | RFPBroadcast (upsert decline flag) | Yes — `UndeclineRFPBroadcastCommand` | Reject if `RFP.status != 'published'`. |
| `UndeclineRFPBroadcastCommand` | PartnerAdmin | RFPBroadcast | No (terminal undo) | Clears `declined_at`, `decline_reason`. |

**Command routing:** CrudForm on B7 dispatches `Create`/`Update`/`Publish`/`Unpublish` via the standard backend router. Portal routes in §3.2 dispatch response/decline commands. No direct ORM writes outside command handlers.

### 4.2 Events (emitted)

> All events in `prm.*` namespace, snake_case, past-tense.

| Event | Payload | When | Subscribers (this spec) |
|---|---|---|---|
| `prm.rfp.created` | `{ rfp_id, created_by_user_id }` | On RFP draft create | none (audit-only here; Spec #6 B11 listens) |
| `prm.rfp.updated` | `{ rfp_id, changed_field_names: string[] }` | On draft edit | none |
| `prm.rfp.published` | `{ rfp_id, broadcast_agency_ids: string[], eligibility_filter, broadcast_count }` | On `draft → published` | **this spec:** `BroadcastInvitationNotifier` subscriber (fires `buildBatchNotificationFromType`) |
| `prm.rfp.unpublished` | `{ rfp_id, reason, unpublished_by_user_id }` | On undo-publish | none |
| `prm.rfp_broadcast.created` | `{ rfp_id, agency_id, broadcast_id }` | Per-agency row created on publish | Spec #6 B11 |
| `prm.rfp_broadcast.first_opened` | `{ rfp_id, agency_id, first_opened_at }` | On first P10 view | none (telemetry) |
| `prm.rfp_broadcast.declined` | `{ rfp_id, agency_id, decline_reason? }` | On decline | none (Spec #6 may use for auto-transition-to-scoring heuristic) |
| `prm.rfp_broadcast.undeclined` | `{ rfp_id, agency_id }` | On undecline | none |
| `prm.rfp_response.draft_saved` | `{ rfp_response_id, rfp_id, agency_id }` | On draft POST | none (telemetry) |
| `prm.rfp_response.submitted` | `{ rfp_response_id, rfp_id, agency_id, submitted_by_member_id, is_initial_submission }` | On submit | **Spec #6** (triggers scoring-ready heuristic) |
| `prm.rfp_response.unsubmitted` | `{ rfp_response_id, rfp_id, agency_id, reason? }` | On undo-submit | Spec #6 |

### 4.3 Consumed events (cross-spec reads)

| Event | Source spec | Effect here |
|---|---|---|
| `prm.license_deal.status_changed` | Spec #3 | Spec #3's subscriber updates `RFP.is_path_b_locked`. This spec only **declares the column** and its default. |
| `prm.rfp.selection_made` | Spec #6 | P9 inbox outcome badges + P10 read-only score view. This spec **reserves the UX slots**; rendering of the score uses a read-model projection owned by Spec #6. |

### 4.4 Notification type definitions seeded (OQ-015)

This spec seeds **ONE** `NotificationTypeDefinition`:

```ts
{
  typeKey: 'prm.rfp.broadcast_invitation',
  titleKey: 'prm.notifications.rfp.broadcast_invitation.title', // i18n: "New RFP: {{rfp_title}}"
  bodyKey: 'prm.notifications.rfp.broadcast_invitation.body',   // i18n: "{{client_name}} is looking for an agency. Deadline: {{deadline}}. Open to respond."
  variables: ['rfp_title', 'client_name', 'deadline', 'rfp_url'],
  defaultChannels: ['portal_inbox', 'email'],
}
```

**ONE** subscriber — `BroadcastInvitationNotifier` — listens on `prm.rfp.published`, expands `broadcast_agency_ids` to the union of their PartnerAdmin + PartnerMember CustomerUsers (via Spec #1's `CustomerUserRole` projection), and calls:
```ts
notifications.buildBatchNotificationFromType({
  typeKey: 'prm.rfp.broadcast_invitation',
  recipients: customerUserIds,
  variables: { rfp_title, client_name, deadline, rfp_url },
});
```

**Failure isolation (W4):** per-agency delivery failure does NOT roll back `RFP.status = published`. The inbox P9 reads from `RFPBroadcast`, not from notifications, so the broadcast row is authoritative. Delivery failures surface on Spec #6's B11 via the `notifications` module's own retry + audit contract.

---

## 5. Data Models

### 5.1 `rfp` table

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `organization_id` | uuid | FK `organization(id)`, NOT NULL | OM's own Organization (PRM backend scope) |
| `title` | text | NOT NULL | |
| `received_from` | text | NOT NULL | |
| `received_at` | timestamptz | NOT NULL | |
| `description` | text | NOT NULL | markdown |
| `tech_requirements` | text | NOT NULL | markdown |
| `domain_requirements` | text | NOT NULL | markdown |
| `industry` | text | NULL | dictionary slug |
| `budget_bucket` | text | NULL | |
| `timeline_bucket` | text | NULL | |
| `required_capabilities` | text[] | NOT NULL default `'{}'` | dictionary slugs |
| `additional_criterion_name` | text | NULL | |
| `deadline_to_respond` | timestamptz | NULL | |
| `eligibility_filter` | text | NOT NULL CHECK (`in ('all_active','by_min_tier','explicit')`) | |
| `min_tier` | text | NULL | required iff `eligibility_filter = 'by_min_tier'` (app-level) |
| `explicit_agency_ids` | uuid[] | NULL | required iff `eligibility_filter = 'explicit'` (app-level) |
| `status` | text | NOT NULL CHECK (`in ('draft','published','scoring','selection_made','closed')`) default `'draft'` | Invariant #16 |
| `selected_agency_id` | uuid | NULL FK `agency(id)` | Written by Spec #6 |
| `selection_decided_at` | timestamptz | NULL | Written by Spec #6 |
| `selection_decided_by_user_id` | uuid | NULL | Written by Spec #6 |
| `selection_reasoning` | text | NULL | Written by Spec #6 |
| `is_path_b_locked` | boolean | NOT NULL default `false` | Read-model; written by Spec #3 |
| `notes` | text | NULL | |
| `created_by_user_id` | uuid | NOT NULL | |
| `published_at` | timestamptz | NULL | System-stamped |
| `closed_at` | timestamptz | NULL | System-stamped (Spec #6) |
| `created_at` | timestamptz | NOT NULL default `now()` | |
| `updated_at` | timestamptz | NOT NULL default `now()` | |

**Indexes:**
- `idx_rfp_status` on `(status)` — inbox visibility filter.
- `idx_rfp_deadline` on `(deadline_to_respond)` — auto-transition scheduled job (Spec #6).
- `idx_rfp_org` on `(organization_id)` — tenant isolation.

### 5.2 `rfp_broadcast` table

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `organization_id` | uuid | NOT NULL | Denormalized from `rfp.organization_id` |
| `rfp_id` | uuid | NOT NULL FK `rfp(id)` ON DELETE CASCADE | |
| `agency_id` | uuid | NOT NULL FK `agency(id)` | |
| `broadcast_at` | timestamptz | NOT NULL default `now()` | |
| `first_opened_at` | timestamptz | NULL | |
| `declined_at` | timestamptz | NULL | |
| `decline_reason` | text | NULL | |
| `created_at` | timestamptz | NOT NULL default `now()` | |
| `updated_at` | timestamptz | NOT NULL default `now()` | |

**Constraints / Indexes:**
- UNIQUE `(rfp_id, agency_id)` — invariant: one broadcast per (RFP, Agency).
- `idx_broadcast_agency` on `(agency_id, first_opened_at)` — inbox list perf.
- `idx_broadcast_rfp` on `(rfp_id)` — publish audit + B11 reads (Spec #6).

### 5.3 `rfp_response` table

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `organization_id` | uuid | NOT NULL | Denormalized from `rfp.organization_id` |
| `rfp_id` | uuid | NOT NULL FK `rfp(id)` | |
| `agency_id` | uuid | NOT NULL FK `agency(id)` | |
| `submitted_by_member_id` | uuid | NOT NULL FK `agency_member(id)` | Stamped on first draft |
| `status` | text | NOT NULL CHECK (`in ('draft','submitted')`) default `'draft'` | |
| `tech_experience` | text | NULL | markdown |
| `domain_experience` | text | NULL | markdown |
| `differentiators` | text | NULL | markdown |
| `attached_case_study_ids` | uuid[] | NOT NULL default `'{}'` | |
| `first_submitted_at` | timestamptz | NULL | Stamped on first `draft → submitted` |
| `last_updated_at` | timestamptz | NOT NULL default `now()` | |
| `challenge_round_updated_at` | timestamptz | NULL | Stamped by Spec #6 |
| `created_at` | timestamptz | NOT NULL default `now()` | |

**Constraints / Indexes:**
- UNIQUE `(rfp_id, agency_id)` — one response per agency per RFP.
- `idx_response_agency` on `(agency_id, status)` — portal inbox JOIN.
- `idx_response_rfp_status` on `(rfp_id, status)` — scoring-ready query in Spec #6.

### 5.4 Projection read-models

| Projection | Owner | Consumed by this spec? | Notes |
|---|---|---|---|
| `rfp_response_current_score` | Spec #6 | Read-only in P10 "View own score" tile | Join on `rfp_response_id` → latest `scoring_version`. |

This spec does not own any cross-module projection writes. It only reads from Spec #6's projection.

---

## 6. Access Control

### 6.1 Features (backend)

| Feature key | Holder | Granted by |
|---|---|---|
| `prm.rfp.create` | OM PartnerOps role | Spec #1 seeds OM PartnerOps role; this spec adds the feature. |
| `prm.rfp.publish` | OM PartnerOps role | Separate from `create` so an intern-tier role can draft but not publish (future-proofing; v1 grants both to OM PartnerOps). |

Both features gate routes in §3.1.

### 6.2 Portal RBAC (AgencyAdmin / AgencyMember)

Portal routes in §3.2 do not use explicit `prm.*` features — they use the **implicit tenant scope + CustomerUserRole** pattern from Spec #1 / SPEC-060:

| Action | PartnerAdmin | Authoring PartnerMember | Non-authoring PartnerMember |
|---|---|---|---|
| View P9 inbox | allowed | allowed | allowed |
| View P10 detail | allowed | allowed | allowed |
| Draft response | allowed (any draft in the Agency) | allowed (own draft only; `submitted_by_member_id = self`) | **rejected** (API 403) |
| Submit response | allowed | allowed (own draft only) | rejected |
| Unsubmit response | allowed | allowed (own draft only) | rejected |
| Decline broadcast | allowed | **rejected** (decline is an Agency-level decision) | rejected |
| Undecline broadcast | allowed | rejected | rejected |

**Visibility gate enforcement (invariant #15, "silent 404"):**
- Every portal route starts with a JOIN-on-`rfp_broadcast` check scoped to `current_agency_id`.
- If the join returns zero rows, OR if `rfp.status NOT IN ('published','scoring','selection_made')`, respond **404 Not Found**.
- **Never 403, never 200-with-empty-body.** Revealing existence via 403 is the leak; revealing existence via a 200+empty shape is the leak Grade 2 variant.

### 6.3 Admin-only field writes (invariant #6)

The portal API interceptor (Spec #1) already rejects writes to `RFP.*` from portal sessions regardless of role. This spec does not add portal write endpoints on `RFP` itself — only on `RFPBroadcast` (decline flags) and `RFPResponse` (response drafting), which are tenant-scoped AgencyMember writes, not admin-only.

---

## 7. Backward Compatibility

**Classification: Additive-only.**

- New tables: `rfp`, `rfp_broadcast`, `rfp_response`. No changes to existing tables.
- New events: all in `prm.rfp.*` / `prm.rfp_broadcast.*` / `prm.rfp_response.*` namespaces — never before used.
- New routes: all under `/api/backend/prm/rfp/*` and `/api/portal/rfp/*` — never before served.
- `RFP.is_path_b_locked` column is added by **this spec** (so Spec #6's re-open guard has a place to read from). Spec #3 writes to it later; the column defaults to `false`, so the read-model is safe even before Spec #3 ships.

**Migration ordering:** this spec's migration must land **before** Spec #3's subscriber migration (which writes `is_path_b_locked`) and **before** Spec #6's migration (which adds `rfp_response_score` and reads the column). Captured in §8 Integration Test Coverage.

**Rollback:** `DROP TABLE rfp_response; DROP TABLE rfp_broadcast; DROP TABLE rfp;` in that order. Event topics are not created by migrations (events are publish-on-first-emit). No data is shared with other modules at the table level.

---

## 8. Risks & Impact Review

### 8.1 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `packages/ui` does not ship a markdown editor primitive — this spec must own the dependency (adds ~1 commit). | **Unknown** — carried over to Step 4.5 proxy gate. | Medium (1 commit delta, no architectural fault) | If `packages/ui` ships one, use it. If not, implement a thin wrapper over `@uiw/react-md-editor` or similar, **inside** `packages/ui` (never inside the PRM module) to avoid duplicated editors across modules. |
| R2 | Eligibility evaluator perf: naive `Agency.findAll().filter(...)` is O(N) over all agencies. At 1000+ agencies this becomes the publish-action hot path. | Low at v1 (tens-to-hundreds of agencies). | Medium (UX latency on publish; could time out). | Pure function scoped to one SELECT with a WHERE clause pushing `status = 'active' AND onboarded = true` into SQL. Tier filter + industry/tech filters done in SQL where trivial; JSON array intersections in app layer acceptable up to ~5k agencies. Add a perf test in §9. |
| R3 | **Visibility 404 leakage.** Returning 403 "not allowed" (vs. 404 "not found") reveals RFP existence to non-eligible agencies — a breach of invariant #15. | Medium (easy to slip in during refactors). | High (confidentiality of RFP briefs). | Integration test: "Non-eligible agency's GET on a known-existing RFP returns 404, not 403, and the response body is byte-identical to a 404 on a fake UUID." Code-review rule: all portal RFP routes must call a shared `assertBroadcastedOrNotFound(rfpId, agencyId)` helper that throws a typed `NotFoundError`, never an `AccessDeniedError`. |
| R4 | **P10 size as a single atomic commit.** The brief estimates ~3 commits worth of UI assembly. Committing as a single atomic unit would violate the "one commit per testable slice" rule. | High (it is big). | Medium (PR fatigue, review quality). | Split P10 into sub-commits in §10 Implementation Breakdown: (a) scaffold + read RFP brief + state-aware CTAs; (b) three markdown editors wired to draft POST; (c) CaseStudy picker + cross-Agency reject test; (d) auto-save debounce; (e) submit + unsubmit. Five sub-commits; commit (a) already delivers working read-only P10. |
| R5 | `RFPResponse.submitted_by_member_id` stamped at draft create — but CustomerUser may later be deactivated (e.g., leaves the Agency). | Low | Low (UX only — shows an inactive user's name) | Render with a "(deactivated)" suffix when the AgencyMember's `is_active = false`. No data migration needed. |
| R6 | Undo-publish with partial opens: deleting an `RFPBroadcast` row that has been opened would lose the `first_opened_at` audit trail. | Low (OM PartnerOps discretion) | Medium (audit integrity) | `UnpublishRFPCommand` **refuses** if any `RFPBroadcast` has a non-null `first_opened_at`, `declined_at`, or an associated `RFPResponse` row. If any agency has interacted, the only path back is to `close` the RFP (Spec #6). This preserves invariant #16. |
| R7 | Auto-save draft POST storm: fast typing + debounce=500ms can still emit 10 req/s per AgencyMember. | Medium | Low-Medium (server load) | Server-side debounce (idempotent upsert by `(rfp_id, agency_id)` — no dupes). Rate-limit to 4 req/s per CustomerUser on the draft route. Emit `prm.rfp_response.draft_saved` only on **change-of-content hash**, not on every POST — avoids event-bus flood. |

### 8.2 Impact on Spec #3 and Spec #6

- **Spec #3 (Attribution):** this spec declares `RFP.is_path_b_locked` with a safe default. Spec #3 writes to it via a subscriber. No BC risk.
- **Spec #6 (Scoring/Selection):** this spec emits `prm.rfp_response.submitted` which Spec #6 consumes. The event payload shape above is the contract — Spec #6 must treat it as frozen.

---

## 9. Integration Test Coverage

> Playwright TypeScript (per `om-integration-tests`). Tests listed here are the *minimum* set; implementers may add sub-cases.

### 9.1 Create + Publish (US5.1, US5.2)

1. **Happy path: publish `by_min_tier`.** Setup: 3 Agencies — A (tier=`ai_native_expert`), B (tier=`ai_native`), C (tier=`om_agency`). Create RFP with `eligibility_filter = by_min_tier`, `min_tier = ai_native`. Publish. Assert: `RFPBroadcast` exists for A + B, not C. Assert `prm.rfp.published` payload has exactly `[A.id, B.id]`. Assert one notification per CustomerUser of A + B.
2. **Happy path: `explicit`.** Create RFP with `explicit_agency_ids = [A.id]`. Publish. Only A receives a broadcast.
3. **Zero-eligible publish blocked.** `min_tier = ai_native_core` with no such Agency — publish returns 4xx with `"Zero eligible agencies"` and `RFP.status` remains `draft`.
4. **Partial-insert rollback (W4).** Inject a DB error on the 3rd `RFPBroadcast` insert. Assert: RFP reverts to `draft`, zero broadcast rows exist, zero `prm.rfp.published` published, retry succeeds.
5. **Undo-publish clean.** Publish → immediately unpublish. Assert: 0 broadcast rows, RFP back to `draft`. `prm.rfp.unpublished` emitted.
6. **Undo-publish refused.** Publish → Agency A opens P10 (stamps `first_opened_at`) → unpublish. Expect 409 with `"Cannot unpublish — agencies have already interacted"`.

### 9.2 Visibility gate (US5.3, invariant #15)

7. **Non-eligible 404 on direct GET.** Agency C (not broadcasted) hits `GET /api/portal/rfp/{id}`. Expect **404**, response body byte-identical to `GET /api/portal/rfp/{fakeUUID}`.
8. **Status-gate 404 on draft.** While RFP is still `draft`, Agency A (will-be-broadcast, but not yet) hits GET → 404.
9. **Inbox filter tabs.** Seed: 5 broadcasts in mixed states (2 unread, 1 responded, 1 declined, 1 outcome-selected). Assert each tab filter returns the correct subset.
10. **First-open stamp.** Agency A hits `GET /api/portal/rfp/{id}` twice; assert `first_opened_at` set on first call, unchanged on second, and `prm.rfp_broadcast.first_opened` emitted exactly once.

### 9.3 Draft + Submit + Unsubmit (US5.4)

11. **Draft lifecycle.** Agency A creates draft with partial data → saves 3 times → asserts `RFPResponse.status = draft`, content updated, 3 `prm.rfp_response.draft_saved` events (deduped by hash: only if content changed).
12. **Submit happy path.** Draft with all required fields → submit → `status = submitted`, `first_submitted_at` stamped, `prm.rfp_response.submitted` emitted with `is_initial_submission = true`.
13. **Submit with missing required field.** Empty `tech_experience` → 400 with field-level error. Status stays `draft`.
14. **Cross-Agency CaseStudy reject.** Agency A attempts `attached_case_study_ids = [studyOwnedByB]` → 400, no data written.
15. **Submit after deadline.** Shift system clock past `deadline_to_respond` → submit → 400 `"RFP is no longer accepting responses"`. Draft preserved.
16. **PartnerMember can only submit own draft.** Member M1 creates draft. Member M2 attempts submit → 403. M1's submit succeeds.
17. **Unsubmit happy path.** After submit, before deadline → unsubmit → status back to `draft`, `prm.rfp_response.unsubmitted` emitted.
18. **Unsubmit after deadline refused.** Shift clock past deadline → unsubmit → 409 `"Deadline passed — cannot unsubmit"`.
19. **CaseStudy picker scope.** UI test: P10 picker lists only Agency A's **published** CaseStudies (soft-deleted + draft excluded — cross-check with Spec #7 once shipped; v1 of this spec lists all own-Agency CaseStudies).

### 9.4 Decline (US5.5)

20. **Decline with reason.** Agency A declines → `declined_at` set, `decline_reason` persisted, `prm.rfp_broadcast.declined` emitted.
21. **Decline without reason.** Allowed.
22. **Un-decline pre-deadline.** Reverse decline → cleared.
23. **Decline after scoring blocked.** Spec #6's transition to `scoring` → Agency A attempts decline → 409.

### 9.5 Cross-spec seam (checked via mocks)

24. **Challenge round re-opens P10 draft.** Simulate Spec #6 transition `selection_made → scoring`. P10 becomes writable for the submitted response (response stays `submitted`; the re-enable logic is a portal state check based on `RFP.status`). Save a challenge update → `prm.rfp_response.submitted` with `is_initial_submission = false`. (Full logic owned by Spec #6; this spec asserts the read-side UX only.)
25. **Score view tile.** Simulate `RFP.status = selection_made` + a `RFPResponseScore` row exists (Spec #6 projection). P10 shows the score tile. Agencies that were not selected see their own score only; selected agency sees "You were selected" badge. Cross-Agency scores never visible.
26. **`is_path_b_locked` default.** Create and publish an RFP. Without Spec #3 running, `RFP.is_path_b_locked = false`. Spec #6's re-open guard (in its own test suite) reads `false` → re-open allowed.

### 9.6 Perf smoke (R2)

27. **Eligibility evaluator at 500 agencies.** Seed 500 active/onboarded Agencies with distributed tiers/industries. Publish with a 3-tier + 2-industry filter. Assert: total publish time < 2s (P95), all expected broadcasts + notifications dispatched.

---

## 10. Implementation Breakdown

**Target: 3–5 atomic commits.** Given R4 (P10 size), split as follows:

### Commit 1 — Entities + backend B7 + publish handler + notification seed (US5.1 + US5.2)
- Migration: `rfp`, `rfp_broadcast`, `rfp_response` tables per §5.
- Commands: `CreateRFPDraftCommand`, `UpdateRFPDraftCommand`, `PublishRFPCommand`, `UnpublishRFPCommand` + handlers.
- Routes: `/api/backend/prm/rfp` (CRUD + publish + unpublish).
- Eligibility evaluator (pure function) + unit tests.
- Seeded `NotificationTypeDefinition` `prm.rfp.broadcast_invitation` + `BroadcastInvitationNotifier` subscriber on `prm.rfp.published`.
- Features: `prm.rfp.create`, `prm.rfp.publish` + RBAC seed.
- Integration tests §9.1.

### Commit 2 — P9 portal inbox (US5.3)
- Route: `/api/portal/rfp` (list).
- Visibility helper `assertBroadcastedOrNotFound()`.
- Custom React list (no DataTable) at `/{slug}/portal/rfp/page.tsx` with filter tabs + empty states.
- First-open stamp on P10-detail GET (even though P10 itself ships in commit 3; the route exists).
- Integration tests §9.2.

### Commits 3a–3e — P10 portal detail + response (US5.4) — split per R4
- **3a:** P10 scaffold — read RFP brief (read-only for all states), show status-aware CTAs, decline button wired to a stub. Integration test: "RFP brief renders; decline CTA disabled when status=scoring."
- **3b:** Three markdown editors (`tech_experience` / `domain_experience` / `differentiators`) + draft POST wired. Integration test §9.3 #11.
- **3c:** CaseStudy picker + cross-Agency reject test (§9.3 #14).
- **3d:** Auto-save debounce + rate limit (R7).
- **3e:** Submit + unsubmit commands + submit validation + status-aware form lock. Integration tests §9.3 #12–18.

### Commit 4 — Decline flow (US5.5)
- `DeclineRFPBroadcastCommand` + `UndeclineRFPBroadcastCommand` + routes in §3.2.
- P10 decline panel (reason textarea + confirm).
- Integration tests §9.4.

### Commit 5 (conditional) — Markdown editor primitive in `packages/ui` (R1 — carry-over)
- Only if Step 4.5 proxy gate confirms `packages/ui` has no markdown editor.
- Ships the shared `<MarkdownEditor>` component used by P10 (and later CaseStudy detail P8, Agency description P3).
- Integration test: basic mount + onChange + markdown preview.

**Total: 4 commits (if editor ships) or 5 commits (if this spec owns the editor).**

---

## 11. Final Compliance Report (Piotr Decision Library)

| Rule | Status | Note |
|---|---|---|
| **Singularity Law** (singular table/module names) | **PASS** | `rfp`, `rfp_broadcast`, `rfp_response`, module `prm` — all singular. URLs: `/prm/rfp/...`. |
| **Tenant isolation** (`organization_id` on every scoped entity) | **PASS** | Present on all three tables (§5); denormalized on children for fast tenant scoping. |
| **FK IDs only across modules** | **PASS** | `agency_id`, `agency_member_id` are FK ids; no ORM traversal into the Agency module from here. |
| **Undoability as default** | **PASS** | All state-change commands have a paired `Unpublish` / `Unsubmit` / `Undecline` (§4.1). |
| **Zod validation on all API inputs** | **PASS** | §3.1, §3.2 specify Zod shapes. |
| **Events emitted on every state change** | **PASS** | §4.2: create/update/publish/unpublish/first_opened/declined/undeclined/draft_saved/submitted/unsubmitted all emit. |
| **No cross-module ORM** | **PASS** | CaseStudy and Agency reads go through their module's API; we use FK ids + tenant-scoped JOINs only inside the PRM tables. |
| **Spec is architectural diff, not CRUD boilerplate** | **PASS** | Standard CRUD parts are compressed into §3.1 table rows; depth goes into visibility, publish transaction, undo-guards. |
| **Invariant coverage** | **PASS** | #15 (silent 404), #16 (state machine), #17 (`is_path_b_locked` declared), #18 (reserved for Spec #6). |
| **Cross-spec seam explicit** | **PASS** | §1.2 + §4.3 + §5.4 document what Spec #3 and Spec #6 write/read. |
| **OQ-015 (notifications) applied** | **PASS** | One `NotificationTypeDefinition` + one subscriber (§4.4). |
| **OQ-016 (portal inbox primitives)** | **N/A here** | Owned by P12 in a separate spec; this spec uses `portal_inbox` channel as a notification target but does not wire the inbox page. |
| **OQ-010 (no DataTable on portal)** | **PASS** | §10 Commit 2 — custom React list. |
| **Failure modes documented** | **PASS** | §8.1 risks; §9 integration tests cover each failure path. |
| **Implementation breakdown per atomic commit** | **PASS** | §10. |

**Outstanding item for Step 4.5 proxy gate:** does `packages/ui` ship a markdown editor primitive? If yes → Commit 5 is dropped; if no → this spec owns the shared editor (R1 / Commit 5).

---

*End of SPEC-2026-04-23-rfp-broadcast-response.*
