import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createDiagnosticTail,
  sanitizeDiagnosticLine,
} from './lib/ci-diagnostic-tail.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const runner = await readFile(path.join(root, 'scripts/run-ci-workspace-tests.mjs'), 'utf8')

test('workspace CI test graph uses the bounded diagnostic runner', () => {
  assert.match(
    workflow,
    /- name: Verify workspace test graph[\s\S]*?run: node scripts\/run-ci-workspace-tests\.mjs/u,
  )
  assert.doesNotMatch(workflow, /^\s+- run: pnpm turbo run test\s*$/mu)
  assert.match(runner, /--concurrency=2/u)
  assert.match(runner, /--output-logs=full/u)
  assert.match(runner, /createDiagnosticTail\(120\)/u)
  assert.match(runner, /::error title=Workspace test graph failed::/u)
  assert.doesNotMatch(runner, /printenv|set\s+-x/iu)
})

test('diagnostic tail stays bounded to the newest lines', () => {
  const tail = createDiagnosticTail(3)
  for (const line of ['one', 'two', 'three', 'four']) tail.push(line)
  assert.deepEqual(tail.values(), ['two', 'three', 'four'])
})

test('diagnostic annotations escape commands and redact common credential shapes', () => {
  assert.equal(sanitizeDiagnosticLine('line%one\r\ntwo'), 'line%25one%0D%0Atwo')
  assert.equal(sanitizeDiagnosticLine('API_TOKEN=abc123'), 'API_TOKEN=[REDACTED]')
  assert.equal(
    sanitizeDiagnosticLine('DATABASE_URL=postgresql://user:pass@db/test'),
    'DATABASE_URL=[REDACTED]',
  )
  assert.equal(
    sanitizeDiagnosticLine('fetch https://user:pass@example.test Bearer abc.def'),
    'fetch https://user:[REDACTED]@example.test Bearer [REDACTED]',
  )
})
