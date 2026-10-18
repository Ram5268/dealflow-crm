import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Brief 41.2 (PR F), an engineering precaution from the Oct 16, 2026 system-map
// review: the CRM's DealFlow read-only setting is read in one place, the
// read-only client, so every query the CRM sends to DealFlow (Brief 44's
// property subquery included) runs inside its READ ONLY transaction. Other
// code asks dealflowRoConfigured(). Comments may name the setting. No database.
const SETTING = 'DATABASE_URL_DEALFLOW_RO'
const CLIENT = 'src/lib/core-data/dealflow-sync/ro-client.ts'
const THIS_FILE = 'tests/unit/dealflow-ro-setting.test.ts'

// Test files allowed to set it (assign or delete, never read it), and why.
const MAY_SET: Record<string, string> = {
  'tests/unit/dealflow-ro-client.test.ts': 'an address nothing listens on; pg connect() is replaced',
  'tests/unit/health-dealflow-probe.test.ts': 'an address nothing listens on; pg connect() is replaced',
  'tests/dealflow-ro-client.readonly.test.ts': "CI's throwaway test database (db-suite), never DealFlow's",
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
// Not code of this checkout: dependencies, build output, other checkouts (worktrees/).
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'worktrees', 'coverage', 'coverage-comms', 'playwright-report', 'test-results', '.vercel'])
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

type Use = { file: string; line: number; kind: 'read' | 'write' }

function codeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) codeFiles(full, out)
    } else if (entry.isFile() && CODE.test(entry.name)) out.push(full)
  }
  return out
}

// `process.env.X = …`, `process.env['X'] = …` and `delete process.env.X` set
// the setting; every other mention of the name in code reads it.
function isWrite(node: ts.Node): boolean {
  const access = node.parent
  const named =
    (ts.isPropertyAccessExpression(access) && access.name === node) ||
    (ts.isElementAccessExpression(access) && access.argumentExpression === node)
  if (!named) return false
  const parent = access.parent
  if (ts.isDeleteExpression(parent)) return true
  return ts.isBinaryExpression(parent) && parent.left === access && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

// Every identifier or string spelling the name: process.env.X,
// process.env['X'], `const { X } = process.env`, a helper given 'X'.
function usesIn(text: string, file = 'inline.ts'): Use[] {
  if (!text.includes(SETTING)) return []
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const out: Use[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === SETTING) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      out.push({ file, line, kind: isWrite(node) ? 'write' : 'read' })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const uses = codeFiles(ROOT)
  .map((full) => path.relative(ROOT, full).split(path.sep).join('/'))
  .filter((file) => file !== THIS_FILE)
  .flatMap((file) => usesIn(readFileSync(path.join(ROOT, file), 'utf8'), file))

describe(`${SETTING} is read only by the DealFlow read-only client`, () => {
  it('the scan tells reads from writes, and skips comments', () => {
    expect(usesIn(`const u = process.env.${SETTING}`).map((u) => u.kind)).toEqual(['read'])
    expect(usesIn(`if (!process.env['${SETTING}']) throw 1`).map((u) => u.kind)).toEqual(['read'])
    expect(usesIn(`const { ${SETTING}: url } = process.env`).map((u) => u.kind)).toEqual(['read'])
    expect(usesIn(`const { ${SETTING} } = process.env`).map((u) => u.kind)).toEqual(['read'])
    expect(usesIn(`new Client({ connectionString: env.${SETTING} })`).map((u) => u.kind)).toEqual(['read'])
    expect(usesIn(`process.env.${SETTING} = 'postgresql://x/y_test'`).map((u) => u.kind)).toEqual(['write'])
    expect(usesIn(`delete process.env['${SETTING}']`).map((u) => u.kind)).toEqual(['write'])
    expect(usesIn(`// ${SETTING} in a comment\n/* and ${SETTING} here */ const x = 1`)).toEqual([])
  })

  it('the read-only client reads it (so the scan does see the code)', () => {
    expect(uses.some((u) => u.file === CLIENT && u.kind === 'read')).toBe(true)
  })

  it('nothing else reads it', () => {
    expect(uses.filter((u) => u.kind === 'read' && u.file !== CLIENT)).toEqual([])
  })

  it('only the listed test files set it', () => {
    expect(uses.filter((u) => u.kind === 'write' && !(u.file in MAY_SET))).toEqual([])
  })
})
