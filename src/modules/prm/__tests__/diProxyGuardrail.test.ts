/**
 * DI guardrail — every destructured-param asFunction registration across
 * src/modules-slash-asterisk-slash-di.ts MUST chain dot-proxy().
 *
 * Why: the request container in @open-mercato/shared/lib/di/container uses
 * Awilix InjectionMode.CLASSIC, which does NOT inject named dependencies
 * into destructured factory params unless the registration is explicitly
 * proxy()-ed. Without it, "em" (and any other named dep) arrives as
 * undefined and the first ORM call throws TypeError. We hit this twice on
 * Spec #1 (commits d0141c2 and c488dbb) before the convention was
 * understood.
 *
 * Origin: POST-MVP-FOLLOW-UPS Tracker — "DI guardrail test" (Effort: S).
 * Bundled into Spec #5 because Spec #5 adds new DI registrations and we
 * want to fail fast if any of them omit proxy().
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const MODULES_DIR = path.resolve(__dirname, '../../')

type Violation = { file: string; line: number; snippet: string }

function listModuleDiFiles(): string[] {
  const entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const diPath = path.join(MODULES_DIR, entry.name, 'di.ts')
    if (fs.existsSync(diPath)) out.push(diPath)
  }
  return out
}

/**
 * Match registrations of the form:
 *   asFunction(({ ... }) => ...) ... .scoped() / .singleton() / .proxy()
 *
 * We capture the full chain greedily up to the first comma at depth 0 OR end
 * of the line that closes the chain. Then we verify .proxy() appears in it.
 */
function scanDiFile(filePath: string): Violation[] {
  const source = fs.readFileSync(filePath, 'utf8')
  const violations: Violation[] = []
  // Locate every `asFunction(` followed by `(` then `{` (destructured factory).
  const opens: number[] = []
  for (let i = 0; i < source.length - 12; i++) {
    if (source.startsWith('asFunction(', i)) {
      // Look for `({` immediately after, allowing whitespace.
      let j = i + 'asFunction('.length
      while (j < source.length && /\s/.test(source[j]!)) j++
      if (source[j] === '(' && /\s*\{/.test(source.slice(j + 1, j + 4))) {
        opens.push(i)
      }
    }
  }

  for (const start of opens) {
    // Walk forward, balancing parens, until depth returns to zero.
    let depth = 0
    let end = start
    for (let j = start; j < source.length; j++) {
      const ch = source[j]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = j + 1
          break
        }
      }
    }
    // Continue accumulating chained method calls (.scoped(), .proxy(), etc.)
    // until we hit a comma OR a newline whose next non-whitespace char starts
    // a new statement (identifier + `:`, indicating the next DI key).
    let chainEnd = end
    let k = end
    while (k < source.length) {
      const ch = source[k]
      if (ch === ',') break
      if (ch === '\n') {
        // Peek next non-whitespace char.
        let m = k + 1
        while (m < source.length && /[ \t]/.test(source[m]!)) m++
        if (source[m] === '\n' || source[m] === '}') break
        // If the next token looks like a registration key followed by `:`,
        // we've moved on. Otherwise (e.g. .proxy() on its own line), continue.
        if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(source.slice(m, m + 80))) break
      }
      k++
      chainEnd = k
    }
    const snippet = source.slice(start, chainEnd)
    if (!/\.proxy\s*\(\s*\)/.test(snippet)) {
      const lineNumber = source.slice(0, start).split('\n').length
      violations.push({
        file: path.relative(MODULES_DIR, filePath),
        line: lineNumber,
        snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 200),
      })
    }
  }
  return violations
}

describe('DI proxy guardrail (POST-MVP-FOLLOW-UPS — DI guardrail test)', () => {
  it('finds at least one di.ts to scan in src/modules', () => {
    const files = listModuleDiFiles()
    expect(files.length).toBeGreaterThan(0)
  })

  it('every destructured-param asFunction registration chains .proxy()', () => {
    const files = listModuleDiFiles()
    const allViolations: Violation[] = []
    for (const filePath of files) {
      allViolations.push(...scanDiFile(filePath))
    }
    if (allViolations.length > 0) {
      const lines = allViolations
        .map((v) => '  ' + v.file + ':' + v.line + '\n    ' + v.snippet)
        .join('\n')
      throw new Error(
        'Found ' +
          allViolations.length +
          ' destructured-factory registration(s) missing .proxy():\n' +
          lines +
          '\n\nAwilix InjectionMode.CLASSIC does NOT inject destructured params unless the ' +
          'registration chains .proxy(). Without it, em and other named deps arrive as undefined ' +
          'at runtime. Fix: add .proxy() after .scoped() / .singleton().',
      )
    }
    expect(allViolations).toHaveLength(0)
  })
})
