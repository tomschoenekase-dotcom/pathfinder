import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

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

for (const service of services) {
  const configPath = resolve(root, service.config)
  const config = JSON.parse(await readFile(configPath, 'utf8'))

  if (config.build?.builder !== 'DOCKERFILE') {
    throw new Error(`${service.config}: build.builder must be DOCKERFILE`)
  }

  if (config.build?.dockerfilePath !== service.dockerfile) {
    throw new Error(`${service.config}: expected dockerfilePath=${service.dockerfile}`)
  }

  await access(resolve(root, service.dockerfile))

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

console.log(`Verified ${services.length} staging service configurations.`)
