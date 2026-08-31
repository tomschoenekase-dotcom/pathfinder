import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { EXPECTED as expectedMigration } from './run-staging-migration-predeploy.mjs'
import { RAILWAY_STATUS_COMMAND } from './lib/railway-cli-contract.mjs'
import {
  STAGING_MIGRATION_APPROVAL_VARIABLE,
  buildStagingPredeployServiceContract,
} from './lib/staging-predeploy-service-contract.mjs'

const root = resolve(import.meta.dirname, '..')
const runbook = await readFile(resolve(root, 'docs/railway-staging.md'), 'utf8')
const predeployServiceContract = buildStagingPredeployServiceContract(expectedMigration.approval)

const services = [
  {
    name: 'web',
    config: 'railway.staging.web.json',
    dockerfile: 'Dockerfile.web.staging',
    healthcheckPath: '/api/health',
    preDeployCommand: ['node /migration/scripts/run-staging-migration-predeploy.mjs'],
  },
  {
    name: 'dashboard',
    config: 'railway.staging.dashboard.json',
    dockerfile: 'Dockerfile',
  },
  {
    name: 'workers',
    config: 'railway.staging.workers.json',
    dockerfile: 'Dockerfile.workers',
  },
]

const compatibilityConfigs = [
  'railway.json',
  'apps/dashboard/railway.json',
  'nixpacks.toml',
  'railway.web.json',
  'railway.workers.json',
]

for (const config of compatibilityConfigs) {
  await access(resolve(root, config))
  if (!runbook.includes(`\`${config}\``)) {
    throw new Error(`docs/railway-staging.md: missing compatibility ownership for ${config}`)
  }
}

if (
  !runbook.includes('are **not staging configuration**') ||
  !runbook.includes('Production remains untouched.') ||
  !runbook.includes('`staging-web`, `staging-dashboard`, and `staging-workers`')
) {
  throw new Error('docs/railway-staging.md: compatibility boundary is incomplete')
}

if (
  !runbook.includes(
    `${RAILWAY_STATUS_COMMAND} | pnpm verify:staging-topology --expected-revision`,
  ) ||
  runbook.includes('verify:staging-topology -- --expected-revision') ||
  !runbook.includes('without a running web,')
) {
  throw new Error('docs/railway-staging.md: three-service topology admission is incomplete')
}

if (
  !runbook.includes('pnpm verify:staging-runtime --web-deployment') ||
  runbook.includes('verify:staging-runtime -- --web-deployment') ||
  !runbook.includes('both the deployment ID and its exact staging') ||
  !runbook.includes('checks the provider process exit status')
) {
  throw new Error('docs/railway-staging.md: bounded runtime-log audit is incomplete')
}

for (const service of services) {
  const configPath = resolve(root, service.config)
  const config = JSON.parse(await readFile(configPath, 'utf8'))

  if (config.build?.builder !== 'DOCKERFILE') {
    throw new Error(`${service.config}: build.builder must be DOCKERFILE`)
  }

  if (config.build?.dockerfilePath !== service.dockerfile) {
    throw new Error(`${service.config}: expected dockerfilePath=${service.dockerfile}`)
  }

  const dockerfilePath = resolve(root, service.dockerfile)
  await access(dockerfilePath)

  if (service.name === 'web') {
    const dockerfile = await readFile(dockerfilePath, 'utf8')
    const builderStart = dockerfile.indexOf('FROM base AS builder')
    const runnerStart = dockerfile.indexOf('FROM base AS runner')
    const builderStage = dockerfile.slice(builderStart, runnerStart)

    if (
      builderStart < 0 ||
      runnerStart <= builderStart ||
      !builderStage.includes('ARG NEXT_PUBLIC_WEB_URL') ||
      builderStage.indexOf('ARG NEXT_PUBLIC_WEB_URL') >
        builderStage.indexOf('RUN pnpm --filter @pathfinder/web build')
    ) {
      throw new Error(
        `${service.dockerfile}: NEXT_PUBLIC_WEB_URL must be declared in the builder stage before the web build`,
      )
    }

    const approval = `ENV ${STAGING_MIGRATION_APPROVAL_VARIABLE}=${expectedMigration.approval}`
    if (!dockerfile.includes(approval)) {
      throw new Error(`${service.dockerfile}: staging migration approval is stale`)
    }
    if (
      !runbook.includes(`${STAGING_MIGRATION_APPROVAL_VARIABLE}=${expectedMigration.approval}`) ||
      !runbook.includes('does not inherit Docker image `ENV`')
    ) {
      throw new Error('docs/railway-staging.md: service-level migration approval is stale')
    }
  }

  if (
    service.healthcheckPath !== undefined &&
    config.deploy?.healthcheckPath !== service.healthcheckPath
  ) {
    throw new Error(`${service.config}: expected healthcheckPath=${service.healthcheckPath}`)
  }

  if (
    service.preDeployCommand !== undefined &&
    JSON.stringify(config.deploy?.preDeployCommand) !== JSON.stringify(service.preDeployCommand)
  ) {
    throw new Error(`${service.config}: unexpected preDeployCommand`)
  }

  if (config.deploy?.restartPolicyType !== 'ON_FAILURE') {
    throw new Error(`${service.config}: restartPolicyType must be ON_FAILURE`)
  }
}

console.log(
  `Verified ${services.length} staging service configurations, ${compatibilityConfigs.length} non-staging compatibility inputs, and the ${predeployServiceContract.service} pre-deploy service-variable contract.`,
)
