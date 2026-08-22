import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { validateReleaseSha, verifyStagingHealth } from './staging-health-admission.mjs'

const PROFILES = new Set(['static', 'candidate', 'staging'])

const staticGates = [
  ['staging-config', ['node', 'scripts/verify-staging-config.mjs']],
  ['public-surfaces', ['node', 'scripts/verify-public-surface-boundary.mjs']],
  ['ai-provider-boundary', ['node', 'scripts/verify-ai-provider-boundary.mjs']],
  ['ai-budget-boundary', ['node', 'scripts/verify-ai-budget-boundary.mjs']],
  ['raw-sql-boundary', ['node', 'scripts/verify-raw-sql-boundary.mjs']],
  ['tenant-bypass-boundary', ['node', 'scripts/verify-tenant-bypass-boundary.mjs']],
  ['tenant-procedure-coverage', ['node', 'scripts/verify-tenant-procedure-coverage.mjs']],
  ['tenant-registry', ['node', 'scripts/verify-tenant-registry.mjs']],
  ['docker-context', ['node', 'scripts/verify-docker-context-boundary.mjs']],
  ['character-assets', ['node', 'scripts/verify-character-assets.mjs']],
  ['agent-tool-coverage', ['node', 'scripts/torchiko.mjs', 'tools', 'coverage', '--json']],
  ['agent-scenarios', ['node', 'scripts/torchiko.mjs', 'scenarios', 'validate', '--json']],
]

const candidateGates = [
  ['typecheck', ['pnpm', 'typecheck']],
  ['lint', ['pnpm', 'lint']],
  ['test', ['pnpm', 'test']],
  ['build', ['pnpm', 'build']],
  ['client-bundle-secrets', ['pnpm', 'verify:client-bundles']],
  ['browser-foundation', ['pnpm', 'test:browser-foundation']],
  ['accessibility', ['pnpm', 'test:accessibility']],
]

function fail(code) {
  throw new Error(code)
}

function normalizeReportPath(root, value, revision, profile) {
  const target = value ?? `artifacts/release-verification/${revision}-${profile}.json`
  const resolved = path.resolve(root, target)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe-report-path')
  if (path.extname(resolved) !== '.json') fail('report-must-be-json')
  return resolved
}

export function parseReleaseVerificationArgs(args) {
  const allowed = new Set(['--profile', '--revision', '--report'])
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const profile = values.get('--profile') ?? 'static'
  if (!PROFILES.has(profile)) fail('invalid-profile')
  if (profile === 'staging' && !values.has('--revision')) fail('staging-revision-required')
  return { profile, revision: values.get('--revision'), report: values.get('--report') }
}

export function buildReleaseGates(profile) {
  if (!PROFILES.has(profile)) fail('invalid-profile')
  if (profile === 'static' || profile === 'staging') return staticGates
  return [...staticGates, ...candidateGates]
}

export function defaultCommandRunner(command, args, { cwd }) {
  let executable = command
  let executableArgs = args
  if (command === 'pnpm' && process.platform === 'win32') {
    const pnpmEntry = process.env.npm_execpath
    if (!pnpmEntry || !/pnpm(?:\.c?js)?$/iu.test(pnpmEntry)) return Promise.resolve({ code: 1 })
    executable = process.execPath
    executableArgs = [pnpmEntry, ...args]
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, executableArgs, { cwd, shell: false, stdio: 'inherit' })
      child.once('error', () => resolve({ code: 1 }))
      child.once('exit', (code, signal) => resolve({ code: signal ? 1 : (code ?? 1) }))
    } catch {
      resolve({ code: 1 })
    }
  })
}

async function readPolicy(root) {
  const source = await readFile(path.join(root, 'scripts/release-verification-policy.json'), 'utf8')
  const policy = JSON.parse(source)
  if (policy.schemaVersion !== 1) fail('unsupported-policy-version')
  return policy
}

function markdownReport(report) {
  const rows = report.gates
    .map((gate) => `| ${gate.id} | ${gate.status} | ${gate.durationMs} |`)
    .join('\n')
  return `# Torchiko release assessment\n\n- Revision: \`${report.revision}\`\n- Profile: \`${report.profile}\`\n- Readiness: **${report.readiness}**\n- Worktree: ${report.repository.clean ? 'clean' : 'dirty'}\n- Passed: ${report.summary.passed}; failed: ${report.summary.failed}; blocked: ${report.summary.blocked}\n\n| Gate | Result | Duration (ms) |\n| --- | --- | ---: |\n${rows}\n\n## Known limits\n\n${report.limitations.map((item) => `- ${item}`).join('\n')}\n\n## Rollback\n\n- Application: ${report.rollback.application}\n- Database: ${report.rollback.database}\n- Runbook: \`${report.rollback.runbook}\`\n`
}

export async function runReleaseVerification({
  root,
  profile,
  requestedRevision,
  reportPath,
  commandRunner = defaultCommandRunner,
  repositoryState,
  stagingVerifier = verifyStagingHealth,
  now = () => new Date(),
}) {
  const policy = await readPolicy(root)
  const state = await repositoryState()
  validateReleaseSha(state.revision)
  if (requestedRevision !== undefined) {
    validateReleaseSha(requestedRevision)
    if (requestedRevision !== state.revision) fail('revision-does-not-match-head')
  }
  const revision = requestedRevision ?? state.revision
  const gates = []

  gates.push({
    id: 'clean-worktree',
    status: state.clean ? 'pass' : 'fail',
    durationMs: 0,
  })

  for (const [id, [command, ...args]] of buildReleaseGates(profile)) {
    const started = Date.now()
    const result = await commandRunner(command, args, { cwd: root })
    gates.push({
      id,
      status: result.code === 0 ? 'pass' : 'fail',
      durationMs: Date.now() - started,
    })
    if (result.code !== 0) break
  }

  if (profile === 'staging' && gates.every((gate) => gate.status === 'pass')) {
    const started = Date.now()
    try {
      await stagingVerifier({
        healthUrl: policy.staging.healthUrl,
        expectedRevision: revision,
        confirmEnvironment: 'staging',
        confirmHost: policy.staging.host,
        expectedResources: policy.staging.resources,
      })
      gates.push({ id: 'exact-staging-health', status: 'pass', durationMs: Date.now() - started })
    } catch {
      gates.push({
        id: 'exact-staging-health',
        status: 'blocked',
        durationMs: Date.now() - started,
      })
    }
  }

  const summary = {
    passed: gates.filter((gate) => gate.status === 'pass').length,
    failed: gates.filter((gate) => gate.status === 'fail').length,
    blocked: gates.filter((gate) => gate.status === 'blocked').length,
  }
  const successful = summary.failed === 0 && summary.blocked === 0
  const readiness = successful
    ? profile === 'static'
      ? 'static-preflight-passed'
      : profile === 'candidate'
        ? 'ready-for-staging-review'
        : 'exact-staging-revision-healthy'
    : 'not-ready'
  const limitations = [
    'No profile authorizes production deployment, production migration, customer contact, or live billing.',
    profile === 'staging'
      ? 'Staging health proves exact revision, database and queue identity; provider, browser, OAuth, billing sandbox and customer-flow proof remain separate evidence.'
      : 'Local checks do not prove hosted services, provider credentials, OAuth, billing sandbox, mail delivery or production behavior.',
    'Founder review remains required for consequential production rollout under current policy.',
  ]
  const report = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    revision,
    profile,
    readiness,
    repository: { clean: state.clean },
    summary,
    gates,
    limitations,
    rollback: policy.rollback,
  }
  const jsonPath = normalizeReportPath(root, reportPath, revision, profile)
  const markdownPath = jsonPath.replace(/\.json$/u, '.md')
  await mkdir(path.dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' })
  await writeFile(markdownPath, markdownReport(report), { flag: 'w' })
  return { report, jsonPath, markdownPath }
}
