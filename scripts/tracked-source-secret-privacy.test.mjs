import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

// Credential prefixes must begin and end at lexical token boundaries. This
// keeps ordinary filenames such as `front-desk-...pdf` out of the scan while
// still allowing punctuation, query delimiters, quotes, and newlines around a
// credential token.
const credentialTokenBoundary = '(?<![A-Za-z0-9_-])'
const credentialTokenEndBoundary = '(?![A-Za-z0-9_-])'

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
    expression: new RegExp(
      [credentialTokenBoundary, 'sk-', '(?!ant-)', '(?:proj-)?', '[A-Za-z0-9_-]{20,}', credentialTokenEndBoundary].join(''),
      'u',
    ),
  },
  {
    id: 'anthropic-api-key',
    expression: new RegExp(
      [credentialTokenBoundary, 'sk-', 'ant-', '[A-Za-z0-9_-]{20,}', credentialTokenEndBoundary].join(''),
      'u',
    ),
  },
  {
    id: 'stripe-live-key',
    expression: new RegExp(
      [credentialTokenBoundary, '(?:sk|rk)', '_live_', '[A-Za-z0-9]{16,}', credentialTokenEndBoundary].join(''),
      'u',
    ),
  },
  {
    id: 'github-token',
    expression: new RegExp(
      [credentialTokenBoundary, 'gh', '[pousr]_', '[A-Za-z0-9]{20,}', credentialTokenEndBoundary].join(''),
      'u',
    ),
  },
  {
    id: 'aws-access-key',
    expression: new RegExp(
      [credentialTokenBoundary, '(?:AK', 'IA|AS', 'IA)', '[A-Z0-9]{16}', credentialTokenEndBoundary].join(''),
      'u',
    ),
  },
  {
    id: 'slack-token',
    expression: new RegExp(
      [credentialTokenBoundary, 'xox', '[baprs]-', '[A-Za-z0-9-]{20,}', credentialTokenEndBoundary].join(''),
      'u',
    ),
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

function historicalCredentialChanges(cwd = repositoryRoot) {
  const historyExpression = [
    '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    '(^|[^[:alnum:]_-])sk-(proj-)?[A-Za-z0-9_-]{20,}([^[:alnum:]_-]|$)',
    '(^|[^[:alnum:]_-])(sk|rk)_live_[A-Za-z0-9]{16,}([^[:alnum:]_-]|$)',
    '(^|[^[:alnum:]_-])gh[pousr]_[A-Za-z0-9]{20,}([^[:alnum:]_-]|$)',
    '(^|[^[:alnum:]_-])(AKIA|ASIA)[A-Z0-9]{16}([^[:alnum:]_-]|$)',
    '(^|[^[:alnum:]_-])xox[baprs]-[A-Za-z0-9-]{20,}([^[:alnum:]_-]|$)',
  ].join('|')
  return execFileSync(
    'git',
    [
      'log',
      '--all',
      '--no-renames',
      '-G',
      `(${historyExpression})`,
      '--format=COMMIT %H',
      '--name-only',
      '--',
      '.',
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  ).trim()
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

test('published history contains no high-confidence credential additions or removals', () => {
  assert.equal(historicalCredentialChanges(), '')
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

test('credential matching respects lexical boundaries without weakening token detection', () => {
  const syntheticKey = ['sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1'].join('')
  const harmlessFilename = ['front-desk-', 'A1b2C3d4E5f6G7h8I9j0K1', '.pdf'].join('')

  assert.deepEqual(scanContent('fixture.txt', harmlessFilename), [])

  for (const surroundingText of [
    syntheticKey,
    `"${syntheticKey}"`,
    `https://example.test/?token=${syntheticKey}&next=1`,
    `before,${syntheticKey}!\nafter`,
  ]) {
    assert.deepEqual(scanContent('fixture.txt', surroundingText), [
      { path: 'fixture.txt', pattern: 'openai-api-key' },
    ])
  }
})

test('actual Git history scanner detects added and removed canaries with token boundaries', async () => {
  // Retained disposable repository; no production history or account is touched.
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'torchiko-secret-history-'))
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot, encoding: 'utf8', windowsHide: true,
  }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Disposable scanner fixture')
  git('config', 'user.email', 'scanner@example.test')
  const commit = (message) => {
    git('add', '.')
    git('-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  await writeFile(path.join(fixtureRoot, 'harmless.txt'), ['front-desk-', 'A1b2C3d4E5f6G7h8I9j0K1', '.pdf'].join(''))
  commit('Harmless embedded filename')
  assert.equal(historicalCredentialChanges(fixtureRoot), '')
  const canaries = [
    ['sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1'].join(''),
    ['sk-', 'ant-', 'A1b2C3d4E5f6G7h8I9j0K1'].join(''),
    ['sk', '_live_', 'A1b2C3d4E5f6G7h8'].join(''),
    ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1'].join(''),
    ['AK', 'IA', 'A1B2C3D4E5F6G7H8'].join(''),
    ['AS', 'IA', 'A1B2C3D4E5F6G7H8'].join(''),
    ['xox', 'b-', 'A1b2C3d4E5f6G7h8I9j0-K1'].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  ]
  for (const [index, canary] of canaries.entries()) {
    const filename = `canary-${index}.txt`
    await writeFile(path.join(fixtureRoot, filename), `https://example.test/?token=${canary}&next=1\n`)
    const added = commit(`Add synthetic canary ${index}`)
    await writeFile(path.join(fixtureRoot, filename), 'Removed synthetic fixture value\n')
    const removed = commit(`Remove synthetic canary ${index}`)
    const findings = historicalCredentialChanges(fixtureRoot)
    assert.ok(findings.includes(`COMMIT ${added}`), `Addition detected for canary ${index}`)
    assert.ok(findings.includes(`COMMIT ${removed}`), `Removal detected for canary ${index}`)
    assert.ok(findings.includes(filename))
    assert.equal(findings.includes(canary), false)
    assert.equal(findings.includes('harmless.txt'), false)
  }
})
