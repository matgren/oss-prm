---
proxy_name: Matom
---

# Proxy Lessons

Decisions made on behalf of the user, scoped to this app.

- **Decision:** Open-vocabulary tag fields (`technologies`, `services`) on Agency profile + Case Study; per-agency suggestion scope; no merge/cleanup admin tool.
  **Context:** User session 2026-05-10 — reviewed closed-list TagsInput on case-studies form (`allowCustomValues={false}`), declared it "terrible UX", picked type-and-enter creates, LLM tolerates downstream typos.
  **Reasoning:** User words: "let just make it type and enter for technology/services separate per case study and agency profile and just visible in their agency scope (org), so if agency 1 adds reactt with typo this is not visible neither in agency profile (if reactt was added in case study and vice versa) and reactt is not visible in autocomplete in agency 2 when it tries to add case study or profile update, same for services". Industries field stays closed-dictionary (user explicit). RFP `requiredCapabilities` flips to TagsInput too with tenant-wide suggestions (OM-staff-only form, no leak concern).
  **How to apply:** Storage = trim only, verbatim casing. Suggestions = read distinct from existing rows (no separate vocabulary table). Tag auto-disappears from autocomplete when last referent removed (natural behavior). No backfill needed — existing case-study slugs remain valid strings and naturally surface as suggestions. P3 portal write ACL: `partner_admin` writes own-agency tech/services (mirrors existing P3 profile write pattern); `partner_member` read-only. Don't delete inert `technologies`/`services` seed code in v1 (bounded tech debt per global rule).
  **Date:** 2026-05-10

- **Decision:** LLM matching is for Spec #6 scoring, not Spec #5 eligibility.
  **Context:** During open-vocab amendment design 2026-05-10, user said "matching will be done with LLM too so no worries with typos". Verified in code: `rfpEligibility.ts` uses tier + explicit list only; capabilities not consumed. `llmScoringDraft.ts` is wired for response scoring, not eligibility filtering.
  **Reasoning:** User mental model conflates eligibility and scoring. Both arguments still favor open-vocab: scoring is LLM-tolerant of typos in capability strings, and eligibility doesn't touch capabilities at all today. Free-form is safe.
  **How to apply:** When user invokes "LLM handles matching" rationale for capability/tag policy decisions, accept the conclusion but verify what the LLM actually consumes. Don't propose new LLM matching pipelines unless user explicitly scopes one — they don't exist today.
  **Date:** 2026-05-10
