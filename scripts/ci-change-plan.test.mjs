import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildPlan,
  forcedFullReason,
  parseNameStatusZ,
  planToOutputs,
  renderExplanation,
  safePlan,
} from './lib/ci-change-plan.mjs'
import { parseTurboFilters } from './lib/ci-turbo-filters.mjs'

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ci-change-plan.mjs')

// A miniature monorepo mirroring the real dependency shape.
function manifest(name, deps = []) {
  return JSON.stringify({
    name,
    dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])),
  })
}
const baseFiles = {
  'pnpm-workspace.yaml': "packages:\n  - '.railway'\n  - 'apps/*'\n  - 'packages/*'\n",
  'package.json': '{"name":"root"}',
  'pnpm-lock.yaml': 'lock',
  'CLAUDE.md': 'policy',
  'README.md': '# readme',
  'docs/architecture.md': '# arch',
  'docs/operator/manual.md': '# manual',
  'docs/pinned-by-script.md': '# pinned',
  'docs/guides/read-by-dashboard.md': '# guide',
  'docs/notes.png': 'png',
  '.github/workflows/ci.yml': 'name: CI',
  'scripts/pin.test.mjs': "readFileSync('docs/pinned-by-script.md')",
  'packages/config/package.json': manifest('@pathfinder/config'),
  'packages/config/src/logger.ts': 'export const logger = 1',
  'packages/contracts/package.json': manifest('@pathfinder/contracts', ['@pathfinder/config']),
  'packages/contracts/src/index.ts': 'export const c = 1',
  'packages/db/package.json': manifest('@pathfinder/db', ['@pathfinder/config']),
  'packages/db/src/index.ts': 'export const db = 1',
  'packages/db/prisma/schema.prisma': 'model A {}',
  'packages/db/prisma/migrations/001/migration.sql': 'select 1;',
  'packages/auth/package.json': manifest('@pathfinder/auth', ['@pathfinder/config']),
  'packages/auth/src/index.ts': 'export const a = 1',
  'packages/jobs/package.json': manifest('@pathfinder/jobs', ['@pathfinder/config']),
  'packages/jobs/src/queues.ts': 'export const q = 1',
  'packages/ui/package.json': manifest('@pathfinder/ui'),
  'packages/ui/src/button.tsx': 'export const B = 1',
  'packages/api/package.json': manifest('@pathfinder/api', [
    '@pathfinder/db',
    '@pathfinder/contracts',
    '@pathfinder/auth',
    '@pathfinder/config',
  ]),
  'packages/api/src/routers/place.ts': 'export const place = 1',
  'packages/api/src/manual.test.ts': "readFileSync('docs/operator/manual.md')",
  'apps/web/package.json': manifest('@pathfinder/web', ['@pathfinder/api', '@pathfinder/ui']),
  'apps/web/app/page.tsx': "import { place } from '@pathfinder/api'",
  'apps/dashboard/package.json': manifest('@pathfinder/dashboard', [
    '@pathfinder/api',
    '@pathfinder/ui',
  ]),
  'apps/dashboard/app/page.tsx': 'export default 1',
  'apps/dashboard/components/guide.test.tsx': "const f = 'docs/guides/read-by-dashboard.md'",
  'apps/workers/package.json': manifest('@pathfinder/workers', [
    '@pathfinder/db',
    '@pathfinder/jobs',
  ]),
  'apps/workers/src/index.ts': 'export const w = 1',
  // Undeclared coupling that only the import scan can see.
  'apps/web/lib/sneaky.ts': "import { c } from '../../../packages/contracts/src/index'",
  '.railway/package.json': manifest('@torchiko/railway-iac'),
  '.railway/README.md': 'iac',
}

function repoOf(files = baseFiles) {
  return { files: Object.keys(files), read: (file) => files[file] ?? null }
}
const PR = {
  event: 'pull_request',
  ref: 'refs/pull/9/merge',
  headRef: 'feature/x',
  baseRef: 'master',
}
const modified = (...files) => files.map((file) => ({ status: 'M', paths: [file] }))
const plan = (entries, options = {}) =>
  safePlan({ entries, repo: options.repo ?? repoOf(), context: options.context ?? PR })
const dirs = (result) => result.affected_workspaces.map((workspace) => workspace.dir).sort()

test('docs-only: unconsumed markdown skips every heavy gate but keeps the always-run checks', () => {
  const result = plan(modified('docs/architecture.md', 'docs/notes.png'))
  assert.equal(result.mode, 'docs-only')
  assert.deepEqual(result.turbo_filters, [])
  assert.equal(result.jobs.ci, true)
  assert.equal(result.jobs.railway_iac, true)
  assert.equal(result.jobs.database_integration, false)
  assert.equal(result.jobs.browser_gates, false)
  assert.equal(result.jobs.visitor_launch, false)
  assert.equal(result.jobs.workspace_graph, false)
})

test('docs consumed by script tests stay docs-only because repository script tests always run', () => {
  const result = plan(modified('docs/pinned-by-script.md'))
  assert.equal(result.mode, 'docs-only')
  assert.deepEqual(result.docs.consumers.scripts, ['scripts/pin.test.mjs'])
})

test('docs consumed at runtime or by package tests put the consumer and its dependents in scope', () => {
  const api = plan(modified('docs/operator/manual.md'))
  assert.equal(api.mode, 'scoped')
  assert.deepEqual(dirs(api), ['apps/dashboard', 'apps/web', 'packages/api'])
  const dashboard = plan(modified('docs/guides/read-by-dashboard.md'))
  assert.deepEqual(dirs(dashboard), ['apps/dashboard'])
  assert.equal(dashboard.jobs.browser_gates, true)
  assert.equal(dashboard.jobs.database_integration, false)
})

test('docs referenced from a directory-level read of docs/ are treated as consumed', () => {
  const files = { ...baseFiles, 'packages/ui/src/walk.ts': "join(root, 'docs', 'architecture.md')" }
  const result = plan(modified('docs/notes.png'), { repo: repoOf(files) })
  assert.equal(result.mode, 'scoped')
  assert.ok(dirs(result).includes('packages/ui'))
})

test('docs referenced by root or infrastructure files force FULL', () => {
  const files = { ...baseFiles, Dockerfile: 'COPY docs/architecture.md /app/' }
  const result = plan(modified('docs/architecture.md'), { repo: repoOf(files) })
  assert.equal(result.mode, 'full')
})

test('single app change stays scoped to that app and skips database integration', () => {
  const result = plan(modified('apps/dashboard/app/page.tsx'))
  assert.equal(result.mode, 'scoped')
  assert.deepEqual(dirs(result), ['apps/dashboard'])
  assert.deepEqual(result.turbo_filters, ['@pathfinder/dashboard'])
  assert.equal(result.jobs.database_integration, false)
  assert.equal(result.jobs.visitor_launch, true)
})

test('workers-only change needs database integration but no browser gates', () => {
  const result = plan(modified('apps/workers/src/index.ts'))
  assert.deepEqual(dirs(result), ['apps/workers'])
  assert.equal(result.jobs.database_integration, true)
  assert.equal(result.jobs.browser_gates, false)
  assert.equal(result.jobs.visitor_launch, false)
})

test('shared packages fan out to every transitive dependent', () => {
  assert.deepEqual(dirs(plan(modified('packages/api/src/routers/place.ts'))), [
    'apps/dashboard',
    'apps/web',
    'packages/api',
  ])
  assert.deepEqual(dirs(plan(modified('packages/db/src/index.ts'))), [
    'apps/dashboard',
    'apps/web',
    'apps/workers',
    'packages/api',
    'packages/db',
  ])
  const contracts = plan(modified('packages/contracts/src/index.ts'))
  assert.ok(
    ['packages/api', 'apps/web', 'apps/dashboard'].every((d) => dirs(contracts).includes(d)),
  )
  assert.equal(contracts.jobs.database_integration, true)
  assert.equal(contracts.jobs.browser_gates, true)
  assert.deepEqual(dirs(plan(modified('packages/ui/src/button.tsx'))), [
    'apps/dashboard',
    'apps/web',
    'packages/ui',
  ])
})

test('packages/config fans out to every workspace', () => {
  const result = plan(modified('packages/config/src/logger.ts'))
  assert.equal(result.mode, 'scoped')
  assert.equal(dirs(result).length, 11)
  assert.equal(result.jobs.database_integration, true)
  assert.equal(result.jobs.browser_gates, true)
})

test('undeclared cross-workspace relative imports still create a dependency edge', () => {
  const files = { ...baseFiles }
  delete files['apps/web/package.json']
  files['apps/web/package.json'] = manifest('@pathfinder/web')
  const result = plan(modified('packages/contracts/src/index.ts'), { repo: repoOf(files) })
  assert.ok(dirs(result).includes('apps/web'))
})

test('lockfile, root, workspace manifest, CI, policy, scripts and tooling changes are FULL', () => {
  for (const file of [
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'CLAUDE.md',
    '.github/workflows/ci.yml',
    'scripts/pin.test.mjs',
    'packages/web-unknown/package.json',
    'apps/web/package.json',
    '.railway/README.md',
    'Dockerfile.web',
    'turbo.json',
    'packages/auth/src/index.ts',
  ]) {
    assert.equal(plan(modified(file)).mode, 'full', file)
  }
})

test('migrations and the Prisma schema are FULL', () => {
  assert.equal(plan(modified('packages/db/prisma/schema.prisma')).mode, 'full')
  assert.equal(
    plan([{ status: 'A', paths: ['packages/db/prisma/migrations/002/migration.sql'] }]).mode,
    'full',
  )
})

test('unknown paths and unknown file types under docs are FULL', () => {
  assert.equal(plan(modified('mystery/dir/file.bin')).mode, 'full')
  assert.equal(plan(modified('docs/tool.exe')).mode, 'full')
  assert.equal(plan(modified('stray.sh')).mode, 'full')
})

test('one FULL path overrides an otherwise scoped change set', () => {
  assert.equal(plan(modified('apps/dashboard/app/page.tsx', 'pnpm-lock.yaml')).mode, 'full')
})

test('rename within one workspace stays scoped; rename across packages is FULL', () => {
  const within = plan([
    { status: 'R100', paths: ['apps/web/app/page.tsx', 'apps/web/app/home.tsx'] },
  ])
  assert.equal(within.mode, 'scoped')
  assert.deepEqual(dirs(within), ['apps/web'])
  const across = plan([
    { status: 'R090', paths: ['packages/ui/src/button.tsx', 'apps/web/components/button.tsx'] },
  ])
  assert.equal(across.mode, 'full')
  const intoDocs = plan([
    { status: 'R100', paths: ['apps/web/app/page.tsx', 'docs/architecture.md'] },
  ])
  assert.equal(intoDocs.mode, 'full')
})

test('copies and type changes are ambiguous and FULL', () => {
  assert.equal(plan([{ status: 'C100', paths: ['docs/a.md', 'docs/b.md'] }]).mode, 'full')
  assert.equal(plan([{ status: 'T', paths: ['apps/web/app/page.tsx'] }]).mode, 'full')
})

test('deleting a workspace file scopes to the owner and its dependents; deleting a policy file is FULL', () => {
  const removed = plan([{ status: 'D', paths: ['packages/ui/src/button.tsx'] }])
  assert.equal(removed.mode, 'scoped')
  assert.deepEqual(dirs(removed), ['apps/dashboard', 'apps/web', 'packages/ui'])
  assert.equal(plan([{ status: 'D', paths: ['.github/workflows/ci.yml'] }]).mode, 'full')
  const deletedDoc = plan([{ status: 'D', paths: ['docs/guides/read-by-dashboard.md'] }])
  assert.deepEqual(dirs(deletedDoc), ['apps/dashboard'])
})

test('forced FULL events and refs never use the selective path', () => {
  const entries = modified('docs/architecture.md')
  for (const context of [
    { event: 'merge_group', ref: 'refs/heads/gh-readonly-queue/x' },
    { event: 'workflow_dispatch', ref: 'refs/heads/feature/x' },
    { event: 'schedule', ref: 'refs/heads/master' },
    { event: 'push', ref: 'refs/heads/master' },
    { event: 'push', ref: 'refs/heads/codex/pathfinder-v2-staging' },
    {
      event: 'pull_request',
      ref: 'refs/pull/1/merge',
      headRef: 'codex/pathfinder-v2-staging',
      baseRef: 'master',
    },
    { event: 'pull_request', ref: 'refs/pull/1/merge', headRef: 'f', baseRef: 'release' },
    {},
  ]) {
    assert.equal(plan(entries, { context }).mode, 'full', JSON.stringify(context))
  }
  assert.equal(forcedFullReason({ event: 'push', ref: 'refs/heads/feature/x' }), null)
})

test('missing, empty, oversized or malformed change lists are FULL', () => {
  assert.equal(safePlan({ entries: undefined, repo: repoOf(), context: PR }).mode, 'full')
  assert.equal(plan([]).mode, 'full')
  const many = Array.from({ length: 1501 }, (_, index) => ({
    status: 'M',
    paths: [`docs/file-${index}.md`],
  }))
  assert.equal(plan(many).mode, 'full')
})

test('classifier crash degrades to FULL instead of throwing', () => {
  const crashing = {
    files: ['pnpm-workspace.yaml'],
    read: () => {
      throw new Error('boom')
    },
  }
  const result = safePlan({
    entries: modified('docs/architecture.md'),
    repo: crashing,
    context: PR,
  })
  assert.equal(result.mode, 'full')
  assert.match(result.reasons.join(' '), /classifier error: boom|fail-safe/u)
  assert.throws(() => buildPlan({ entries: modified('docs/a.md'), repo: crashing, context: PR }))
  const noWorkspaces = { files: [], read: () => null }
  assert.equal(
    safePlan({ entries: modified('docs/a.md'), repo: noWorkspaces, context: PR }).mode,
    'full',
  )
})

test('name-status parser rejects truncated, unknown and unsafe records', () => {
  assert.deepEqual(parseNameStatusZ(''), [])
  assert.deepEqual(parseNameStatusZ('M\0a/b.ts\0R100\0old.ts\0new.ts\0'), [
    { status: 'M', paths: ['a/b.ts'] },
    { status: 'R100', paths: ['old.ts', 'new.ts'] },
  ])
  assert.throws(() => parseNameStatusZ('M\0a/b.ts'), /truncated/u)
  assert.throws(() => parseNameStatusZ('R100\0old.ts\0'), /incomplete/u)
  assert.throws(() => parseNameStatusZ('U\0a.ts\0'), /unsupported/u)
  assert.throws(() => parseNameStatusZ('M\0../escape.ts\0'), /unsafe/u)
  assert.throws(() => parseNameStatusZ('M\0/abs.ts\0'), /unsafe/u)
})

test('outputs default every flag to true on FULL and expose validated turbo filters', () => {
  const full = planToOutputs(plan(modified('pnpm-lock.yaml')))
  assert.deepEqual(full, {
    mode: 'full',
    run_visitor_launch: 'true',
    run_database_integration: 'true',
    run_browser_gates: 'true',
    run_workspace_graph: 'true',
    turbo_filters: '',
  })
  const scoped = planToOutputs(plan(modified('apps/workers/src/index.ts')))
  assert.equal(scoped.turbo_filters, '--filter=@pathfinder/workers')
  assert.equal(scoped.run_database_integration, 'true')
  assert.equal(scoped.run_browser_gates, 'false')
  const hostile = {
    ...plan(modified('apps/workers/src/index.ts')),
    turbo_filters: ['@pathfinder/x --dangerous'],
  }
  assert.equal(planToOutputs(hostile).mode, 'full')
})

test('turbo filter parser accepts only exact workspace filters', () => {
  assert.deepEqual(parseTurboFilters('--filter=@pathfinder/api --filter=@pathfinder/db'), {
    filters: ['--filter=@pathfinder/api', '--filter=@pathfinder/db'],
    rejected: false,
  })
  assert.deepEqual(parseTurboFilters(''), { filters: [], rejected: false })
  assert.equal(parseTurboFilters('--filter=@a/b --force').rejected, true)
  assert.equal(parseTurboFilters('--filter=$(id)').rejected, true)
})

test('explanation names required and not-required gates', () => {
  const text = renderExplanation(plan(modified('docs/architecture.md')))
  assert.match(text, /DOCS-ONLY/u)
  assert.match(text, /visitor-launch job \| not required/u)
  assert.match(text, /does not count as release approval/u)
  assert.match(renderExplanation(plan(modified('pnpm-lock.yaml'))), /Every gate runs/u)
})

// ---- CLI against real temporary repositories -------------------------------------------------

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
  })
}
function sh(cwd, ...args) {
  const result = run('git', args, cwd)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function writeAll(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
}
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-plan-'))
  sh(root, 'init', '-q', '-b', 'master')
  sh(root, 'config', 'user.email', 'ci@example.invalid')
  sh(root, 'config', 'user.name', 'ci')
  sh(root, 'config', 'commit.gpgsign', 'false')
  writeAll(root, baseFiles)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'base')
  return root
}
function commit(root, files, message) {
  writeAll(root, files)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
  return sh(root, 'rev-parse', 'HEAD')
}
function plannedFor(root, options) {
  const outputFile = path.join(root, '..', `out-${path.basename(root)}.txt`)
  const jsonFile = path.join(root, '..', `plan-${path.basename(root)}.json`)
  writeFileSync(outputFile, '')
  const args = [
    cli,
    '--event',
    options.event ?? 'pull_request',
    '--ref',
    options.ref ?? 'refs/pull/1/merge',
    '--head-ref',
    options.headRef ?? 'feature/x',
    '--base-ref',
    options.baseRef ?? 'master',
    '--github-output',
    outputFile,
    '--json-out',
    jsonFile,
  ]
  if (options.baseSha) args.push('--base-sha', options.baseSha)
  const result = run(process.execPath, args, options.cwd ?? root)
  assert.equal(result.status, 0, result.stderr)
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/su).slice(0, 2)),
  )
  const parsed = JSON.parse(readFileSync(jsonFile, 'utf8'))
  rmSync(outputFile)
  rmSync(jsonFile)
  return { outputs, plan: parsed }
}

test('CLI: docs-only pull request diff against a real base is classified docs-only', () => {
  const root = makeRepo()
  try {
    const base = sh(root, 'rev-parse', 'HEAD')
    commit(root, { 'docs/architecture.md': '# changed' }, 'docs')
    const { outputs, plan: parsed } = plannedFor(root, { baseSha: base })
    assert.equal(parsed.mode, 'docs-only')
    assert.equal(outputs.run_browser_gates, 'false')
    assert.equal(outputs.mode, 'docs-only')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: the complete diff since the merge base is used, so earlier code commits are never hidden', () => {
  const root = makeRepo()
  try {
    const base = sh(root, 'rev-parse', 'HEAD')
    commit(root, { 'apps/workers/src/index.ts': 'export const w = 2' }, 'code')
    commit(root, { 'docs/architecture.md': '# changed' }, 'docs on top')
    const { plan: parsed } = plannedFor(root, { baseSha: base })
    assert.equal(parsed.mode, 'scoped')
    assert.deepEqual(parsed.turbo_filters, ['@pathfinder/workers'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: push on a development branch diffs against origin/master', () => {
  const root = makeRepo()
  try {
    sh(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD')
    sh(root, 'checkout', '-q', '-b', 'feature/x')
    commit(root, { 'packages/ui/src/button.tsx': 'export const B = 2' }, 'ui')
    const { plan: parsed } = plannedFor(root, { event: 'push', ref: 'refs/heads/feature/x' })
    assert.equal(parsed.mode, 'scoped')
    assert.ok(parsed.affected_workspaces.some((workspace) => workspace.dir === 'apps/web'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: missing base commit, absent default branch and bad arguments fail safe to FULL', () => {
  const root = makeRepo()
  try {
    commit(root, { 'docs/architecture.md': '# changed' }, 'docs')
    const missingBase = plannedFor(root, { baseSha: 'a'.repeat(40) })
    assert.equal(missingBase.plan.mode, 'full')
    assert.match(missingBase.plan.reasons.join(' '), /base commit is not present/u)
    const noRemote = plannedFor(root, { event: 'push', ref: 'refs/heads/feature/x' })
    assert.equal(noRemote.plan.mode, 'full')
    assert.match(noRemote.plan.reasons.join(' '), /default branch ref not fetched/u)
    const zero = plannedFor(root, { baseSha: '0'.repeat(40) })
    assert.equal(zero.plan.mode, 'full')
    const crash = run(process.execPath, [cli, '--bogus'], root, {
      GITHUB_OUTPUT: path.join(root, 'o.txt'),
    })
    assert.equal(crash.status, 0)
    assert.match(readFileSync(path.join(root, 'o.txt'), 'utf8'), /mode=full/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: shallow history cannot prove the merge base and is FULL', () => {
  const root = makeRepo()
  const clone = `${root}-clone`
  try {
    const base = sh(root, 'rev-parse', 'HEAD')
    commit(root, { 'docs/architecture.md': '# changed' }, 'docs')
    sh(root, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    const cloned = run('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], tmpdir())
    assert.equal(cloned.status, 0, cloned.stderr)
    const { plan: parsed } = plannedFor(clone, { baseSha: base })
    assert.equal(parsed.mode, 'full')
    assert.match(parsed.reasons.join(' '), /shallow history/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(clone, { recursive: true, force: true })
  }
})

test('CLI: protected refs and merge queues skip classification entirely', () => {
  const root = makeRepo()
  try {
    commit(root, { 'docs/architecture.md': '# changed' }, 'docs')
    for (const options of [
      { event: 'push', ref: 'refs/heads/master' },
      { event: 'merge_group', ref: 'refs/heads/gh-readonly-queue/master/pr-1' },
      { event: 'workflow_dispatch', ref: 'refs/heads/feature/x' },
      { event: 'pull_request', headRef: 'codex/pathfinder-v2-staging', baseSha: 'b'.repeat(40) },
    ]) {
      assert.equal(plannedFor(root, options).plan.mode, 'full', JSON.stringify(options))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
