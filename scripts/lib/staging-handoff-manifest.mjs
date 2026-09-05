import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { EXPECTED as expectedMigration } from '../run-staging-migration-predeploy.mjs'
import { STAGING_LOCAL_UPLOAD_APPROVAL } from './staging-migration-admission.mjs'
import { REVIEWED_LOCAL_UPLOAD_APPROVAL } from './staging-topology-admission.mjs'
import { RAILWAY_STATUS_COMMAND } from './railway-cli-contract.mjs'
import { buildStagingPredeployServiceContract } from './staging-predeploy-service-contract.mjs'

const execFileAsync = promisify(execFile)
const FULL_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const OWNER_REVISION = '<owner-staging-revision>'

function fail(code) {
  throw new Error(code)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeJsonPath(root, value, fallback) {
  const resolved = path.resolve(root, value ?? fallback)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe-manifest-path')
  if (path.extname(resolved) !== '.json') fail('manifest-must-be-json')
  return resolved
}

export function parseStagingHandoffArgs(args) {
  const allowed = new Set(['--base-ref', '--candidate', '--release-report', '--report'])
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const releaseReport = values.get('--release-report')
  if (!releaseReport) fail('release-report-required')
  return {
    baseRef: values.get('--base-ref') ?? 'origin/codex/pathfinder-v2-staging',
    candidate: values.get('--candidate'),
    releaseReport,
    report: values.get('--report'),
  }
}

export function parseStagingHandoffFinalizeArgs(args) {
  const allowed = new Set(['--manifest', '--owner-revision', '--report'])
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const manifest = values.get('--manifest')
  const ownerRevision = values.get('--owner-revision')
  if (!manifest || !ownerRevision) fail('manifest-and-owner-revision-required')
  if (!FULL_SHA.test(ownerRevision)) fail('owner-revision-must-be-full-sha')
  return { manifest, ownerRevision, report: values.get('--report') }
}

export function validateFeatureFlagDefaults(source) {
  const matches = [
    ...source.matchAll(/environmentVariable:\s*'([^']+)'[\s\S]*?defaultEnabled:\s*(true|false)/gu),
  ].map((match) => ({ environmentVariable: match[1], defaultEnabled: match[2] === 'true' }))
  if (matches.length === 0) fail('feature-flag-contract-not-found')
  if (matches.some((item) => item.defaultEnabled)) fail('feature-flag-default-enabled')
  return matches.map((item) => item.environmentVariable).sort()
}

export function validateReleaseReport(report, candidate) {
  if (
    report?.schemaVersion !== 1 ||
    report.revision !== candidate ||
    report.profile !== 'candidate' ||
    report.readiness !== 'ready-for-staging-review' ||
    report.repository?.clean !== true ||
    report.summary?.failed !== 0 ||
    report.summary?.blocked !== 0 ||
    !Number.isInteger(report.summary?.passed) ||
    report.summary.passed < 1
  ) {
    fail('release-report-not-admissible')
  }
  return {
    profile: report.profile,
    readiness: report.readiness,
    passed: report.summary.passed,
    failed: report.summary.failed,
    blocked: report.summary.blocked,
  }
}

export function buildStagingHandoffManifest({
  baseRef,
  baseRevision,
  candidate,
  clean,
  baseIsAncestor,
  ahead,
  behind,
  delta,
  releaseReportPath,
  releaseReportSha256,
  releaseAssessment,
  migrations,
  staging,
  featureFlagEnvironmentVariables,
}) {
  if (!FULL_SHA.test(baseRevision) || !FULL_SHA.test(candidate)) fail('invalid-release-sha')
  if (!clean) fail('dirty-worktree')
  if (!baseIsAncestor || behind !== 0 || ahead < 1) fail('candidate-lineage-not-admissible')
  if (migrations.count < 1 || !migrations.latest || !SHA256.test(migrations.chainSha256)) {
    fail('migration-chain-not-admissible')
  }
  if (!SHA256.test(releaseReportSha256)) fail('invalid-release-report-hash')

  return {
    schemaVersion: 1,
    kind: 'torchiko-staging-handoff',
    base: { ref: baseRef, revision: baseRevision },
    candidate: { revision: candidate, clean: true },
    lineage: { baseIsAncestor: true, ahead, behind },
    delta,
    releaseVerification: {
      path: releaseReportPath,
      sha256: releaseReportSha256,
      ...releaseAssessment,
    },
    database: migrations,
    stagingTarget: staging,
    rolloutSafety: {
      featureFlagDefaultsDisabled: true,
      featureFlagEnvironmentVariables,
      productionDeploymentAuthorized: false,
      productionMigrationAuthorized: false,
      customerContactAuthorized: false,
      liveBillingAuthorized: false,
      valuableDataDestructionAuthorized: false,
      applicationReleaseIdentity: {
        variable: 'PATHFINDER_RELEASE_SHA',
        candidateRevision: candidate,
        deploymentValue: OWNER_REVISION,
        deploymentValueSource: 'ownerIntegration.resultingRevision',
        services: ['web', 'dashboard', 'workers'],
        mustResolveBeforeOwnerPush: true,
        mustMatchProviderRelease: true,
      },
      ownerIntegration: {
        candidateRevision: candidate,
        localIntegrationRequired: true,
        pushBeforePrerequisitesAuthorized: false,
        resultingRevision: OWNER_REVISION,
        resultingRevisionCommand: 'git rev-parse HEAD',
        resultingRevisionMustBeFullSha: true,
        candidateMustBeAncestorOfResult: true,
      },
      topologyAdmission: {
        input: RAILWAY_STATUS_COMMAND,
        command: `pnpm verify:staging-topology --expected-revision ${OWNER_REVISION}`,
        services: ['staging-web', 'staging-dashboard', 'staging-workers'],
        requiresSuccessfulDeployment: true,
        requiresRunningInstance: true,
      },
      reviewedLocalUploadFallback: {
        approvalService: 'staging-web',
        approvalVariable: {
          name: 'PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL',
          admittedValue: STAGING_LOCAL_UPLOAD_APPROVAL,
          closedValue: '',
        },
        exactCliMessages: {
          'staging-web': `Torchiko exact ${OWNER_REVISION} staging web`,
          'staging-dashboard': `Torchiko exact ${OWNER_REVISION} staging dashboard`,
          'staging-workers': `Torchiko exact ${OWNER_REVISION} staging workers`,
        },
        topologyAdmissionCommand:
          `pnpm verify:staging-topology --expected-revision ${OWNER_REVISION} ` +
          `--reviewed-local-upload ${REVIEWED_LOCAL_UPLOAD_APPROVAL}`,
        requiresCheckedInServiceConfig: true,
      },
      runtimeAudit: {
        deploymentIdentitySource: 'rolloutSafety.topologyAdmission',
        commandTemplate: `pnpm verify:staging-runtime --web-deployment <staging-web-deployment-id> --dashboard-deployment <staging-dashboard-deployment-id> --workers-deployment <staging-workers-deployment-id> --expected-revision ${OWNER_REVISION} --since 24h`,
        services: ['staging-web', 'staging-dashboard', 'staging-workers'],
        requiresProviderExitSuccess: true,
        rawLogsRetained: false,
      },
      stagingPredeployServiceEnvironment: {
        ...buildStagingPredeployServiceContract(expectedMigration.approval),
        releaseIdentityVariable: {
          name: 'PATHFINDER_RELEASE_SHA',
          value: OWNER_REVISION,
          valueSource: 'rolloutSafety.ownerIntegration.resultingRevision',
          requiredOnServices: ['web', 'dashboard', 'workers'],
        },
      },
      variableUpdateDeploymentPolicy: {
        suppressAutomaticDeploys: true,
        railwayCliFlag: '--skip-deploys',
        reason:
          'Stage every exact rollout prerequisite before deployment and close one-run gates without replacing the admitted revision.',
      },
    },
    admission: {
      status: 'ready-for-owner-staging-integration',
      requiredActions: [
        'Review and integrate this exact candidate into the local owner staging branch without pushing; resolve rolloutSafety.ownerIntegration.resultingRevision from the resulting owner HEAD and verify the candidate is its ancestor.',
        'Set PATHFINDER_RELEASE_SHA=<owner-staging-revision> on Railway web, dashboard, and workers with --skip-deploys before pushing the owner branch; it must match provider release metadata on every service and must not trigger a partial rollout.',
        'Set the exact checked-in PATHFINDER_STAGING_MIGRATION_APPROVAL as a Railway web service variable with --skip-deploys; image ENV alone does not reach pre-deploy.',
        'Set PATHFINDER_ALLOW_STAGING_MIGRATIONS=1 on Railway web with --skip-deploys immediately before pushing the prepared owner revision; the pre-deploy migration rejects a closed or missing one-run gate.',
        'If and only if provider Git metadata cannot be preserved and a reviewed local upload is required, set PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL to the exact checked-in admitted value on Railway web with --skip-deploys before upload, and use the exact per-service CLI messages in rolloutSafety.reviewedLocalUploadFallback.',
        'Push the prepared exact owner staging revision only after every required Railway variable is staged with --skip-deploys; require owner CI success before Railway releases waiting services, or use only the exact reviewed-local-upload fallback contract when provider Git metadata is unavailable. Railway must run the checked-in staging migration predeploy against preserved staging data before service startup.',
        'After successful migration, restore PATHFINDER_ALLOW_STAGING_MIGRATIONS=0 with --skip-deploys so closing the one-run gate does not replace the admitted active revision.',
        'After any reviewed local upload succeeds, blank PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL on Railway web with --skip-deploys and use rolloutSafety.reviewedLocalUploadFallback.topologyAdmissionCommand for admission.',
        'Run verify:release with the staging profile against that exact hosted revision.',
        `Pipe ${RAILWAY_STATUS_COMMAND} into verify:staging-topology for the exact hosted revision and retain only its bounded three-service result.`,
        'Run verify:staging-runtime with the exact deployment IDs emitted by verify:staging-topology; retain only its bounded counts and never treat a refused empty provider query as clean evidence.',
        'Record provider, OAuth, billing-test, browser, and customer-flow evidence separately where applicable.',
      ],
      retainedGates: [
        'No production deployment or production migration is authorized by this manifest.',
        'No customer contact, live billing, pricing, legal commitment, or valuable-data destruction is authorized.',
        'Current hosted staging is not admitted until its health endpoint reports the exact deployed revision.',
      ],
    },
  }
}

function replaceOwnerRevision(value, ownerRevision) {
  if (typeof value === 'string') return value.replaceAll(OWNER_REVISION, ownerRevision)
  if (Array.isArray(value)) return value.map((item) => replaceOwnerRevision(item, ownerRevision))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceOwnerRevision(item, ownerRevision)]),
    )
  }
  return value
}

export function finalizeStagingHandoffManifest({
  manifest,
  ownerRevision,
  currentRevision,
  currentBaseRevision,
  clean,
  candidateIsAncestorOfOwner,
  baseIsAncestorOfOwner,
}) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.kind !== 'torchiko-staging-handoff' ||
    manifest?.admission?.status !== 'ready-for-owner-staging-integration' ||
    !FULL_SHA.test(manifest?.base?.revision ?? '') ||
    !FULL_SHA.test(manifest?.candidate?.revision ?? '')
  ) {
    fail('handoff-manifest-not-admissible')
  }
  if (!FULL_SHA.test(ownerRevision) || ownerRevision === manifest.candidate.revision) {
    fail('owner-revision-not-admissible')
  }
  if (!clean) fail('owner-worktree-dirty')
  if (currentRevision !== ownerRevision) fail('owner-revision-not-current-head')
  if (currentBaseRevision !== manifest.base.revision) fail('owner-base-ref-advanced')
  if (!candidateIsAncestorOfOwner || !baseIsAncestorOfOwner) fail('owner-lineage-not-admissible')

  const source = JSON.stringify(manifest)
  if (!source.includes(OWNER_REVISION)) fail('owner-revision-placeholder-missing')
  const resolved = replaceOwnerRevision(manifest, ownerRevision)
  resolved.rolloutSafety.ownerIntegration.resultingRevisionResolved = true
  resolved.rolloutSafety.ownerIntegration.localHeadMatchesResult = true
  resolved.rolloutSafety.ownerIntegration.recordedBaseRefUnchanged = true
  resolved.rolloutSafety.ownerIntegration.worktreeClean = true
  resolved.rolloutSafety.ownerIntegration.candidateIsAncestorOfResult = true
  resolved.rolloutSafety.ownerIntegration.baseIsAncestorOfResult = true
  resolved.admission.status = 'ready-for-railway-prerequisite-staging'
  resolved.admission.ownerRevision = ownerRevision
  resolved.admission.completedActions = [
    `Verified clean local owner HEAD ${ownerRevision} while ${manifest.base.ref} still resolved to recorded base ${manifest.base.revision}; candidate ${manifest.candidate.revision} and recorded base ancestry confirmed.`,
  ]
  resolved.admission.requiredActions = resolved.admission.requiredActions.slice(1)
  if (JSON.stringify(resolved).includes(OWNER_REVISION)) fail('owner-revision-placeholder-retained')
  return resolved
}

async function git(root, args, allowExitOne = false) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout }
  } catch (error) {
    if (allowExitOne && error?.code === 1) return { code: 1, stdout: error.stdout ?? '' }
    fail('git-inspection-failed')
  }
}

async function inspectRepository(root, baseRef, requestedCandidate) {
  const candidate = (await git(root, ['rev-parse', requestedCandidate ?? 'HEAD'])).stdout.trim()
  const baseRevision = (await git(root, ['rev-parse', `${baseRef}^{commit}`])).stdout.trim()
  if (!FULL_SHA.test(candidate) || !FULL_SHA.test(baseRevision)) fail('invalid-release-sha')
  const status = (await git(root, ['status', '--short'])).stdout.trim()
  const ancestry = await git(root, ['merge-base', '--is-ancestor', baseRevision, candidate], true)
  const counts = (
    await git(root, ['rev-list', '--left-right', '--count', `${baseRevision}...${candidate}`])
  ).stdout
    .trim()
    .split(/\s+/u)
    .map(Number)
  const names = (await git(root, ['diff', '--name-only', '-z', baseRevision, candidate])).stdout
  const numstat = (await git(root, ['diff', '--numstat', baseRevision, candidate])).stdout
  const binaryDiff = (await git(root, ['diff', '--binary', baseRevision, candidate])).stdout
  const commits = (await git(root, ['log', '--format=%H', `${baseRevision}..${candidate}`])).stdout
  let additions = 0
  let deletions = 0
  for (const line of numstat.trim().split('\n')) {
    if (!line) continue
    const [added, deleted] = line.split('\t')
    if (added !== '-') additions += Number(added)
    if (deleted !== '-') deletions += Number(deleted)
  }
  return {
    baseRevision,
    candidate,
    clean: status === '',
    baseIsAncestor: ancestry.code === 0,
    behind: counts[0],
    ahead: counts[1],
    delta: {
      changedFiles: names === '' ? 0 : names.split('\0').filter(Boolean).length,
      additions,
      deletions,
      pathSetSha256: sha256(names),
      commitSetSha256: sha256(commits),
      patchSha256: sha256(binaryDiff),
    },
  }
}

async function inspectMigrations(root) {
  const migrationsRoot = path.join(root, 'packages/db/prisma/migrations')
  const entries = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const hash = createHash('sha256')
  for (const name of entries) {
    const relative = `packages/db/prisma/migrations/${name}/migration.sql`
    const content = await readFile(path.join(root, relative))
    hash.update(relative).update('\0').update(content).update('\0')
  }
  return { count: entries.length, latest: entries.at(-1), chainSha256: hash.digest('hex') }
}

export async function createStagingHandoffManifest({ root, options }) {
  const repository = await inspectRepository(root, options.baseRef, options.candidate)
  const releaseReportPath = safeJsonPath(root, options.releaseReport)
  const releaseReportSource = await readFile(releaseReportPath, 'utf8')
  const releaseAssessment = validateReleaseReport(
    JSON.parse(releaseReportSource),
    repository.candidate,
  )
  const policy = JSON.parse(
    await readFile(path.join(root, 'scripts/release-verification-policy.json'), 'utf8'),
  )
  if (policy.schemaVersion !== 1 || !policy.staging) fail('staging-policy-not-admissible')
  const featureFlagSource = await readFile(
    path.join(root, 'packages/config/src/feature-flags.ts'),
    'utf8',
  )
  const migrations = await inspectMigrations(root)
  const relativeReleaseReport = path.relative(root, releaseReportPath).replaceAll('\\', '/')
  const manifest = buildStagingHandoffManifest({
    baseRef: options.baseRef,
    ...repository,
    releaseReportPath: relativeReleaseReport,
    releaseReportSha256: sha256(releaseReportSource),
    releaseAssessment,
    migrations,
    staging: policy.staging,
    featureFlagEnvironmentVariables: validateFeatureFlagDefaults(featureFlagSource),
  })
  const outputPath = safeJsonPath(
    root,
    options.report,
    `artifacts/staging-handoff/${repository.candidate}.json`,
  )
  const source = `${JSON.stringify(manifest, null, 2)}\n`
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, source, { flag: 'w' })
  return { manifest, outputPath, sha256: sha256(source) }
}

export async function finalizeStagingHandoff({ root, options }) {
  const manifestPath = safeJsonPath(root, options.manifest)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const candidate = manifest?.candidate?.revision
  const baseRevision = manifest?.base?.revision
  if (!FULL_SHA.test(candidate ?? '') || !FULL_SHA.test(baseRevision ?? '')) {
    fail('handoff-manifest-not-admissible')
  }
  const [ownerResult, headResult, baseRefResult, statusResult] = await Promise.all([
    git(root, ['rev-parse', `${options.ownerRevision}^{commit}`]),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['rev-parse', `${manifest.base.ref}^{commit}`]),
    git(root, ['status', '--short']),
  ])
  const ownerRevision = ownerResult.stdout.trim()
  if (ownerRevision !== options.ownerRevision) fail('owner-revision-not-exact')
  const [candidateAncestry, baseAncestry] = await Promise.all([
    git(root, ['merge-base', '--is-ancestor', candidate, ownerRevision], true),
    git(root, ['merge-base', '--is-ancestor', baseRevision, ownerRevision], true),
  ])
  const resolved = finalizeStagingHandoffManifest({
    manifest,
    ownerRevision,
    currentRevision: headResult.stdout.trim(),
    currentBaseRevision: baseRefResult.stdout.trim(),
    clean: statusResult.stdout.trim() === '',
    candidateIsAncestorOfOwner: candidateAncestry.code === 0,
    baseIsAncestorOfOwner: baseAncestry.code === 0,
  })
  const outputPath = safeJsonPath(
    root,
    options.report,
    `artifacts/staging-handoff/${candidate}-to-${ownerRevision}.json`,
  )
  const source = `${JSON.stringify(resolved, null, 2)}\n`
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, source, { flag: 'w' })
  return { manifest: resolved, outputPath, sha256: sha256(source) }
}
