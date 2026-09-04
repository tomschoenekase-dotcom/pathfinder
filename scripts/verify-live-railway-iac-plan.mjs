import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditRailwayIacPlan,
  parseRailwayPlanJson,
  RailwayIacReadinessError,
} from './lib/railway-iac-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const railwayRoot = resolve(root, '.railway')
const requireFromRailway = createRequire(resolve(railwayRoot, 'package.json'))
const cliPackage = requireFromRailway.resolve('@railway/cli/package.json')
const cliExecutable = resolve(
  dirname(cliPackage),
  'bin',
  process.platform === 'win32' ? 'railway.exe' : 'railway',
)
const configs = {
  'staging-web': 'railway.staging.web.json',
  'staging-dashboard': 'railway.staging.dashboard.json',
  'staging-workers': 'railway.staging.workers.json',
}

try {
  const command = spawnSync(
    cliExecutable,
    ['config', 'plan', '--file', resolve(railwayRoot, 'railway.ts'), '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, _: cliExecutable },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  )
  if (command.error || command.status !== 0) {
    throw new RailwayIacReadinessError('railway-plan-command-failed')
  }

  const plan = parseRailwayPlanJson(command.stdout)
  const configByService = Object.fromEntries(
    await Promise.all(
      Object.entries(configs).map(async ([service, path]) => [
        service,
        JSON.parse(await readFile(resolve(root, path), 'utf8')),
      ]),
    ),
  )
  const result = auditRailwayIacPlan(plan, configByService)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.migrationPlanReady) process.exitCode = 2
} catch (error) {
  const code =
    error instanceof RailwayIacReadinessError
      ? error.code
      : 'unexpected-live-railway-iac-plan-failure'
  process.stderr.write(`Live Railway IaC plan verification failed: ${code}\n`)
  process.exitCode = 1
}
