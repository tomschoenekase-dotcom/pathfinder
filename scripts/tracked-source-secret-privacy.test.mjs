import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const maximumScannedBytes = 2 * 1024 * 1024

const protectedLocalPaths = new Set(['.claude/settings.local.json', '.env', '.env.local'])

const protectedPathPatterns = [
  /(?:^|\/)\.env\.(?!example$)[^/]+$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519)$/u,
  /\.(?:key|pem|p12|pfx)$/u,
]

const credentialPatterns = [
  {
    id: 'private-key-header',
    expression: new RegExp(
      ['-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA )?', 'PRIVATE KEY-----'].join(''),
      'u',
    ),
  },
  {
    id: 'openai-api-key',
    expression: new RegExp(['sk-', '(?!ant-)', '(?:proj-)?', '[A-Za-z0-9_-]{20,}'].join(''), 'u'),
  },
  {
    id: 'anthropic-api-key',
    expression: new RegExp(['sk-', 'ant-', '[A-Za-z0-9_-]{20,}'].join(''), 'u'),
  },
  {
    id: 'stripe-live-key',
    expression: new RegExp(['(?:sk|rk)', '_live_', '[A-Za-z0-9]{16,}'].join(''), 'u'),
  },
  {
    id: 'github-token',
    expression: new RegExp(['gh', '[pousr]_', '[A-Za-z0-9]{20,}'].join(''), 'u'),
  },
  {
    id: 'aws-access-key',
    expression: new RegExp(['(?:AK', 'IA|AS', 'IA)', '[A-Z0-9]{16}'].join(''), 'u'),
  },
  {
    id: 'slack-token',
    expression: new RegExp(['xox', '[baprs]-', '[A-Za-z0-9-]{20,}'].join(''), 'u'),
  },
]

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replaceAll('\\', '/'))
}

function scanContent(relativePath, content) {
  return credentialPatterns
    .filter(({ expression }) => expression.test(content))
    .map(({ id }) => ({ path: relativePath, pattern: id }))
}

test('tracked paths exclude local settings, real environment files, and private-key containers', () => {
  const unsafePaths = trackedFiles().filter(
    (relativePath) =>
      protectedLocalPaths.has(relativePath) ||
      protectedPathPatterns.some((expression) => expression.test(relativePath)),
  )
  assert.deepEqual(unsafePaths, [])
})

test('tracked text excludes high-confidence credential patterns without reporting matched values', async () => {
  const findings = []
  for (const relativePath of trackedFiles()) {
    const absolutePath = path.join(repositoryRoot, relativePath)
    let metadata
    try {
      metadata = await stat(absolutePath)
    } catch {
      continue
    }
    if (!metadata.isFile() || metadata.size > maximumScannedBytes) continue

    let content
    try {
      content = await readFile(absolutePath, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue
    findings.push(...scanContent(relativePath, content))
  }

  assert.deepEqual(findings, [])
})

test('credential pattern canaries are detected by identifier and path only', () => {
  const canaries = [
    ['openai-api-key', ['sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1'].join('')],
    ['anthropic-api-key', ['sk-', 'ant-', 'A1b2C3d4E5f6G7h8I9j0K1'].join('')],
    ['stripe-live-key', ['sk', '_live_', 'A1b2C3d4E5f6G7h8'].join('')],
    ['github-token', ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1'].join('')],
    ['aws-access-key', ['AK', 'IA', 'A1B2C3D4E5F6G7H8'].join('')],
    ['slack-token', ['xox', 'b-', 'A1b2C3d4E5f6G7h8I9j0-K1'].join('')],
  ]

  for (const [pattern, canary] of canaries) {
    const findings = scanContent('fixture.txt', canary)
    assert.deepEqual(findings, [{ path: 'fixture.txt', pattern }])
    assert.equal(JSON.stringify(findings).includes(canary), false)
  }
})
