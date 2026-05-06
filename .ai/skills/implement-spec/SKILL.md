---
name: implement-spec
description: Implement a specification (or specific phases of a spec) using coordinated subagents. Handles multi-phase spec implementation with unit tests, integration tests, documentation, and code-review compliance. Use when the user says "implement spec", "implement the spec", "implement phases", "build from spec", or "code the spec". Tracks progress by updating the spec with implementation status.
---

# Implement Spec Skill

Implements a specification (or selected phases) end-to-end using a team of coordinated subagents. Every code change MUST pass the code-review checklist before the phase is considered done.

## Pre-Flight

1. **Identify the spec**: Locate the target spec file in `.ai/specs/`.
2. **Load context**: Read spec fully. Match affected tasks to the **Task → Context Map** in `AGENTS.md` and read all listed files (guides and skills).
3. **Load code-review checklist**: Read `.ai/skills/code-review/references/review-checklist.md` — this is the acceptance gate for every phase.
4. **Load lessons**: Read `.ai/lessons.md` for known pitfalls.
5. **Scope phases**: If the user specifies phases (e.g. "phases c-e"), filter to only those. Otherwise implement all phases sequentially.

## Implementation Workflow

For **each phase** in the spec, execute these steps:

### Step 1 — Plan the Phase

Read the phase from the spec. For each step within the phase:
- Identify files to create or modify (all paths under `src/modules/`)
- Identify which guides and skills apply (use the Task → Context Map in `AGENTS.md`)
- List required exports, conventions, and patterns from the relevant guides
- Note any cross-module impacts (events, extensions, widgets, enrichers)

Present a brief plan to the user before coding.

### Step 2 — Implement

Use subagents liberally to parallelize independent work:
- **One subagent per independent file/component** when files don't depend on each other
- **Sequential execution** when there are dependencies (e.g., entity before API route before backend page)

For every piece of code, enforce these code-review rules inline:

| Area | Rule |
|------|------|
| Types | No `any` — use zod + `z.infer` |
| API routes | Export `openApi` and `metadata` with auth guards |
| Entities | Standard columns, snake_case, UUID PKs, `organization_id` + `tenant_id` |
| Security | `findWithDecryption`, tenant scoping, zod validation |
| UI | `CrudForm`/`DataTable`, `apiCall`, `flash()`, `LoadingMessage`/`ErrorMessage` |
| Events | `createModuleEvents()` with `as const`, subscribers export `metadata` |
| i18n | `useT()` client, `resolveTranslations()` server, no hardcoded strings |
| Imports | Package-level `@open-mercato/<pkg>/...` for framework imports |
| Mutations | `useGuardedMutation` when not using CrudForm |
| Keyboard | `Cmd/Ctrl+Enter` submit, `Escape` cancel on dialogs |
| Naming | Modules plural snake_case, events `module.entity.past_tense`, features `module.action` |

### Step 3 — Unit Tests

For every new feature/function implemented in the phase:
- Create unit tests colocated with the source (e.g., `*.test.ts` or `__tests__/`)
- Test happy path + key edge cases
- Test error paths for validation and authorization
- Mock external dependencies (DI services, data engine)
- Verify tests pass: `yarn test`

### Step 4 — Integration Tests (MANDATORY for §9 happy path)

Every spec lists scenarios in §9. The §9 **happy-path smoke MUST ship** with the implementation phase that introduces the API/UI surface — it is a quality gate, not optional. Marking §9 scenarios "deferred to QA team" is **not acceptable**.

For each phase that introduces API or UI behavior:
- Identify the §9 happy-path scenario (typically IT-1 or IT-9.1).
- Use shipped OM fixtures from `@open-mercato/core/testing/integration` for seeding (`getAuthToken`, `apiRequest`, `deleteEntityByPathIfExists`, plus the per-domain `create*Fixture` exports). If your module needs its own fixtures, place them at `src/modules/<module>/testing/integration/{index,fixtures}.ts` mirroring the `crmFixtures.ts` shape — never write raw SQL or local helpers/auth files.
- Place specs at `.ai/qa/tests/integration/TC-<MODULE>-<SPEC>-<ID>-<desc>.spec.ts` (canonical home, auto-discovered by `.ai/qa/tests/playwright.config.ts`). The legacy `src/modules/<module>/__integration__/TC-{CATEGORY}-{XXX}.spec.ts` location is also discovered, but only use it when a test is intrinsically module-internal (e.g. exercises a private CLI command).
- Tests MUST be self-contained: create fixtures in setup, clean up in teardown.
- Tests MUST NOT rely on seeded/demo data.
- Run and verify via the ephemeral runner: `yarn test:integration:ephemeral --filter TC-<...>`.
- Re-run the test twice in a row — the second run must pass (idempotency check).

Edge-case scenarios beyond the happy path (§9 IT-2, IT-3, …) MAY be deferred to POST-MVP **only if** explicitly tracked in `.ai/specs/POST-MVP-FOLLOW-UPS.md` with an owner and effort estimate. The happy path itself cannot be deferred.

If the spec does not explicitly list integration scenarios but the phase adds significant API or UI behavior, propose test scenarios to the user before writing them.

### Step 5 — Documentation

For each new feature:
- Add/update locale files for new i18n keys
- If new entities with user-facing text: create `translations.ts`
- If new convention files: run `yarn generate`
- Update relevant guides or `AGENTS.md` if the feature introduces new patterns developers should follow

### Step 6 — Self-Review (Code-Review Gate)

Before marking a phase complete, run a self-review against the checklist (`.ai/skills/code-review/references/review-checklist.md`):

1. **Architecture & Module Independence** (section 1)
2. **Security** (section 2)
3. **Data Integrity & ORM** (section 3)
4. **API Routes** (section 4) — if applicable
5. **Events & Commands** (section 5) — if applicable
6. **UI & Backend Pages** (section 6) — if applicable
7. **Naming Conventions** (section 7)
8. **Anti-Patterns** (section 8)

Fix any violations before proceeding to the next phase.

### Step 7 — Update Spec with Progress

After completing each phase, update the spec file:
- Add an `## Implementation Status` section at the bottom (or update it if it exists)
- Use this format:

```markdown
## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| Phase A — Foundation | Done | 2026-02-20 | All steps implemented, tests passing |
| Phase B — Menu Injection | Done | 2026-02-21 | 3/3 steps complete |
| Phase C — Events Bridge | In Progress | 2026-02-22 | Step 1-2 done, step 3 pending |
| Phase D — Enrichers | Not Started | — | — |
```

- For the current phase, mark individual steps:

```markdown
### Phase C — Detailed Progress
- [x] Step 1: Create event definitions
- [x] Step 2: Implement SSE bridge
- [ ] Step 3: Add client-side hooks
```

### Step 8 — Verification

After all targeted phases are complete:

1. **Generate check**: `yarn generate` — must complete without errors
2. **Type check**: `yarn typecheck` — must pass (if available)
3. **Build check**: `yarn build` — must pass
4. **Unit test check**: `yarn test` — must pass
5. **Integration test check**: run any new integration tests — must pass
6. **Migration check**: `yarn mercato db generate` — if any entities changed (verify generated migration is scoped correctly)

Report results to the user. If any check fails, fix and re-verify.

## Subagent Strategy

| Task | Agent Type | When |
|------|-----------|------|
| Research existing patterns | Explore | Before implementing unfamiliar patterns |
| Implement independent files | general-purpose | When files have no dependencies on each other |
| Run tests | Bash | After each phase |
| Self-review | general-purpose | After each phase, against checklist |
| Integration tests | general-purpose | After phases with API/UI changes |

**Concurrency rule**: Launch parallel subagents only for truly independent work. Sequential for dependent files.

## Rules

- MUST read the full spec before starting implementation
- MUST read all guides and skills listed in the Task → Context Map before coding
- MUST pass every applicable code-review checklist item before marking a phase done
- MUST update the spec with implementation progress after each phase
- MUST run `yarn build` after final phase to verify no build breaks
- MUST create unit tests for all new behavioral code
- MUST ship the §9 happy-path Playwright smoke in the implementation phase that introduces the API or UI surface — listing §9 scenarios as "deferred to QA team" without writing them is not acceptable
- MUST place new smoke specs at `.ai/qa/tests/integration/TC-<MODULE>-<SPEC>-<ID>-<desc>.spec.ts`, run via `yarn test:integration:ephemeral`, and use shipped fixtures from `@open-mercato/core/testing/integration` (or module-owned fixtures at `src/modules/<module>/testing/integration/`) — never raw SQL or local helpers/auth files
- MUST NOT skip the self-review step — it is the quality gate
- MUST NOT introduce `any` types, hardcoded strings, raw `fetch`, or other anti-patterns
- MUST keep subagents focused — one task per subagent, clear boundaries
- MUST report blockers to the user immediately rather than working around them silently
- MUST run `yarn generate` after creating or modifying module convention files
- MUST run `yarn mercato db generate` after creating or modifying entities (and confirm migration with user before applying)
