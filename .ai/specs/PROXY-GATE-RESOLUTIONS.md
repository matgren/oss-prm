# Proxy-Gate Resolutions

Author: Pm-Proxy (acting on Piotr's Step 4.5 proxy gate), verified from OM source at `/Users/maciejgren/Documents/OM/`
Date: 2026-04-23
Scope: 5 ambiguities surfaced during spec writing that required OM-source lookup

All 5 items resolved from source evidence. No further user escalation needed.

---

## Q1. Markdown editor in `packages/ui` — **RESOLVED: YES**

**Evidence:**
- `packages/ui/src/backend/inputs/SwitchableMarkdownInput.tsx` — production-ready markdown input component with preview, remark plugins, test-environment stub, and textarea-fallback behavior.
- Exported via `packages/ui/src/backend/inputs/index.ts`.

**Applied to:**
- **Spec #5 (rfp-broadcast-response) P10:** import `SwitchableMarkdownInput` for the three markdown fields `tech_experience`, `domain_experience`, `differentiators`. No new shared primitive needed.
- **Spec #7 (case-studies-marketing) P8:** import same component for `challenge_markdown`, `approach_markdown`, `outcome_markdown`.

**Note:** the component lives under `packages/ui/src/backend/` but is a plain React component — it works in portal pages. Import path: `@open-mercato/ui/backend/inputs`. If we later want a dedicated portal-themed wrapper, that's a v2 refinement, not a blocker.

**Sizing impact:** Specs #5 and #7 each −1 commit vs. worst-case "ship a new `<MarkdownEditor>` primitive."

---

## Q2. `customer_accounts.createInvitation` transactional participation — **RESOLVED: YES**

**Evidence:** `packages/core/src/modules/customer_accounts/services/customerInvitationService.ts:15-16`:

```ts
export class CustomerInvitationService {
  constructor(private em: EntityManager) {}
```

The service takes `EntityManager` via constructor DI. Inside `createInvitation` it uses `this.em.create(...)` + `this.em.persistAndFlush(...)`. PRM's invite handler resolves `CustomerInvitationService` from DI with a transaction-scoped `EntityManager`, meaning:

1. Open MikroORM transaction on the request-scoped EM.
2. Resolve `CustomerInvitationService` (DI injects the tx-scoped EM).
3. Call `createInvitation(...)` — `persistAndFlush` emits INSERT within the tx.
4. Create placeholder `AgencyMember` on the same EM (holding GH-profile lock per L-013).
5. Commit the tx. Both rows land atomically; on failure, both roll back.

**Applied to:** Spec #1 US1.2 invite handler.

**Risk:** zero. No contingency needed.

---

## Q3. `CustomerUserInvitation.metadata` field for role stash — **RESOLVED: NOT NEEDED**

**Evidence:** `createInvitation` signature at `customerInvitationService.ts:18-28`:

```ts
async createInvitation(
  email: string,
  scope: { tenantId: string; organizationId: string },
  options: {
    customerEntityId?: string | null
    roleIds: string[]
    invitedByUserId?: string | null
    invitedByCustomerUserId?: string | null
    displayName?: string | null
  },
): Promise<{ invitation: CustomerUserInvitation; rawToken: string }>
```

`roleIds: string[]` is a first-class parameter, stored as `roleIdsJson` on the invitation (line 42). On `acceptInvitation` (lines 89-100), `customer_accounts` automatically creates `CustomerUserRole` rows for each roleId:

```ts
const roleIds = Array.isArray(invitation.roleIdsJson) ? invitation.roleIdsJson : []
for (const roleId of roleIds) {
  const role = await this.em.findOne(CustomerRole, { id: roleId, ... })
  if (role) {
    const userRole = this.em.create(CustomerUserRole, { user, role, createdAt: new Date() })
    this.em.persist(userRole)
  }
}
```

**Applied to Spec #1:**
- **Delete** the "stash `role_slug` on `CustomerUserInvitation.metadata`" language.
- **Delete** the PRM-owned `AgencyMemberInvitationHint` side-table contingency.
- **PRM invite handler** resolves the seeded role ID (`PartnerAdmin` or `PartnerMember`, looked up by slug from PRM's `setup.ts`-seeded `CustomerRole` rows) and passes it in `createInvitation({..., options: { roleIds: [resolvedRoleId] }})`.
- **Simplify `PrmInvitationAcceptedSubscriber`:** the subscriber no longer assigns roles (the accept flow already did). Its only responsibility is:
  1. Link the pre-accept placeholder `AgencyMember` row (looked up by invitation_id) to the new `CustomerUser` via FK.
  2. Set `AgencyMember.activated_at = now()`.
  3. Emit `prm.agency_member.activated`.

**Sizing impact:** Spec #1 simplifies — one subscriber responsibility removed, no side-table needed.

---

## Q4. `customer_accounts` reusable `CustomerUserRole` CrudForm — **RESOLVED: NO — Spec #1 owns a thin wrapper**

**Evidence:** `packages/core/src/modules/customer_accounts/backend/customer_accounts/users/[id]/page.tsx` is a fully custom React page (Dialog, Button, custom form, `apiCall` helper) — NOT a drop-in CrudForm-style component. It's a pattern to follow, not a component to import.

The shipped reusable surfaces are the API routes:
- `POST /api/admin/users/{id}/roles` (role assignment)
- `GET/POST /api/admin/roles`, `GET/POST /api/admin/roles/[id]`, `GET/POST /api/admin/roles/[id]/acl`
- `POST /api/admin/users-invite`

**Applied to Spec #1:**
- B2 Members tab ships a PRM-owned thin-wrapper form (following the pattern at `customer_accounts/backend/customer_accounts/users/[id]/page.tsx`) that calls `customer_accounts`' admin role-assignment API.
- For US1.6 (lockout recovery: promote PartnerMember → PartnerAdmin), the same form handles role reassignment — one API call away.
- Scope: backend only. No portal surface for role management (role reassignment is an OM PartnerOps action, not a PartnerAdmin action — per App Spec §2 matrix).

**Sizing impact:** Spec #1 unchanged — the "thin wrapper form" was already allocated in the estimate.

---

## Q5. Re-invite cooldown mechanism — **RESOLVED: USE `@open-mercato/shared/lib/ratelimit`**

**Evidence:**
- `packages/shared/src/lib/ratelimit/index.ts` exports `RateLimiterService`, `checkRateLimit`, `getClientIp`.
- `packages/shared/src/lib/ratelimit/service.ts:17-60` — `RateLimiterService.consume(key, config)` with memory + Redis backing (strategy-selectable).
- Supports arbitrary keys — the cooldown key for re-invite is `invite:${recipientEmail}:${agencyId}`.

**Applied to Spec #1:**
- **Delete** the `last_invite_sent_at` column from the `AgencyMember` data model.
- The re-invite endpoint calls `RateLimiterService.consume('invite:' + email + ':' + agency_id, { points: 1, duration: 24 * 60 * 60 })` (1 invite per recipient per 24h — tune duration from proxy-lessons if needed).
- On rate-limit violation, return `429` with standard error envelope.

**Sizing impact:** Spec #1 saves zero commits but removes a PRM-owned schema concern (one fewer migration + one fewer column to test).

---

## Summary

| # | Question | Resolution | Spec impact |
|---|---|---|---|
| Q1 | Markdown editor | YES ships (`SwitchableMarkdownInput`) | Specs #5 + #7: import directly, −1 commit each vs. contingency |
| Q2 | createInvitation tx participation | YES (EM via DI) | Spec #1: no contingency needed |
| Q3 | CustomerUserInvitation.metadata | NOT NEEDED (`roleIds` is first-class) | Spec #1: simplified subscriber, dropped hint-table contingency |
| Q4 | CustomerUserRole CrudForm | NO shipped component; APIs ship | Spec #1: thin wrapper form on B2 (already allocated) |
| Q5 | Re-invite cooldown | USE `@open-mercato/shared/lib/ratelimit` | Spec #1: drop `last_invite_sent_at` column |

**Net sizing impact:** Specs #5 and #7 each save 1 potential commit (markdown editor). Total revised: **~33–40** (from ~35–42). MVP Phases 1–3 unchanged at **~18–23**.
