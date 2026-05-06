// Central place to enable modules and their source.
// - id: module id (plural snake_case; special cases: 'auth')
// - from: '@open-mercato/core' | '@app' | custom alias/path in future
//
// Pruned 2026-05-06 from the standalone-app template default. The kept set is
// derived from PRM evidence: PRM `index.ts` `requires`, direct imports across
// `src/modules/prm/`, subscriber event targets, and transitive imports from
// kept core modules. See git log message for the full evidence table.
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string }

export const enabledModules: ModuleEntry[] = [
  // PRM-direct dependencies (declared in src/modules/prm/index.ts `requires`
  // and/or imported in PRM source).
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'customers', from: '@open-mercato/core' },        // required by mercato test:integration readiness probe (GET /api/customers/people)
  { id: 'customer_accounts', from: '@open-mercato/core' },
  { id: 'directory', from: '@open-mercato/core' },
  { id: 'events', from: '@open-mercato/events' },
  { id: 'notifications', from: '@open-mercato/core' },
  { id: 'dictionaries', from: '@open-mercato/core' },
  { id: 'workflows', from: '@open-mercato/core' },
  { id: 'query_index', from: '@open-mercato/core' },
  { id: 'portal', from: '@open-mercato/core' },
  { id: 'attachments', from: '@open-mercato/core' },

  // Transitive deps from the kept set (verified by grep against
  // node_modules/@open-mercato/core/src/modules/<kept>/...).
  { id: 'api_keys', from: '@open-mercato/core' },        // auth/services/rbacService.ts
  { id: 'entities', from: '@open-mercato/core' },        // auth/lib/backendChrome.tsx, setup-app.ts
  { id: 'feature_toggles', from: '@open-mercato/core' }, // portal/setup.ts
  { id: 'configs', from: '@open-mercato/core' },         // notifications/lib/deliveryConfig.ts
  { id: 'translations', from: '@open-mercato/core' },    // dictionaries + entities UI
  { id: 'dashboards', from: '@open-mercato/core' },      // auth backend role/user edit pages
  { id: 'business_rules', from: '@open-mercato/core' },  // workflows/cli.ts + seeds.ts
  { id: 'progress', from: '@open-mercato/core' },        // query_index/subscribers/reindex.ts

  // Platform infrastructure (admin users, audit observability).
  { id: 'staff', from: '@open-mercato/core' },
  { id: 'audit_logs', from: '@open-mercato/core' },

  // PRM application module.
  { id: 'prm', from: '@app' },
]

const enterpriseModulesEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, false)
const enterpriseSsoEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)
const enterpriseSecurityEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY, false)

if (enterpriseModulesEnabled) {
  enabledModules.push(
    { id: 'record_locks', from: '@open-mercato/enterprise' },
    { id: 'system_status_overlays', from: '@open-mercato/enterprise' },
  )
}

if (enterpriseModulesEnabled && enterpriseSsoEnabled) {
  enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseSecurityEnabled) {
  enabledModules.push({ id: 'security', from: '@open-mercato/enterprise' })
}
