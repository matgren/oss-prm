# Platform-capability spike — tenant-per-spec Playwright rebuild

**Date**: 2026-05-09
**For**: `.ai/specs/SPEC-2026-05-09b-tenant-per-spec-integration-tests.md`
**Goal**: Resolve Open Questions Q1–Q4 (platform capability) so the spec can commit to phases.

All evidence cited from installed `node_modules/@open-mercato/*` (the exact code that runs in this app), supplemented by `gh search code` against `open-mercato/open-mercato` where noted.

---

## Q1 — Tenant-creation API

**Answer**: Yes. `POST /api/directory/tenants` exists, requires authenticated user with `directory.tenants.manage` feature, returns `{ id: <uuid> }`.

**Evidence**:
- `node_modules/@open-mercato/core/src/modules/directory/api/tenants/route.ts:39` — `POST` route metadata: `requireFeatures: ['directory.tenants.manage']`
- `node_modules/@open-mercato/core/src/modules/directory/api/tenants/route.ts:249-259` — OpenAPI: POST creates tenant, returns `{ id: string }`
- `node_modules/@open-mercato/core/src/modules/directory/commands/tenants.ts:44-96` — Command handler: creates ORM entity, returns full tenant with ID
- No special "platform admin" auth layer — standard feature-based RBAC

**Implication for spec**: The bootstrapped demo-tenant admin (created by `mercato init`) gets assigned `directory.tenants.manage` and is used as the platform-admin to mint per-worker tenants. No upstream feature request needed.

---

## Q2 — Ephemeral runner & demo tenant

**Answer**: Ephemeral DB starts raw. `yarn test:integration:ephemeral` → `mercato test:integration` → `mercato init` (mandatory) → schema migrations + creates exactly ONE bootstrap tenant + admin. No flag to skip.

**Evidence**:
- `node_modules/@open-mercato/cli/src/mercato.ts:2942-2946` — Integration setup invokes `yarn initialize` (= `mercato init`)
- `node_modules/@open-mercato/cli/src/mercato.ts:668-672` — `mercato init` runs `dbMigrate` (schema is shared across tenants)
- `node_modules/@open-mercato/cli/src/mercato.ts:732-760` — Then runs `auth setup` → `setupInitialTenant()`
- `node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:339-344` — After bootstrap, iterates all modules and calls `mod.setup.onTenantCreated()` hooks

**Implication for spec**: Schema is shared (good — no per-tenant migrations). Ephemeral DB always has 1 demo tenant + admin after init. Worker fixture authenticates as that admin and POSTs `/api/directory/tenants` to create a fresh tenant per worker.

---

## Q3 — Email capture for tests

**Answer**: NO built-in memory/test transport. `OM_DISABLE_EMAIL_DELIVERY=1` exists but only suppresses delivery — does not capture. Pluggable strategy registry exists (`registerNotificationDeliveryStrategy()`).

**Evidence**:
- `node_modules/@open-mercato/core/src/modules/notifications/lib/deliveryStrategies.ts:28-50` — Strategy registry, no memory/test strategy registered by default
- `node_modules/@open-mercato/cli/src/mercato.ts:2879` — Integration env sets `OM_DISABLE_EMAIL_DELIVERY=1` (suppresses, doesn't capture)
- Search: `nodemailer`, `ethereal`, `MailHog`, `memory transport` in notifications module → no match

**Implication for spec**: Three options for the partner-invite/email-link flow:
1. **Add a `GET /api/notifications/recipient/:email/recent` read API** — legitimate production capability (support agents need to verify what was sent), Playwright polls it for the invite link. NO test-only code.
2. Run MailHog/Mailpit alongside the test stack — added infra, more complex.
3. Descope portal-auth tests in v1 — defer until option 1 ships.

**Spec commits to option 1.** Adding a read API to the notifications module is a legit prod feature, not a test seam. If the notifications module already persists outbound notifications (very likely — delivery audit), the read API is a thin query.

**Follow-up to verify in Phase 2**: confirm `notifications` module persists every dispatched notification with recipient + body. If yes, the read API is ~30 LOC. If not, add persistence first.

---

## Q4 — Tenant-creation cost

**Answer**: Moderate. Schema is shared (no per-tenant migrations), but each tenant creation triggers KMS DEK provisioning + sequential `onTenantCreated` hooks across all enabled modules. Estimated wall-clock 500ms–2s per tenant. No benchmark in code.

**Evidence**:
- `node_modules/@open-mercato/core/src/modules/directory/commands/tenants.ts:50-95` — Tenant create: ORM entity + KMS DEK provisioning (~100ms KMS call) + side effects (indexing, caching)
- `node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:225-246` — `setupInitialTenant()` provisions DEK, creates hierarchy trees
- `node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:339-344` — `onTenantCreated()` hooks run sequentially across all modules (sales, inbox_ops, customer_accounts, dashboards all subscribe)

**Implication for spec**: Worker-scoped fixture (1 tenant per Playwright worker, reused across all specs in that worker) is the right granularity. Per-spec tenant would multiply the cost (e.g., 12 specs × 1.5s = 18s of pure tenant-init wall-clock). Tenant pool is unnecessary at this scale (4 workers × 1.5s = 6s total fixture init).

---

## Decisions for Q5–Q9 (Piotr defaults, baked into rewritten spec)

| Q | Decision | Rationale |
|---|---|---|
| Q5 | Curated tier-0 subset (~8–12 happy-path specs) | Rebuild value is in critical-path regression coverage; grow incrementally. Full 33 is over-investment. |
| Q6 | Drop publish-at-500-agencies perf smoke | CI perf gates are flaky; real-route seeding 500 agencies = 30–60s setup, signal not worth it. Dedicated bench if perf becomes a release concern. |
| Q7 | Real flow via notifications-read API; NO `agency-member-link` shortcut | Follows from Q3 decision. The shortcut helper is exactly the seam we're avoiding. |
| Q8 | `workers: 4` local, `workers: 2` CI | Tenant isolation makes parallel safe; CI memory is the constraint. |
| Q9 | Move to OM convention `src/modules/prm/__integration__/TC-PRM-*.spec.ts` | Aligns with core convention; `.ai/qa/` was a non-standard PRM choice that contributed to test code feeling "outside" the module. |

---

## What changed from the skeleton

The skeleton (status: SKELETON, gated on Q1–Q9) has been replaced with a READY spec that commits to:
- Tenant-per-spec via `POST /api/directory/tenants` (Q1 ✅)
- Worker-scoped fixture (Q4 ✅)
- Notifications-read API as new prod capability (Q3 mitigated)
- Curated tier-0 rebuild (Q5)
- OM convention `__integration__/` (Q9)

No more questions block phase execution. The only remaining unknown is the in-Phase-2 verification that notifications persist outbound (see Q3 follow-up).
