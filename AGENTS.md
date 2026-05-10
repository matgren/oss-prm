# Agent Context Routing — standalone-app

**MANDATORY CONTEXT LOADING** — see Critical Rule #5 below.
Before writing code, find your task below and `Read` the listed files.
Do NOT load the entire src/ tree — Open Mercato apps can have many modules.

## What This Project Is

A standalone Open Mercato application built ON TOP of the framework.
The framework lives in `node_modules/@open-mercato/*`. Never edit `node_modules` directly.
Install official packages with `yarn mercato module add @open-mercato/<package>`.
To customise a built-in module beyond extensions, eject with `yarn mercato eject <module>`.

## Task → Context Map

Match your task below, then **STOP** and either invoke the listed skill OR `Read` the listed file(s) before writing any code. A task may match multiple rows — load all of them. If you skip this step, you WILL produce incorrect imports and miss required patterns.

> **Skill invocation note:** rows that say `invoke om-superpowers:om-<name>` mean call the Skill tool with that name. The skill's Task Router then loads the right reference (e.g., `om-implement-spec` routes module-scaffold, data-model-design, system-extension, integration-builder via its internal router). Do NOT try to `Read` `.ai/skills/...` files — those moved into the om-superpowers plugin during the v1.x migration.

### Module Development

| Task | Load |
|---|---|
| Scaffold a new module from scratch | invoke `om-superpowers:om-implement-spec` (router → module-scaffold reference) |
| Design entities and relationships | invoke `om-superpowers:om-implement-spec` (router → data-model-design reference) |
| Build backend UI (forms, tables, pages) | invoke `om-superpowers:om-ds-guardian` (DS-compliant CRUD/data-table/form pages) |
| Build an integration provider | invoke `om-superpowers:om-implement-spec` (router → integration-builder reference) |

### Extending Core Modules (UMES)

| Task | Load |
|---|---|
| Extend a core module (add fields, columns, menus, interceptors, enrichers) | invoke `om-superpowers:om-implement-spec` (router → system-extension reference) |
| Eject and customize a core module | invoke `om-superpowers:om-implement-spec` (router → system-extension/eject.md) |
| Add a response enricher to another module's API | `.ai/guides/core.md` → Response Enrichers |
| Add an API interceptor (before/after hooks) | `.ai/guides/core.md` → API Interceptors |
| Inject widgets into forms/tables/menus | `.ai/guides/core.md` → Widget Injection |
| Replace or wrap a UI component | `.ai/guides/core.md` → Component Replacement |

### Framework Feature Usage

| Task | Load |
|---|---|
| Add/modify an entity, create migration | `.ai/guides/core.md` → Module Files, then `yarn mercato db generate` |
| Add a REST API endpoint | `.ai/guides/core.md` → API Routes |
| Add a backend page | `.ai/guides/ui.md` → CrudForm / DataTable |
| Configure sidebar navigation, page groups, settings pages | invoke `om-superpowers:om-implement-spec` (router → module-scaffold/navigation-patterns) |
| Add event subscribers or emit events | `.ai/guides/events.md` |
| Add real-time browser updates (SSE) | `.ai/guides/events.md` → DOM Event Bridge |
| Add search to a module | `.ai/guides/search.md` |
| Add caching | `.ai/guides/cache.md` |
| Add background workers | `.ai/guides/queue.md` |
| Use i18n (translations) | `.ai/guides/shared.md` → i18n |
| Use encrypted queries | `.ai/guides/shared.md` → Encryption |
| Use apiCall / UI components | `.ai/guides/ui.md` |
| Add permissions (RBAC) | `.ai/guides/core.md` → Access Control |
| Add notifications | `.ai/guides/core.md` → Notifications |
| Add custom fields | `.ai/guides/core.md` → Custom Fields |

### Module-Specific Guides

These guides ship automatically when the corresponding module is installed.

| Task | Load |
|---|---|
| Build CRUD modules — reference patterns, commands, custom fields, search | `.ai/guides/core.customers.md` (if available) |
| Use workflow automation, triggers, user tasks, signals | `.ai/guides/core.workflows.md` (if available) |
| Use product catalog, pricing engine, variants, offers | `.ai/guides/core.catalog.md` (if available) |
| Use sales orders, quotes, invoices, shipments, payments | `.ai/guides/core.sales.md` (if available) |
| Use staff authentication, RBAC, roles, feature guards | `.ai/guides/core.auth.md` (if available) |
| Use multi-currency, exchange rates, dual recording | `.ai/guides/core.currencies.md` (if available) |
| Build integration providers, credentials, health checks | `.ai/guides/core.integrations.md` (if available) |
| Build data sync adapters, import/export connectors | `.ai/guides/core.data_sync.md` (if available) |
| Use customer portal auth, customer RBAC, portal pages | `.ai/guides/core.customer_accounts.md` (if available) |

### Quality & Process

| Task | Load |
|---|---|
| Debug / fix errors | invoke `om-superpowers:om-troubleshooter` |
| Review code changes | invoke `om-superpowers:om-code-review` |
| Write a spec | invoke `om-superpowers:om-cto` (router → spec-writing), plus `.ai/specs/SPEC-000-template.md` |
| Implement a spec (or selected phases) | invoke `om-superpowers:om-implement-spec` |
| Create / run integration tests | invoke `om-superpowers:om-integration-tests` |
| Add / run PRM integration tests (tenant-per-worker fixture) | `.ai/guides/prm.testing.md` |
| Upgrade framework from 0.4.10 to 0.5.0 | One-off skill not vendored to consumer apps; clone OM and read `OM/.ai/skills/auto-upgrade-0.4.10-to-0.5.0/SKILL.md` |

## Module Anatomy

Each module in `src/modules/<id>/` is self-contained and auto-discovered:

```
src/modules/<id>/
├── index.ts              # Module metadata
├── data/
│   ├── entities.ts       # MikroORM entity classes
│   ├── validators.ts     # Zod validation schemas
│   ├── extensions.ts     # Cross-module entity links
│   └── enrichers.ts      # Response enrichers
├── api/
│   ├── <resource>/route.ts  # REST handlers (auto-discovered by method)
│   └── interceptors.ts      # API route interception hooks
├── backend/              # Admin UI pages (auto-discovered)
│   └── page.tsx          # → /backend/<module>
├── frontend/             # Public pages (auto-discovered)
├── subscribers/          # Event handlers (export metadata + default handler)
├── workers/              # Background jobs (export metadata + default handler)
├── widgets/
│   ├── injection/        # UI widgets injected into other modules
│   ├── injection-table.ts # Widget-to-slot mappings
│   └── components.ts     # Component replacement/wrapper definitions
├── di.ts                 # Awilix DI registrations
├── acl.ts                # Permission features
├── setup.ts              # Tenant init, role features, seed data
├── events.ts             # Typed event declarations
├── search.ts             # Search indexing configuration
├── ce.ts                 # Custom entities / custom field sets
├── translations.ts       # Translatable fields per entity
├── notifications.ts      # Notification type definitions
└── notifications.client.ts  # Client-side notification renderers
```

Register in `src/modules.ts`: `{ id: '<id>', from: '@app' }`

## CRITICAL rules — always follow without exception

1. **After editing any entity file**: run `yarn mercato db generate` (never hand-write migrations)
2. **After editing `src/modules.ts`** or any structural module file: run `yarn generate`
3. **Never edit `.mercato/generated/*`** — auto-generated. Never edit `node_modules/@open-mercato/*` — eject instead.
4. **Confirm migrations with user** before running `yarn mercato db migrate`
5. **BEFORE writing ANY code**, you MUST:
   - Match your task against the **Task → Context Map** above
   - For each matched row: if the row says `invoke om-superpowers:om-<name>`, call that Skill via the Skill tool (do not Read the plugin files manually — the skill's Task Router decides which references load). If the row lists a `.ai/guides/...` path, `Read` it.
   - Only then proceed to implementation
   - If your task matches multiple rows, load ALL listed files / invoke ALL listed skills
   - **Do NOT skip this step.** The guides + skill references contain canonical import paths, required patterns, and conventions that CANNOT be reliably inferred from existing code alone. Skipping leads to wrong imports, missing conventions, and rework.
   - **Do NOT silently skip a "missing" `.ai/skills/<name>/SKILL.md` reference.** If you find one in older docs or PR feedback, the file moved into the om-superpowers plugin — invoke `om-superpowers:om-<name>` (or the closest plugin skill per this map) instead of giving up.

## Additional Conventions

- Custom modules use `from: '@app'` in `src/modules.ts`
- Standalone apps expose `yarn mercato configs cache ...` because the template enables the `configs` module from `@open-mercato/core`
- `yarn generate` automatically runs a best-effort structural cache purge (`yarn mercato configs cache structural --all-tenants`) after successful generation; if the cache command is unavailable, generation still succeeds
- Sidebar icons MUST use `lucide-react` components — never inline SVG via `React.createElement`
- `page.meta.ts` MUST include `pageGroup`, `pageGroupKey`, and `pageOrder` for sidebar grouping
- Settings pages MUST use `pageContext: 'settings' as const` with `navHidden: true`
- All related pages within a module MUST share the same `pageGroupKey`
- DataTable MUST wire pagination props (`page`, `pageSize`, `totalCount`, `onPageChange`)

## Naming Conventions

- Module IDs: plural, snake_case (`order_items`)
- Event IDs: `module.entity.action` (singular entity, past tense: `sales.order.created`)
- DB tables: plural, snake_case with module prefix (`catalog_products`)
- DB columns: snake_case (`created_at`, `organization_id`)
- JS/TS identifiers: camelCase
- Feature IDs: `<module>.<action>` (`my_module.view`, `my_module.create`)
- UUID primary keys, explicit foreign keys, junction tables for M2M

## Key Imports Quick Reference

```typescript
// Translations
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

// API calls (MUST use — never raw fetch)
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

// CRUD forms
import { CrudForm, createCrud, updateCrud, deleteCrud } from '@open-mercato/ui/backend/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'

// UI components (MUST use — never raw <button>)
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { FormHeader, FormFooter } from '@open-mercato/ui/backend/forms'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

// Encrypted queries (MUST use instead of em.find)
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'

// Events
import { createModuleEvents } from '@open-mercato/shared/modules/events'

// Widget injection
import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'

// Types
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'
import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'
```

## Key Commands

| Command | Purpose |
|---|---|
| `yarn dev` | Start compact dev runtime (`d` toggles raw logs) |
| `yarn dev:verbose` | Start dev runtime with full raw passthrough logs |
| `yarn generate` | Regenerate `.mercato/generated/` |
| `yarn mercato configs cache structural --all-tenants` | Manually purge structural navigation/sidebar cache entries |
| `yarn mercato module add <package>` | Install and enable an official module package |
| `yarn mercato db generate` | Create migration for entity changes |
| `yarn mercato db migrate` | Apply pending migrations |
| `yarn initialize` | Bootstrap DB + first admin account |
| `yarn build` | Build for production |
| `yarn mercato eject <module>` | Copy a core module into `src/modules/` |

## Integration test environment

`yarn test:integration:ephemeral` (which runs `mercato test:integration`) requires `OM_PRM_WIC_IMPORT_SECRET` to be set, otherwise the WIC ingestion routes return `503 "WIC import secret not configured"`. The var is commented out in `.env.example` — uncomment it (or export it in your test shell) before running the suite:

| Env var | Enables |
|---|---|
| `OM_PRM_WIC_IMPORT_SECRET=<32+ char secret>` | The `X-Om-Import-Secret` header check on `/api/prm/service/wic/*`. |

See `.env.example` (PRM WIC Ingestion block) for the canonical value and rotation notes.

> **Note:** PRM previously had a second env var (`OM_PRM_TEST_FIXTURES_ENABLED`) that gated test-only HTTP routes shipped in the prod bundle. Both the env var and those routes were deleted on 2026-05-09 (issue #39 + the abandoned SPEC-2026-05-09). The whole PRM Playwright integration suite was deleted alongside them — pending a tenant-per-spec rebuild per the new spec.

## Architecture Rules

- NO direct ORM relationships between modules — use foreign key IDs
- Always filter by `organization_id` for tenant-scoped entities
- Validate all inputs with Zod; derive types via `z.infer`
- Use DI (Awilix) for services; avoid `new`-ing directly
- No `any` types — use Zod schemas with `z.infer`, narrow with runtime checks
- Every dialog: `Cmd/Ctrl+Enter` submit, `Escape` cancel
- Keep `pageSize` at or below 100
- Every API route MUST export `openApi`

## Stack

Next.js App Router, TypeScript, MikroORM, Awilix DI, Zod
