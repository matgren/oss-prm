#!/usr/bin/env node
// Defensive workaround for an upstream framework bug.
//
// `@open-mercato/shared/lib/bootstrap/dynamicLoader.js` (`compileAndImport`)
// caches an esbuild-bundled `.mjs` next to each `.mercato/generated/*.ts`
// and only recompiles when the OUTER `.ts` file's mtime is newer than the
// `.mjs`. The generator skips writing `entities.generated.ts` (and friends)
// when the file's checksum is unchanged — which happens whenever entities
// are added to an EXISTING module's `data/entities.ts`, because the
// generated wildcard import (`import * as E_<module>_N from ".../<module>/data/entities"`)
// is structurally stable.
//
// Net effect: the bundled `.mjs` keeps the OLD entity set baked in by esbuild,
// so MikroORM is initialised without the new entities, and the QueryEngine
// fallback emits "Could not resolve entity" warnings followed by SQL errors
// against non-existent tables (e.g. `license_deals` instead of `prm_license_deals`).
//
// The safest fix that lives entirely inside this app is to nuke the cached
// `.mjs` bundles before any `mercato init` invocation, forcing a fresh
// esbuild pass that follows transitive imports.
//
// First observed: 2026-05-05, after PRM Spec #3 (LicenseDeal) shipped.

import fs from 'node:fs'
import path from 'node:path'

const generatedDir = path.join(process.cwd(), '.mercato', 'generated')
if (!fs.existsSync(generatedDir)) {
  process.exit(0)
}

const removed = []
for (const entry of fs.readdirSync(generatedDir)) {
  if (!entry.endsWith('.generated.mjs')) continue
  const target = path.join(generatedDir, entry)
  try {
    fs.unlinkSync(target)
    removed.push(entry)
  } catch (error) {
    console.warn(`[bust-bootstrap-cache] could not remove ${entry}: ${error.message}`)
  }
}

if (removed.length > 0) {
  console.log(`[bust-bootstrap-cache] cleared ${removed.length} stale bundle(s) (${removed.join(', ')})`)
}
