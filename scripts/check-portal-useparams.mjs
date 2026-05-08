#!/usr/bin/env node
/**
 * Guard: forbid `useParams` inside `src/modules/<module>/frontend/[orgSlug]/portal/**`.
 *
 * In standalone-app, the actual Next.js route is the catch-all
 * `src/app/(frontend)/[...slug]/page.tsx`, which extracts dynamic segments via
 * the OM module manifest matcher and passes them to module pages as a `params`
 * prop: `<Component params={match.params} />`.
 *
 * `useParams()` from `next/navigation` reflects the *Next.js* segment shape
 * (`{ slug: string[] }` for the catch-all), NOT `{ orgSlug, id, ... }`. Pages
 * that call `useParams<{ orgSlug: string }>()` always get `undefined`, fall
 * back to `''`, and produce malformed hrefs like `//portal/case-studies/new`
 * (protocol-relative URLs the browser interprets as `http://portal/...`).
 *
 * Correct pattern: accept `params` as a function prop.
 *
 *   type Props = { params: { orgSlug: string; id?: string } }
 *   export default function MyPage({ params }: Props) { ... }
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'modules')
const PATTERN_DIR_FRAGMENT = ['frontend', '[orgSlug]', 'portal'].join(sep)
const FORBIDDEN = /\buseParams\b/

const offenders = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (!full.includes(PATTERN_DIR_FRAGMENT)) continue
    const content = readFileSync(full, 'utf8')
    if (FORBIDDEN.test(content)) {
      offenders.push(full)
    }
  }
}

walk(ROOT)

if (offenders.length > 0) {
  console.error('\n[check-portal-useparams] useParams() is forbidden under frontend/[orgSlug]/portal/**\n')
  console.error('Reason: the (frontend) catch-all already passes `params` as a prop. useParams() returns the')
  console.error('catch-all\'s {slug: string[]} shape, not {orgSlug,id}, producing malformed hrefs like //portal/...\n')
  console.error('Fix: accept `{ params }: { params: { orgSlug: string; id?: string } }` as a function prop.\n')
  console.error('Offenders:')
  for (const f of offenders) {
    console.error('  - ' + f)
  }
  console.error('')
  process.exit(1)
}

console.log('[check-portal-useparams] OK — no offenders found.')
